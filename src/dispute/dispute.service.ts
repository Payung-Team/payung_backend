import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, PaymentStatusHistory } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../common/prisma.service';
import { SupabaseService } from '../common/supabase.service';
import { RefundService } from '../payment/refund.service';
import { PaymentStatusEnum } from '../payment/dto/payment.type';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { DisputeBooking, DisputePartyBrief } from './entities/dispute-booking.entity';
import { DisputeStatus } from './entities/dispute-status.enum';
import { DisputeDecision } from './entities/dispute-decision.enum';
import { AdminDisputesInput } from './dto/admin-disputes.input';
import {
  DisputeSummary,
  DisputeSummaryConnection,
} from './dto/dispute-summary.type';
import { DisputeFiledBy } from './entities/dispute-filed-by.enum';
import { DisputeSortBy } from './dto/dispute-sort.enum';
import {
  DISPUTE_SLA_HOURS,
  DISPUTE_FILED_BY,
  DISPUTE_AUDIT_ACTION,
} from './dispute.constants';
import {
  DisputeDetail,
  DisputeAuditLogEntry,
  DisputeEvidenceEntry,
} from './entities/dispute-detail.entity';
import { BOOKING_EVENTS, BookingEvent } from '../notification/events/booking-event';

// shape ที่ Prisma คืนจาก findUnique/findMany พร้อม include
type PrismaBookingWithRelations = {
  id: string;
  patientId: string;
  caregiverId: string | null;
  status: string;
  serviceType: string;
  timeSlot: string;
  locationAddress: string;
  bookingDate: Date;
  estimatedCost: { toNumber(): number } | null;
  disputeStatus: string;
  disputeReason: string | null;
  disputeResolvedAt: Date | null;
  disputeFiledAt: Date | null;
  disputeFiledBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  patient: { id: string; displayName: string | null; email: string };
  caregiver: {
    id: string;
    user: { id: string; displayName: string | null; email: string };
  } | null;
  payment: {
    id: string;
    amount: { toNumber(): number };
    currency: string;
    paymentStatus: string;
  } | null;
};

@Injectable()
export class DisputeService {
  private readonly logger = new Logger(DisputeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly refundService: RefundService,
    private readonly eventEmitter: EventEmitter2,
    private readonly supabaseService: SupabaseService,
  ) {}

  // ── 1. patient flag dispute ─────────────────────────────────────────────

