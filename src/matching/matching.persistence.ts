import { bookingEvidenceReferenceDate } from './matching.policy';
import { time_slot } from '@prisma/client';
import {
  caregiverHasTimeConflict,
  lockCaregiverSchedule,
} from '../booking/caregiver-time-conflict';
import { overlappingSlots } from '../common/constants/time-slot.constant';
import { Prisma } from '@prisma/client';
import { GraphQLError } from 'graphql';
import { publicCaregiverConditions } from '../caregiver-public/caregiver-public.policy';
import { readSavedRequiredSkills } from '../booking/required-skills/required-skills.read';
import { LICENSE_DOC_TYPE } from '../identity/kyc/license/license.constants';
import { PROFESSION_CHANGE_ACTION } from '../identity/kyc/profession.constants';
import {
  assertMatchableBooking,
  BookingNotMatchableError,
  evaluateCaregiverMatch,
  MatchingBooking,
  MatchingCaregiver,
  MatchingEvidence,
} from './matching.evaluate';

type Tx = Prisma.TransactionClient;
export interface MatchCandidateRow extends MatchingCaregiver {
  id: string;
  userId: string;
  fullName: string;
}
export async function loadMatchingBooking(
  tx: Tx,
  bookingId: string,
): Promise<MatchingBooking> {
  // Raw SELECT preserves SQL NULL for Prisma scalar lists (NULL is not []).
  const rows = await tx.$queryRaw<
    {
      required_level: string | null;
      required_skills: string[] | null;
      level_calculated_at: Date | null;
    }[]
  >`
    SELECT required_level, required_skills, level_calculated_at FROM bookings WHERE id=${bookingId}`;
  const row = rows[0];
  if (!row || !row.level_calculated_at || row.required_skills === null)
    throw new BookingNotMatchableError();
  const skills = (await readSavedRequiredSkills(tx, [bookingId])).get(
    bookingId,
  );
  const result = {
    requiredLevel: row.required_level,
    requiredSkills:
      skills?.map(({ skill }) => {
        if (!skill.lockedProfessions) throw new BookingNotMatchableError();
        return { code: skill.code, lockedProfessions: skill.lockedProfessions };
      }) ?? null,
  };
  assertMatchableBooking(result);
  return result;
}
/** Bulk reads only. Exclude pending profession requests from the approved profession. */
export async function loadMatchCandidates(
  tx: Tx,
  referenceDate: Date,
  caregiverId?: string,
): Promise<MatchCandidateRow[]> {
  const conditions = publicCaregiverConditions();
  if (caregiverId) conditions.push(Prisma.sql`c.id=${caregiverId}`);
  const candidates = await tx.$queryRaw<
    {
      id: string;
      userId: string;
      fullName: string | null;
      careLevel: string | null;
      profession: string;
      skills: string[];
    }[]
  >(Prisma.sql`
    SELECT c.id,c.user_id AS "userId",c.full_name AS "fullName",c.care_level AS "careLevel",c.profession,c.skills
    FROM caregivers c WHERE ${Prisma.join(conditions, ' AND ')} ORDER BY c.created_at ASC,c.id ASC`);
  if (!candidates.length) return [];
  const ids = candidates.map((c) => c.id);
  const [documents, logs] = await Promise.all([
    tx.kycDocument.findMany({
      where: { caregiverId: { in: ids }, documentType: LICENSE_DOC_TYPE },
      select: {
        id: true,
        caregiverId: true,
        userId: true,
        reviewStatus: true,
        expiresAt: true,
        uploadedAt: true,
      },
      orderBy: [{ uploadedAt: 'desc' }, { id: 'desc' }],
    }),
    tx.caregiver_edit_logs.findMany({
      where: {
        caregiver_id: { in: ids },
        action: {
          in: [
            PROFESSION_CHANGE_ACTION.REQUEST,
            PROFESSION_CHANGE_ACTION.APPROVE,
          ],
        },
      },
      select: {
        caregiver_id: true,
        action: true,
        field_changes: true,
        created_at: true,
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    }),
  ]);
  return candidates.map((c) => {
    const docProfession = new Map<string, string>();
    let approvedProfessionAt: Date | null = null;
    for (const log of logs) {
      if (log.caregiver_id !== c.id || !Array.isArray(log.field_changes))
        continue;
      for (const entry of log.field_changes) {
        if (
          !entry ||
          typeof entry !== 'object' ||
          Array.isArray(entry) ||
          entry.field !== 'profession'
        )
          continue;
        if (
          log.action === PROFESSION_CHANGE_ACTION.REQUEST &&
          typeof entry.licenseDocumentId === 'string'
        )
          docProfession.set(
            entry.licenseDocumentId,
            typeof entry.newValue === 'string' ? entry.newValue : 'invalid',
          );
        if (
          log.action === PROFESSION_CHANGE_ACTION.APPROVE &&
          entry.newValue === c.profession &&
          (!approvedProfessionAt || log.created_at > approvedProfessionAt)
        )
          approvedProfessionAt = log.created_at;
      }
    }
    const scoped = documents.filter(
      (d) =>
        d.caregiverId === c.id &&
        d.userId === c.userId &&
        (docProfession.has(d.id)
          ? docProfession.get(d.id) === c.profession
          : !approvedProfessionAt || d.uploadedAt >= approvedProfessionAt),
    );
    // A pending renewal does not revoke an independently approved, valid license.
    const chosen =
      scoped.find(
        (d) =>
          d.reviewStatus === 'approved' &&
          d.expiresAt &&
          d.expiresAt > referenceDate,
      ) ??
      scoped.find(
        (d) => d.reviewStatus === 'approved' || d.reviewStatus === 'expired',
      ) ??
      scoped[0];
    const evidence: MatchingEvidence | null = chosen
      ? {
          profession: c.profession,
          status: chosen.reviewStatus,
          expiresAt: chosen.expiresAt,
        }
      : null;
    return { ...c, fullName: c.fullName ?? '', evidence };
  });
}
export class CaregiverNotEligibleError extends GraphQLError {
  constructor() {
    super('ผู้ดูแลรายนี้ไม่สามารถรับ booking นี้ได้ กรุณาเลือกใหม่', {
      extensions: { code: 'CAREGIVER_NOT_ELIGIBLE', statusCode: 422 },
    });
  }
}
/** Used by both selection and legacy create-with-caregiver in the caller's tx. */
export async function assertCaregiverEligible(
  tx: Tx,
  bookingId: string,
  caregiverId: string,
  referenceDate: Date,
): Promise<void> {
  // Prevent caregiver level/profession/skills edits from committing between check and assignment.
  await lockCaregiverSchedule(tx, caregiverId);
  // License review/expiry changes update these existing rows; pin them for this assignment.
  await tx.$queryRaw`SELECT id FROM kyc_documents WHERE caregiver_id=${caregiverId} AND doc_type=${LICENSE_DOC_TYPE} FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM caregiver_availability WHERE caregiver_id=${caregiverId} FOR SHARE`;
  const booking = await loadMatchingBooking(tx, bookingId);
  const candidates = await loadMatchCandidates(tx, referenceDate, caregiverId);
  if (
    !candidates[0] ||
    !evaluateCaregiverMatch(booking, candidates[0], referenceDate).passed
  )
    throw new CaregiverNotEligibleError();
}

/** Keep the existing weekly-slot and accepted-booking checks on the new selector. */
export async function assertSelectionSchedule(
  tx: Tx,
  bookingId: string,
  caregiverId: string,
): Promise<void> {
  const b = await tx.booking.findUniqueOrThrow({
    where: { id: bookingId },
    select: { bookingDate: true, startTime: true, durationHours: true },
  });
  const start = b.startTime.getUTCHours() * 60 + b.startTime.getUTCMinutes();
  const end = start + Math.round(Number(b.durationHours) * 60);
  const required = overlappingSlots(start, end);
  const slots = await tx.caregiverAvailability.findMany({
    where: {
      caregiverId,
      dayOfWeek: b.bookingDate.getUTCDay(),
      isActive: true,
      timeSlot: { in: required as time_slot[] },
    },
    select: { timeSlot: true },
  });
  if (
    !required.length ||
    !required.every((s) => slots.some((row) => row.timeSlot === s)) ||
    (await caregiverHasTimeConflict(tx, {
      caregiverId,
      bookingDate: b.bookingDate,
      startMinute: start,
      endMinute: end,
      excludeBookingId: bookingId,
    }))
  )
    throw new CaregiverNotEligibleError();
}

/** Reuse the same evaluator for booking-specific legacy recovery responses. */
export async function eligibleIdsForBooking(
  tx: Tx,
  bookingId: string,
): Promise<string[]> {
  const b = await tx.booking.findUniqueOrThrow({
    where: { id: bookingId },
    select: { bookingDate: true },
  });
  const referenceDate = bookingEvidenceReferenceDate(b.bookingDate);
  const booking = await loadMatchingBooking(tx, bookingId);
  return (await loadMatchCandidates(tx, referenceDate))
    .filter((c) => evaluateCaregiverMatch(booking, c, referenceDate).passed)
    .map((c) => c.id);
}
