import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { PaymentService } from '../payment/payment.service';
import { PaymentStatusEnum } from '../payment/dto/payment.type';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { DisputeBooking } from './entities/dispute-booking.entity';
import { DisputeStatus } from './entities/dispute-status.enum';
import { DisputeDecision } from './entities/dispute-decision.enum';
import { AdminDisputesInput } from './dto/admin-disputes.input';
import {
  DisputeSummary,
  DisputeSummaryConnection,
} from './dto/dispute-summary.type';
import { DisputeFiledBy } from './entities/dispute-filed-by.enum';
import { DisputeSortBy } from './dto/dispute-sort.enum';
import { DISPUTE_SLA_HOURS, DISPUTE_FILED_BY } from './dispute.constants';

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
    private readonly paymentService: PaymentService,
  ) {}

  // ── 1. patient flag dispute ─────────────────────────────────────────────

  async flagBookingDispute(
    bookingId: string,
    reason: string,
    patientId: string,
  ): Promise<DisputeBooking> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { patientId: true, status: true, disputeStatus: true },
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

    await this.prisma.booking.update({
      where: { id: bookingId },
      data: {
        disputeStatus: DisputeStatus.flagged,
        disputeReason: reason,
        // PYG-316: บันทึกเวลา + ผู้ยื่นตอน flag → ใช้คำนวณ SLA และ filter ใน admin queue
        disputeFiledAt: new Date(),
        disputeFiledBy: DISPUTE_FILED_BY.CUSTOMER, // ตอนนี้มีแต่ patient (customer) ที่ flag ได้
      },
    });

    // PYG-268 (EventEmitter) ยังไม่ wire → log JSON ตามแบบ PYG-282
    // TODO: PYG-268 — replace with EventEmitter2.emit('dispute.created', payload)
    this.logger.log(
      JSON.stringify({
        event: 'dispute.created',
        payload: { bookingId, patientId, reason },
      }),
    );

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
    if (booking.disputeStatus !== DisputeStatus.flagged) {
      throw new UnprocessableEntityException(
        `เฉพาะ dispute ที่อยู่สถานะ "flagged" เท่านั้นที่ resolve ได้ — สถานะปัจจุบัน: "${booking.disputeStatus}"`,
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
      await this.paymentService.refundPayment(
        { paymentId: booking.payment!.id, reason },
        admin,
      );
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
      await this.paymentService.refundPayment(
        { paymentId: booking.payment!.id, amount: refundAmount, reason },
        admin,
      );
    }
    // no_refund → ไม่แตะ payment เลย

    await this.prisma.booking.update({
      where: { id: bookingId },
      data: {
        disputeStatus: DisputeStatus.resolved,
        disputeResolvedAt: new Date(),
      },
    });

    // TODO: PYG-268 — replace with EventEmitter2.emit('dispute.resolved', payload)
    this.logger.log(
      JSON.stringify({
        event: 'dispute.resolved',
        payload: {
          bookingId,
          decision,
          notifyUserIds: [booking.patientId, booking.caregiverId].filter(
            (id): id is string => !!id,
          ),
        },
      }),
    );

    return this.getDisputeBooking(bookingId);
  }

  // ── helpers ─────────────────────────────────────────────────────────────

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
