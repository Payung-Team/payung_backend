import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { PaymentService } from '../payment/payment.service';
import { PaymentStatusEnum } from '../payment/dto/payment.type';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { DisputeBooking } from './entities/dispute-booking.entity';
import { DisputeStatus } from './entities/dispute-status.enum';
import { DisputeDecision } from './entities/dispute-decision.enum';
import { DisputeConnection } from './dto/dispute-connection.type';
import { AdminDisputesInput } from './dto/admin-disputes.input';

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
      throw new BadRequestException('reason ต้องมีความยาวอย่างน้อย 20 ตัวอักษร');
    }

    await this.prisma.booking.update({
      where: { id: bookingId },
      data: {
        disputeStatus: DisputeStatus.flagged,
        disputeReason: reason,
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

  async adminDisputes(input: AdminDisputesInput): Promise<DisputeConnection> {
    const page = Math.max(1, input.page ?? 1);
    const limit = Math.min(100, Math.max(1, input.limit ?? 20));
    const status = input.disputeStatus ?? DisputeStatus.flagged;
    const offset = (page - 1) * limit;

    const where = { disputeStatus: status };

    const [items, totalCount] = await Promise.all([
      this.prisma.booking.findMany({
        where,
        include: this.disputeInclude(),
        orderBy: { createdAt: 'asc' }, // FIFO — เก่าสุดก่อน
        skip: offset,
        take: limit,
      }),
      this.prisma.booking.count({ where }),
    ]);

    return {
      nodes: (items as unknown as PrismaBookingWithRelations[]).map((b) => this.toGql(b)),
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
        throw new BadRequestException('refundAmount จำเป็นสำหรับ refund_partial');
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
      estimatedCost: b.estimatedCost != null ? b.estimatedCost.toNumber() : undefined,
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
