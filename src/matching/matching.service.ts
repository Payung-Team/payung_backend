import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { GraphQLError } from 'graphql';
import { isUUID } from 'class-validator';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../common/prisma.service';
import { ClockService } from '../common/clock.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { ROLE_ID } from '../common/constants/roles.constant';
import { CaregiverProfession } from '../identity/kyc/profession.constants';
import { careLevelFromDb } from '../common/care-level/care-level';
import { lockRequiredSkillRecipient } from '../booking/required-skills/required-skills.persistence';
import {
  BOOKING_EVENTS,
  BookingEvent,
} from '../notification/events/booking-event';
import { SearchService } from '../search/search.service';
import { CaregiverSummary } from '../search/dto/search-caregiver.payload';
import {
  BookingCaregiverSelection,
  BookingMatchReport,
  EligibleCaregivers,
} from './matching.types';
import { evaluateCaregiverMatch } from './matching.evaluate';
import {
  assertCaregiverEligible,
  assertSelectionSchedule,
  loadMatchCandidates,
  loadMatchingBooking,
} from './matching.persistence';
import {
  bookingEvidenceReferenceDate,
  matchingAdminContact,
} from './matching.policy';
@Injectable()
export class MatchingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
    private readonly clock: ClockService,
    private readonly emitter: EventEmitter2,
  ) {}
  private async authorize(
    tx: Prisma.TransactionClient,
    bookingId: string,
    actor: AuthUser,
    write = false,
  ) {
    if (actor.role !== ROLE_ID.PATIENT)
      throw new ForbiddenException('Access denied');
    if (!isUUID(bookingId)) throw new NotFoundException('Booking not found');
    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        patientId: true,
        familyGroupId: true,
        careRecipientId: true,
        bookingDate: true,
        caregiverId: true,
        status: true,
        confirmedAt: true,
      },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.patientId !== actor.id) {
      if (
        write ||
        !booking.familyGroupId ||
        !(await tx.familyGroupMember.findFirst({
          where: {
            groupId: booking.familyGroupId,
            userId: actor.id,
            status: 'ACTIVE',
          },
          select: { id: true },
        }))
      )
        throw new ForbiddenException('Access denied');
    }
    return booking;
  }
  async eligibleCaregivers(
    bookingId: string,
    actor: AuthUser,
  ): Promise<EligibleCaregivers> {
    return this.prisma.$transaction(
      async (tx) => {
        const b = await this.authorize(tx, bookingId, actor);
        const booking = await loadMatchingBooking(tx, bookingId);
        const referenceDate = bookingEvidenceReferenceDate(b.bookingDate);
        const candidates = await loadMatchCandidates(tx, referenceDate);
        const ids = candidates
          .filter(
            (c) => evaluateCaregiverMatch(booking, c, referenceDate).passed,
          )
          .map((c) => c.id);
        const caregivers: CaregiverSummary[] = [];
        // Filter in SQL before the existing List pagination; never sign rejected avatars.
        if (ids.length) {
          let page = 1;
          while (true) {
            const result = await this.search.searchCaregivers(
              { page, limit: 50 },
              ids,
              tx,
            );
            caregivers.push(...result.data);
            if (page >= result.pagination.totalPages) break;
            page++;
          }
        }
        return {
          caregivers,
          emptyMessage: caregivers.length
            ? null
            : 'ยังไม่มีผู้ดูแลที่ตรงตามความต้องการ กรุณาติดต่อทีมงาน Payung',
          adminContact: caregivers.length ? null : matchingAdminContact(),
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: 15000,
      },
    );
  }
  async bookingMatchReport(
    bookingId: string,
    actor: AuthUser,
  ): Promise<BookingMatchReport> {
    if (actor.role !== ROLE_ID.ADMIN && actor.role !== ROLE_ID.SUPER_ADMIN)
      throw new ForbiddenException('Access denied');
    return this.prisma.$transaction(
      async (tx) => {
        if (!isUUID(bookingId))
          throw new NotFoundException('Booking not found');
        const b = await tx.booking.findUnique({
          where: { id: bookingId },
          select: { bookingDate: true },
        });
        if (!b) throw new NotFoundException('Booking not found');
        const booking = await loadMatchingBooking(tx, bookingId);
        const referenceDate = bookingEvidenceReferenceDate(b.bookingDate);
        const candidates = await loadMatchCandidates(tx, referenceDate);
        return {
          bookingId,
          evaluatedAt: this.clock.now(),
          evidenceReferenceDate: referenceDate,
          persisted: false,
          results: candidates.map((c) => ({
            caregiver: {
              id: c.id,
              fullName: c.fullName,
              profession: c.profession as CaregiverProfession,
              careLevel: careLevelFromDb(c.careLevel),
            },
            ...evaluateCaregiverMatch(booking, c, referenceDate),
          })),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async selectBookingCaregiver(
    bookingId: string,
    caregiverId: string,
    actor: AuthUser,
  ): Promise<BookingCaregiverSelection> {
    if (!isUUID(caregiverId))
      throw new NotFoundException('Caregiver not found');
    const result = await this.prisma.$transaction(async (tx) => {
      const initial = await this.authorize(tx, bookingId, actor, true);
      if (initial.careRecipientId)
        await lockRequiredSkillRecipient(tx, initial.careRecipientId);
      await tx.$queryRaw`SELECT id FROM bookings WHERE id=${bookingId} FOR UPDATE`;
      const b = await this.authorize(tx, bookingId, actor, true);
      if (b.confirmedAt || b.status !== 'unmatched' || b.caregiverId)
        throw new GraphQLError('Booking นี้ไม่อยู่ในสถานะที่เลือกผู้ดูแลได้', {
          extensions: { code: 'BOOKING_NOT_SELECTABLE', statusCode: 422 },
        });
      await assertCaregiverEligible(
        tx,
        bookingId,
        caregiverId,
        bookingEvidenceReferenceDate(b.bookingDate),
      );
      await assertSelectionSchedule(tx, bookingId, caregiverId);
      await tx.booking.update({
        where: { id: bookingId },
        data: { caregiverId, status: 'pending' },
      });
      const caregiver = await tx.caregiver.findUniqueOrThrow({
        where: { id: caregiverId },
        select: { userId: true },
      });
      return {
        bookingId,
        caregiverId,
        status: 'pending',
        patientId: b.patientId,
        caregiverUserId: caregiver.userId,
      };
    });
    // Existing creation listener notifies the assigned caregiver; unmatched creation skipped it.
    this.emitter.emit(BOOKING_EVENTS.CREATED, {
      eventType: BOOKING_EVENTS.CREATED,
      bookingId,
      patientId: result.patientId,
      caregiverId: result.caregiverUserId,
    } satisfies BookingEvent);
    return {
      bookingId: result.bookingId,
      caregiverId: result.caregiverId,
      status: result.status,
    };
  }
}