  async flagBookingDispute(
    bookingId: string,
    reason: string,
    patientId: string,
  ): Promise<DisputeBooking> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        patientId: true,
        status: true,
        disputeStatus: true,
        caregiverId: true,
      },
    });

    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.patientId !== patientId) {
      throw new ForbiddenException('คุณไม่มีสิทธิ์ flag การจองนี้');
    }
    if (booking.status !== 'completed') {
      throw new UnprocessableEntityException(
        `เฉพาะการจองที่สำเร็จแล้ว (completed) เท่านั้นที่ flag ได้ — สถานะปัจจุบัน: "${booking.status}"`,
      );
    }
    if (booking.disputeStatus !== DisputeStatus.none) {
      throw new UnprocessableEntityException(
        `การจองนี้ถูก flag ไปแล้ว (dispute_status="${booking.disputeStatus}")`,
      );
    }
    // length ≥ 20 — เซฟไว้ทั้งฝั่ง DTO (class-validator) และ service (กัน edge ที่บายพาส)
    if (reason.trim().length < 20) {
      throw new BadRequestException(
        'reason ต้องมีความยาวอย่างน้อย 20 ตัวอักษร',
      );
    }

    await this.prisma.$transaction([
      this.prisma.booking.update({
        where: { id: bookingId },
        data: {
          disputeStatus: DisputeStatus.flagged,
          disputeReason: reason,
          // PYG-316: บันทึกเวลา + ผู้ยื่นตอน flag → ใช้คำนวณ SLA และ filter ใน admin queue
          disputeFiledAt: new Date(),
          disputeFiledBy: DISPUTE_FILED_BY.CUSTOMER, // ตอนนี้มีแต่ patient (customer) ที่ flag ได้
        },
      }),
      // audit trail: บันทึกทุก state change อัตโนมัติ — none → flagged
      this.prisma.disputeAuditLog.create({
        data: {
          bookingId,
          action: DISPUTE_AUDIT_ACTION.FILED,
          fromStatus: DisputeStatus.none,
          toStatus: DisputeStatus.flagged,
          actorId: patientId,
          actorRole: 'patient',
          note: reason,
        },
      }),
    ]);

    this.eventEmitter.emit(BOOKING_EVENTS.DISPUTE_CREATED, {
      bookingId,
      eventType: BOOKING_EVENTS.DISPUTE_CREATED,
      patientId,
      caregiverId: booking.caregiverId ?? null,
      metadata: { reason },
    } satisfies BookingEvent);

    return this.getDisputeBooking(bookingId);
  }

  // ── 2. admin paginated dispute queue ────────────────────────────────────

  async adminDisputes(
    input: AdminDisputesInput,
  ): Promise<DisputeSummaryConnection> {
    const page = Math.max(1, input.page ?? 1);
    const limit = Math.min(100, Math.max(1, input.limit ?? 20));
    const offset = (page - 1) * limit;

    // ── build WHERE จาก filter ต่าง ๆ ────────────────────────────────────
    const where: Prisma.BookingWhereInput = {};

    // status: ระบุมา → filter ตามนั้น; ไม่ระบุ → ทุก dispute (flagged + resolved, ยกเว้น 'none')
    where.disputeStatus = input.disputeStatus
      ? input.disputeStatus
      : { not: DisputeStatus.none };

    // filed_by: customer | caregiver
    if (input.filedBy) {
      where.disputeFiledBy = input.filedBy;
    }

    // date range บน filed_at (dispute_filed_at): date_from = ตั้งแต่, date_to = ถึง
    if (input.dateFrom || input.dateTo) {
      where.disputeFiledAt = {
        ...(input.dateFrom ? { gte: input.dateFrom } : {}),
        ...(input.dateTo ? { lte: input.dateTo } : {}),
      };
    }

    // search q: dispute/booking id (UUID) หรือ ชื่อ/อีเมล ของ patient/caregiver
    const q = input.q?.trim();
    if (q) {
      const or: Prisma.BookingWhereInput[] = [
        { patient: { displayName: { contains: q, mode: 'insensitive' } } },
        { patient: { email: { contains: q, mode: 'insensitive' } } },
        {
          caregiver: {
            user: { displayName: { contains: q, mode: 'insensitive' } },
          },
        },
        {
          caregiver: { user: { email: { contains: q, mode: 'insensitive' } } },
        },
      ];
      // id เป็น UUID column → LIKE ไม่ได้; ใส่ equals เฉพาะตอน q เป็น UUID ที่ถูกต้อง
      // (กัน Postgres error "invalid input syntax for type uuid")
      if (this.isUuid(q)) {
        or.push({ id: q });
      }
      where.OR = or;
    }

    // ── sort: default sla_asc (ด่วนสุด = filed เก่าสุดก่อน) ─────────────────
    // SLA = filed_at + ค่าคงที่ → เรียงตาม SLA = เรียงตาม filed_at
    const sortBy = input.sortBy ?? DisputeSortBy.sla_asc;
    const orderBy: Prisma.BookingOrderByWithRelationInput = {
      disputeFiledAt: sortBy === DisputeSortBy.sla_desc ? 'desc' : 'asc',
    };

    const [items, totalCount] = await Promise.all([
      this.prisma.booking.findMany({
        where,
        include: this.disputeInclude(),
        orderBy,
        skip: offset,
        take: limit,
      }),
      this.prisma.booking.count({ where }),
    ]);

    return {
      nodes: (items as unknown as PrismaBookingWithRelations[]).map((b) =>
        this.toSummary(b),
      ),
      totalCount,
      page,
      limit,
      hasNextPage: offset + limit < totalCount,
    };
  }

  // ── 3. admin resolve dispute ────────────────────────────────────────────

  async resolveDispute(
    bookingId: string,
    decision: DisputeDecision,
    refundAmount: number | undefined,
    notes: string,
    admin: AuthUser,
  ): Promise<DisputeBooking> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        disputeStatus: true,
        patientId: true,
        caregiverId: true,
        payment: { select: { id: true, amount: true } },
      },
    });

    if (!booking) throw new NotFoundException('Booking not found');
    // ticket spec เรียก pre-resolve state ว่า "open/under_review" — ในระบบนี้คือ flagged/under_review
    if (
      booking.disputeStatus !== DisputeStatus.flagged &&
      booking.disputeStatus !== DisputeStatus.under_review
    ) {
      throw new UnprocessableEntityException(
        `เฉพาะ dispute ที่อยู่สถานะ "flagged" หรือ "under_review" เท่านั้นที่ resolve ได้ — สถานะปัจจุบัน: "${booking.disputeStatus}"`,
      );
    }

    // refund flows ต้องมี payment row จริง
    if (decision !== DisputeDecision.no_refund) {
      if (!booking.payment) {
        throw new UnprocessableEntityException(
          'ไม่พบ payment ของ booking นี้ — refund ไม่ได้',
        );
      }
    }

    const reason = `dispute resolved: ${notes}`;

    // PYG-286: refundPayment ของจริง — รับ DTO + AuthUser (ไม่ใช่ 4 positional แบบ stub เดิม)
    // ส่วน guard amount/range PaymentService ตรวจให้อีกชั้น (defense in depth)
    if (decision === DisputeDecision.refund_full) {
      await this.refundService.refund({
        paymentId: booking.payment!.id,
        reason,
        source: 'dispute',
        actorId: admin.id,
      });
    } else if (decision === DisputeDecision.refund_partial) {
      if (refundAmount == null) {
        throw new BadRequestException(
          'refundAmount จำเป็นสำหรับ refund_partial',
        );
      }
      const fullAmount =
        typeof (booking.payment!.amount as any).toNumber === 'function'
          ? (booking.payment!.amount as any).toNumber()
          : Number(booking.payment!.amount);
      if (refundAmount <= 0 || refundAmount > fullAmount) {
        throw new BadRequestException(
          `refundAmount ต้องอยู่ในช่วง (0, ${fullAmount}] — ได้รับ ${refundAmount}`,
        );
      }
      await this.refundService.refund({
        paymentId: booking.payment!.id,
        amount: refundAmount,
        reason,
        source: 'dispute',
        actorId: admin.id,
      });
    }
    // no_refund → ไม่แตะ payment เลย

    await this.prisma.$transaction([
      this.prisma.booking.update({
        where: { id: bookingId },
        data: {
          disputeStatus: DisputeStatus.resolved,
          disputeResolvedAt: new Date(),
        },
      }),
      // audit trail: บันทึกทุก state change อัตโนมัติ — ใช้ actorId เป็นที่มาของ "resolvedBy"
      // (ไม่มี column disputeResolvedBy แยก — derive จาก audit row นี้แทน)
      this.prisma.disputeAuditLog.create({
        data: {
          bookingId,
          action: DISPUTE_AUDIT_ACTION.RESOLVED,
          fromStatus: booking.disputeStatus,
          toStatus: DisputeStatus.resolved,
          actorId: admin.id,
          actorRole: 'admin',
          note: notes,
          metadata: { decision, refundAmount: refundAmount ?? null },
        },
      }),
    ]);

    this.eventEmitter.emit(BOOKING_EVENTS.DISPUTE_RESOLVED, {
      bookingId,
      eventType: BOOKING_EVENTS.DISPUTE_RESOLVED,
      patientId: booking.patientId,
      caregiverId: booking.caregiverId ?? null,
      metadata: { decision, refundAmount, notes },
    } satisfies BookingEvent);

    return this.getDisputeBooking(bookingId);
  }

  // ── 4. admin dispute detail (parties, booking, payment history, evidence, notes, audit) ──

  async getDisputeDetail(bookingId: string): Promise<DisputeDetail> {
    const row = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: this.disputeInclude(),
    });
    if (!row) throw new NotFoundException('Booking not found');
    const booking = row as unknown as PrismaBookingWithRelations;

    const [paymentHistory, evidenceRows, auditRows] = await Promise.all([
      booking.payment
        ? this.prisma.paymentStatusHistory.findMany({
            where: { paymentId: booking.payment.id },
            orderBy: { createdAt: 'asc' },
          })
        : Promise.resolve<PaymentStatusHistory[]>([]),
      this.prisma.disputeEvidence.findMany({
        where: { bookingId },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.disputeAuditLog.findMany({
        where: { bookingId },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    // batch-resolve actor/uploader/changedBy ids → User briefs กัน N+1 query
    const actorIds = new Set<string>();
    auditRows.forEach((a) => a.actorId && actorIds.add(a.actorId));
    evidenceRows.forEach((e) => e.uploadedBy && actorIds.add(e.uploadedBy));
    paymentHistory.forEach((p) => p.changedBy && actorIds.add(p.changedBy));

    const actors = actorIds.size
      ? await this.prisma.user.findMany({
          where: { id: { in: [...actorIds] } },
          select: { id: true, displayName: true, email: true },
        })
      : [];
    const actorMap = new Map(actors.map((u) => [u.id, this.toPartyBrief(u)]));

    const signedEvidence = await this.attachSignedUrls(evidenceRows);
    const evidence: DisputeEvidenceEntry[] = signedEvidence.map((e) => ({
      id: e.id,
      fileUrl: e.fileUrl,
      fileName: e.fileName,
      fileSize: e.fileSize,
      mimeType: e.mimeType,
      note: e.note ?? undefined,
      uploadedBy: actorMap.get(e.uploadedBy),
      uploaderRole: e.uploaderRole,
      createdAt: e.createdAt,
    }));

    const audit: DisputeAuditLogEntry[] = auditRows.map((a) => ({
      id: a.id,
      action: a.action,
      fromStatus: a.fromStatus ?? undefined,
      toStatus: a.toStatus ?? undefined,
      actor: a.actorId ? actorMap.get(a.actorId) : undefined,
      actorRole: a.actorRole ?? undefined,
      note: a.note ?? undefined,
      metadata: (a.metadata as Record<string, unknown> | null) ?? undefined,
      createdAt: a.createdAt,
    }));

    const notes = audit.filter(
      (a) => a.action === DISPUTE_AUDIT_ACTION.NOTE_ADDED,
    );
    const resolvedEntry = audit.find(
      (a) => a.action === DISPUTE_AUDIT_ACTION.RESOLVED,
    );

    return {
      ...this.toGql(booking),
      resolvedBy: resolvedEntry?.actor,
      paymentHistory: paymentHistory.map((p) => ({
        id: p.id,
        fromStatus: p.fromStatus ?? undefined,
        toStatus: p.toStatus,
        changedBy: p.changedBy ? actorMap.get(p.changedBy) : undefined,
        reason: p.reason ?? undefined,
        metadata: (p.metadata as Record<string, unknown> | null) ?? undefined,
        createdAt: p.createdAt,
      })),
      evidence,
      notes,
      audit,
    };
  }

  // ── 5. admin add internal note (rides on dispute_audit_logs) ──────────────

  async addNote(
    bookingId: string,
    body: string,
    admin: AuthUser,
  ): Promise<DisputeAuditLogEntry> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true },
    });
    if (!booking) throw new NotFoundException('Booking not found');

    const entry = await this.prisma.disputeAuditLog.create({
      data: {
        bookingId,
        action: DISPUTE_AUDIT_ACTION.NOTE_ADDED,
        actorId: admin.id,
        actorRole: 'admin',
        note: body,
      },
    });

    return {
      id: entry.id,
      action: entry.action,
      fromStatus: entry.fromStatus ?? undefined,
      toStatus: entry.toStatus ?? undefined,
      actor: this.toPartyBrief({
        id: admin.id,
        displayName: null,
        email: admin.email,
      }),
      actorRole: entry.actorRole ?? undefined,
      note: entry.note ?? undefined,
      metadata: (entry.metadata as Record<string, unknown> | null) ?? undefined,
      createdAt: entry.createdAt,
    };
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private toPartyBrief(u: {
    id: string;
    displayName?: string | null;
    email: string;
  }): DisputePartyBrief {
    return { id: u.id, displayName: u.displayName ?? undefined, email: u.email };
  }

  /**
   * แนบ Supabase Storage signed URL (1 ชั่วโมง) ให้ evidence — pattern เดียวกับ
   * CaregiverService.getDocumentsWithSignedUrls (src/identity/kyc/caregiver.service.ts)
   * fallback กลับไปใช้ fileUrl เดิมถ้า sign ล้มเหลว (ไม่ให้ query พัง)
   */
  private async attachSignedUrls<T extends { fileUrl: string }>(
    rows: T[],
  ): Promise<T[]> {
    if (rows.length === 0) return rows;
    const supabase = this.supabaseService.getAdminClient();

    return Promise.all(
      rows.map(async (row) => {
        try {
          const storageSegment = row.fileUrl.split('/storage/v1/object/')[1];
          if (!storageSegment) return row;
          const withoutPublic = storageSegment.startsWith('public/')
            ? storageSegment.slice('public/'.length)
            : storageSegment;
          const slashIndex = withoutPublic.indexOf('/');
          if (slashIndex === -1) return row;
          const bucket = withoutPublic.slice(0, slashIndex);
          const objectPath = withoutPublic.slice(slashIndex + 1);

          const { data, error } = await supabase.storage
            .from(bucket)
            .createSignedUrl(objectPath, 3600); // 1 ชั่วโมง

          if (error || !data?.signedUrl) return row;
          return { ...row, fileUrl: data.signedUrl };
        } catch {
          return row;
        }
      }),
    );
  }

  // ── helpers (booking summary / mapping) ────────────────────────────────

  private disputeInclude() {
    return {
      patient: { select: { id: true, displayName: true, email: true } },
      caregiver: {
        select: {
          id: true,
          user: { select: { id: true, displayName: true, email: true } },
        },
      },
      payment: {
        select: { id: true, amount: true, currency: true, paymentStatus: true },
      },
    };
  }

  // PYG-316: sla_due_at = filed_at + DISPUTE_SLA_HOURS (undefined ถ้ายังไม่มี filed_at)
  private computeSlaDueAt(filedAt: Date | null): Date | undefined {
    if (!filedAt) return undefined;
    return new Date(filedAt.getTime() + DISPUTE_SLA_HOURS * 60 * 60 * 1000);
  }

  // ตรวจว่า string เป็น UUID หรือไม่ — กัน Postgres error ตอน filter id (uuid) ด้วยค่าที่ไม่ใช่ UUID
  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    );
  }

  // PYG-316: map booking row → DisputeSummary (1 แถวใน admin queue)
  private toSummary(b: PrismaBookingWithRelations): DisputeSummary {
    return {
      id: b.id,
      bookingId: b.id, // dispute id = booking id (dispute ผูกกับ booking 1:1)
      filedBy: (b.disputeFiledBy as DisputeFiledBy) ?? undefined,
      amount: b.payment ? b.payment.amount.toNumber() : undefined,
      currency: b.payment?.currency,
      status: b.disputeStatus as DisputeStatus,
      filedAt: b.disputeFiledAt ?? undefined,
      slaDueAt: this.computeSlaDueAt(b.disputeFiledAt),
      patient: {
        id: b.patient.id,
        displayName: b.patient.displayName ?? undefined,
        email: b.patient.email,
      },
      caregiver: b.caregiver
        ? {
            id: b.caregiver.user.id,
            displayName: b.caregiver.user.displayName ?? undefined,
            email: b.caregiver.user.email,
          }
        : undefined,
    };
  }

  private async getDisputeBooking(bookingId: string): Promise<DisputeBooking> {
    const row = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: this.disputeInclude(),
    });
    if (!row) throw new NotFoundException('Booking not found');
    return this.toGql(row as unknown as PrismaBookingWithRelations);
  }

  private toGql(b: PrismaBookingWithRelations): DisputeBooking {
    return {
      id: b.id,
      bookingDate:
        b.bookingDate instanceof Date
          ? b.bookingDate.toISOString().slice(0, 10)
          : String(b.bookingDate),
      status: b.status,
      serviceType: b.serviceType,
      timeSlot: b.timeSlot,
      locationAddress: b.locationAddress,
      estimatedCost:
        b.estimatedCost != null ? b.estimatedCost.toNumber() : undefined,
      disputeStatus: b.disputeStatus as DisputeStatus,
      disputeReason: b.disputeReason ?? undefined,
      disputeResolvedAt: b.disputeResolvedAt ?? undefined,
      patient: {
        id: b.patient.id,
        displayName: b.patient.displayName ?? undefined,
        email: b.patient.email,
      },
      caregiver: b.caregiver
        ? {
            id: b.caregiver.user.id,
            displayName: b.caregiver.user.displayName ?? undefined,
            email: b.caregiver.user.email,
          }
        : undefined,
      payment: b.payment
        ? {
            id: b.payment.id,
            amount: b.payment.amount.toNumber(),
            currency: b.payment.currency,
            paymentStatus: b.payment.paymentStatus as PaymentStatusEnum,
          }
        : undefined,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    };
  }
}
