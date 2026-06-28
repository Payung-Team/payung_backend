import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../common/prisma.service';
import { BOOKING_EVENTS } from '../notification/events/booking-event';
import { ROLE_ID } from '../common/constants/roles.constant';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { PaymentStatus } from './entities/payment-status.enum';
import { PaymentStatusHistory } from './entities/payment-status-history.entity';
import { PaymentStateMachine } from './payment-state-machine';
import { Payment, PaymentStatusEnum } from './dto/payment.type';
import { PaymentConnection } from './dto/payment-connection.type';
import { AdminPaymentsInput } from './dto/admin-payments.input';
import { OmiseService } from './omise/omise.service';
import { CreatePaymentInput } from './dto/create-payment.input';
import { RefundPaymentInput } from './dto/refund-payment.input';

type PrismaHistoryRow = {
  id: string;
  paymentId: string;
  fromStatus: PaymentStatus | null;
  toStatus: PaymentStatus;
  changedBy: string | null;
  reason: string | null;
  metadata: Prisma.JsonValue | null;
  createdAt: Date;
};

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fsm: PaymentStateMachine,
    private readonly omiseService: OmiseService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ── PYG-277: audit history query ─────────────────────────────────────────

  async getHistory(
    paymentId: string,
    user: AuthUser,
  ): Promise<PaymentStatusHistory[]> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: { patientId: true, caregiverId: true },
    });

    if (!payment) throw new NotFoundException(`ไม่พบ payment "${paymentId}"`);

    const isParty = payment.patientId === user.id || payment.caregiverId === user.id;
    const isAdmin = user.role >= ROLE_ID.ADMIN; // ADMIN(3) and SUPER_ADMIN(4)
    if (!isParty && !isAdmin) {
      throw new ForbiddenException('คุณไม่มีสิทธิ์ดูประวัติการชำระเงินนี้');
    }

    const rows = await this.prisma.paymentStatusHistory.findMany({
      where: { paymentId },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((row) => this.mapHistoryRow(row as PrismaHistoryRow));
  }

  // ── PYG-281: Authorize Payment ───────────────────────────────────────────

  async createPayment(input: CreatePaymentInput, user: AuthUser): Promise<Payment> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: input.bookingId },
      include: { caregiver: true },
    });

    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.patientId !== user.id) throw new ForbiddenException('Access denied');
    if (booking.status !== 'accepted') {
      throw new UnprocessableEntityException('Booking must be in accepted status to make a payment');
    }
    if (!booking.caregiverId || !booking.caregiver) {
      throw new UnprocessableEntityException('Booking has no caregiver assigned');
    }

    // Extract to a const so the non-null type is preserved inside the $transaction
    // closure below. TS does NOT carry property-access narrowing (booking.caregiver)
    // into closures, but it does keep a narrowed const — so use this everywhere.
    const caregiver = booking.caregiver;

    const existingPayment = await this.prisma.payment.findUnique({
      where: { bookingId: booking.id },
    });

    if (existingPayment && existingPayment.paymentStatus !== PaymentStatus.failed) {
      throw new ConflictException('A valid payment already exists for this booking');
    }

    const duration = typeof (booking.durationHours as any).toNumber === 'function' 
      ? (booking.durationHours as any).toNumber() 
      : Number(booking.durationHours);
      
    const hourlyRate = caregiver.hourlyRate ?? 0;
    if (hourlyRate <= 0) {
      throw new UnprocessableEntityException('Caregiver has an invalid hourly rate');
    }

    // Payment.amount expects Baht, Omise expects Satangs
    const amountBaht = Math.round(duration * hourlyRate * 100) / 100;
    const amountSatangs = Math.round(amountBaht * 100);

    const chargeResult = await this.omiseService.createCharge(amountSatangs, input.omiseToken);

    // Atomic: update booking status and upsert payment, plus initial history row
    const payment = await this.prisma.$transaction(async (tx) => {
      await tx.booking.update({
        where: { id: booking.id },
        data: { status: 'confirmed', confirmedAt: new Date() },
      });

      const paymentData = {
        patientId: user.id,
        caregiverId: caregiver.userId,
        amount: amountBaht,
        paymentStatus: PaymentStatus.held,
        paymentMethod: 'credit_card',
        omiseToken: input.omiseToken,
        omiseChargeId: chargeResult.id,
        failureCode: chargeResult.failure_code ?? null,
        failureMessage: chargeResult.failure_message ?? null,
      };

      let resultPayment;
      if (existingPayment) {
        resultPayment = await tx.payment.update({
          where: { id: existingPayment.id },
          data: paymentData,
        });
      } else {
        resultPayment = await tx.payment.create({
          data: {
            bookingId: booking.id,
            ...paymentData,
          },
        });
      }

      // Initial history row isn't achievable via PaymentStateMachine inside tx since
      // there's no null -> held edge. We write it directly to the transaction client.
      await tx.paymentStatusHistory.create({
        data: {
          paymentId: resultPayment.id,
          fromStatus: existingPayment ? (existingPayment.paymentStatus as PaymentStatus) : null,
          toStatus: PaymentStatus.held,
          changedBy: user.id,
          reason: 'Authorized payment via Omise',
        },
      });

      return resultPayment;
    });

    // PYG-292: authorize สำเร็จ → กันวงเงิน (held) + booking ขึ้น confirmed
    //  - payment.held    → แจ้ง patient ว่าชำระเงินเรียบร้อย
    //  - booking.confirmed → แจ้ง caregiver ว่าการจองยืนยันแล้ว
    // ยิงหลัง $transaction commit เพื่อให้ listener อ่านข้อมูลที่ลงจริงได้
    this.eventEmitter.emit(BOOKING_EVENTS.PAYMENT_HELD, {
      bookingId: booking.id,
      eventType: BOOKING_EVENTS.PAYMENT_HELD,
      patientId: user.id,
      caregiverId: caregiver.userId,
    });
    this.eventEmitter.emit(BOOKING_EVENTS.CONFIRMED, {
      bookingId: booking.id,
      eventType: BOOKING_EVENTS.CONFIRMED,
      patientId: user.id,
      caregiverId: caregiver.userId,
    });

    return this.toGql(payment);
  }

  // ── PYG-282: admin transfer + payment list ───────────────────────────────

  async markPaymentTransferred(
    paymentId: string,
    transferRef: string,
    notes: string | undefined,
    adminId: string,
  ): Promise<Payment> {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found');

    if ((payment.paymentStatus as PaymentStatus) !== PaymentStatus.captured) {
      throw new BadRequestException('payment not in captured state');
    }

    // Use FSM — atomic: updates status + inserts history in one transaction
    const updated = await this.fsm.transition(paymentId, PaymentStatus.transferred, {
      changedBy: adminId,
      reason: notes,
      metadata: { transferRef, transferredAt: new Date().toISOString() },
    });

    // Merge transferRef into payment.metadata for FE visibility
    await this.prisma.payment.update({
      where: { id: paymentId },
      data: {
        metadata: {
          ...(updated.metadata as object ?? {}),
          transferRef,
          adminId,
        },
      },
    });

    // TODO: PYG-268 — replace with EventEmitter2.emit('payment.transferred', payload)
    this.logger.log(JSON.stringify({
      event: 'payment.transferred',
      payload: {
        paymentId,
        caregiverId: updated.caregiverId,
        bookingId: updated.bookingId,
        amount: Number(updated.amount),
      },
    }));

    return this.toGql(updated);
  }

  async adminPayments(input: AdminPaymentsInput): Promise<PaymentConnection> {
    const page  = Math.max(1, input.page  ?? 1);
    const limit = Math.min(100, Math.max(1, input.limit ?? 20));
    const status = (input.status ?? PaymentStatusEnum.captured) as unknown as PaymentStatus;
    const offset = (page - 1) * limit;

    const where = { paymentStatus: status };

    const [items, totalCount] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: offset,
        take: limit,
      }),
      this.prisma.payment.count({ where }),
    ]);

    return {
      nodes: items.map((p) => this.toGql(p)),
      totalCount,
      page,
      limit,
      hasNextPage: offset + limit < totalCount,
    };
  }

  // ── PYG-286: admin refund (full / partial) ──────────────────────────────

  /**
   * refundPayment — admin คืนเงินจาก payment ที่ capture แล้ว
   *
   * Guard 4 ชั้น (เงินจริง — defense in depth):
   *  1) Role: admin role check (resolver-level @Roles)
   *  2) Status pre-check: payment ต้อง 'captured' + มี omiseChargeId
   *  3) Amount: ถ้าระบุต้องอยู่ในช่วง (0, payment.amount] เปรียบเทียบหน่วย satangs กัน float
   *  4) Re-check status RIGHT BEFORE Omise call: ปิด race window double-refund
   *  + Omise-Idempotency-Key เพื่อกัน Omise ทำซ้ำถ้ายิง 2 ครั้งพร้อมกัน
   *  + FSM transition: ปิด state machine — captured → refunded หรือ partially_refunded เท่านั้น
   *
   * Order of operations:
   *  - Omise call OUTSIDE tx (HTTP, อย่าถือ tx ค้าง)
   *  - FSM transition + payment.metadata update INSIDE tx (atomic)
   *  - emit BOOKING_EVENTS.REFUND_ISSUED หลัง tx commit (listener ดึง booking สดจาก DB)
   */
  async refundPayment(input: RefundPaymentInput, admin: AuthUser): Promise<Payment> {
    // Guard 1: role — เผื่อ resolver ไม่ได้ guard
    if (admin.role < ROLE_ID.ADMIN) {
      throw new ForbiddenException('คุณไม่มีสิทธิ์คืนเงิน');
    }

    // Guard 2: status pre-check
    const payment = await this.prisma.payment.findUnique({
      where: { id: input.paymentId },
    });
    if (!payment) throw new NotFoundException(`ไม่พบ payment "${input.paymentId}"`);

    if ((payment.paymentStatus as PaymentStatus) !== PaymentStatus.captured) {
      throw new BadRequestException(
        `ไม่สามารถคืนเงินได้ — payment ต้องอยู่สถานะ "captured" (ปัจจุบัน: ${payment.paymentStatus})`,
      );
    }
    if (!payment.omiseChargeId) {
      throw new BadRequestException('payment ไม่มี omiseChargeId — ไม่สามารถคืนเงินได้');
    }

    // Guard 3: amount range — ทำงานในหน่วย satangs ตลอด เพื่อกัน float precision error
    const paymentAmountBaht = this.toBahtNumber(payment.amount);
    const paymentAmountSatangs = Math.round(paymentAmountBaht * 100);
    const isPartial = input.amount !== undefined;
    const refundAmountBaht = input.amount ?? paymentAmountBaht;
    const refundAmountSatangs = Math.round(refundAmountBaht * 100);

    if (refundAmountSatangs <= 0) {
      throw new BadRequestException('จำนวนเงินที่คืนต้องมากกว่า 0');
    }
    if (refundAmountSatangs > paymentAmountSatangs) {
      throw new BadRequestException(
        `จำนวนเงินที่คืน (${refundAmountBaht} THB) ต้องไม่เกินยอด payment (${paymentAmountBaht} THB)`,
      );
    }

    // Guard 4: re-check status RIGHT BEFORE Omise call — ปิด race window
    // (ถ้ามี admin คนอื่น refund คั่นกลางจาก step 2 → step นี้, status จะเปลี่ยนไป)
    const recheck = await this.prisma.payment.findUnique({
      where: { id: input.paymentId },
      select: { paymentStatus: true },
    });
    if (
      !recheck ||
      (recheck.paymentStatus as PaymentStatus) !== PaymentStatus.captured
    ) {
      throw new ConflictException(
        `payment ถูกเปลี่ยนสถานะระหว่างการตรวจสอบ (ปัจจุบัน: ${recheck?.paymentStatus ?? 'unknown'}) — กรุณาลองใหม่`,
      );
    }

    // Omise call — outside tx, with idempotency key
    // key รวม paymentId + amount: ยิงซ้ำด้วย amount เดียวกัน = Omise return cached, ไม่ refund 2 ครั้ง
    const idempotencyKey = `refund:${payment.id}:${refundAmountSatangs}`;
    let refund;
    try {
      refund = await this.omiseService.createRefund(
        payment.omiseChargeId,
        // ส่ง amount เฉพาะ partial — full ปล่อย undefined ให้ Omise ตี refund ส่วนที่เหลือ
        isPartial ? refundAmountSatangs : undefined,
        idempotencyKey,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[refundPayment] Omise createRefund failed: ${msg}`);
      throw new ServiceUnavailableException(
        'ไม่สามารถดำเนินการคืนเงินได้ในขณะนี้ กรุณาลองใหม่ภายหลัง',
      );
    }

    // FSM transition + payment.metadata update — atomic
    const targetStatus = isPartial
      ? PaymentStatus.partially_refunded
      : PaymentStatus.refunded;

    const refundedAt = new Date().toISOString();
    const refundMetadata = {
      omiseRefundId: refund.id,
      refundAmount: refundAmountBaht,
      refundReason: input.reason ?? null,
      refundedBy: admin.id,
      refundedAt,
      isPartial,
    };

    const updated = await this.prisma.$transaction(async (tx) => {
      // FSM ตรวจกฎ + เขียน status + history ในก้อนเดียว (รับ tx ภายนอก)
      const u = await this.fsm.transition(
        input.paymentId,
        targetStatus,
        {
          changedBy: admin.id,
          reason: input.reason,
          metadata: refundMetadata,
        },
        tx,
      );

      // merge refund fields เข้า payment.metadata (สำหรับ FE visibility)
      const existingMeta =
        u.metadata === null || u.metadata === undefined
          ? {}
          : (u.metadata as Record<string, unknown>);

      const merged = await tx.payment.update({
        where: { id: input.paymentId },
        data: {
          metadata: {
            ...existingMeta,
            ...refundMetadata,
          } as Prisma.InputJsonValue,
        },
      });
      return merged;
    });

    // emit หลัง tx commit (listener อ่านข้อมูลล่าสุดได้)
    this.eventEmitter.emit(BOOKING_EVENTS.REFUND_ISSUED, {
      bookingId: payment.bookingId,
      eventType: BOOKING_EVENTS.REFUND_ISSUED,
      patientId: payment.patientId,
      caregiverId: payment.caregiverId,
      metadata: {
        amount: refundAmountBaht,
        omiseRefundId: refund.id,
        isPartial,
      },
    });

    return this.toGql(updated);
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /** Prisma.Decimal | number | string → number (THB) — กัน float ที่อื่นแล้วใช้ satangs */
  private toBahtNumber(value: Prisma.Decimal | number | string): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return Number(value);
    return typeof (value as Prisma.Decimal).toNumber === 'function'
      ? (value as Prisma.Decimal).toNumber()
      : Number(value);
  }

  private mapHistoryRow(row: PrismaHistoryRow): PaymentStatusHistory {
    return {
      id: row.id,
      paymentId: row.paymentId,
      fromStatus: row.fromStatus ?? undefined,
      toStatus: row.toStatus,
      changedBy: row.changedBy ?? undefined,
      reason: row.reason ?? undefined,
      metadata: row.metadata === null ? undefined : JSON.stringify(row.metadata),
      createdAt: row.createdAt,
    };
  }

  private toGql(p: {
    id: string;
    bookingId: string;
    patientId: string;
    caregiverId: string;
    amount: { toNumber(): number } | number | string;
    currency: string;
    omiseChargeId: string | null;
    paymentMethod: string;
    paymentStatus: string;
    failureCode: string | null;
    failureMessage: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): Payment {
    return {
      id:             p.id,
      bookingId:      p.bookingId,
      patientId:      p.patientId,
      caregiverId:    p.caregiverId,
      amount:         typeof p.amount === 'object' && 'toNumber' in p.amount
                        ? p.amount.toNumber()
                        : Number(p.amount),
      currency:       p.currency,
      omiseChargeId:  p.omiseChargeId  ?? undefined,
      paymentMethod:  p.paymentMethod,
      paymentStatus:  p.paymentStatus as PaymentStatusEnum,
      failureCode:    p.failureCode    ?? undefined,
      failureMessage: p.failureMessage ?? undefined,
      createdAt:      p.createdAt,
      updatedAt:      p.updatedAt,
    };
  }
}
