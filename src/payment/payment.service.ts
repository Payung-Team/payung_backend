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
import { ConfigService } from '@nestjs/config';
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
    private readonly config: ConfigService,
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

    // ── PYG-278: PromptPay branch — แยกออกจาก flow card 100% ─────────────────
    // PromptPay = สร้าง QR, payment stays pending, confirmation via webhook async
    // ไม่กระทบ flow card เดิมเลย (เข้า if-return ก่อนเรียก createCharge)
    if (input.paymentMethod === 'promptpay') {
      return this.finalisePromptPay({
        bookingId: booking.id,
        patientId: user.id,
        caregiverUserId: caregiver.userId,
        amountBaht,
        amountSatangs,
        existingPayment,
        actorId: user.id,
      });
    }

    // PYG-278: ในที่นี้ paymentMethod = 'credit_card' (PromptPay return ไปแล้ว) —
    // DTO @ValidateIf บังคับให้มี omiseToken แล้วถ้า paymentMethod=card; assert ทับอีกชั้น
    if (!input.omiseToken) {
      throw new UnprocessableEntityException('omiseToken is required for credit_card payment');
    }
    const omiseToken = input.omiseToken;

    const chargeResult = await this.omiseService.createCharge(amountSatangs, omiseToken);

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
        omiseToken,
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

  // ── PYG-266: admin transfer (real Omise Transfer, replaces PYG-282 manual mark) ──

  /**
   * transferPaymentToCaregiver — admin โอนเงินจริงให้ caregiver ผ่าน Omise Transfer
   *
   * Guard 6 ชั้น (เงินจริง — defense in depth), mirror ของ refundPayment:
   *  1) Role: admin role check (resolver-level @Roles)
   *  2) Status pre-check: payment ต้อง 'captured'
   *  3) Idempotency pre-check: payment.metadata.omiseTransferId ต้องยังไม่มี
   *  4) Caregiver account standing: ต้องไม่ถูก suspend/ลบ
   *  5) Payout account: ต้อง status='active' + recipientStatus='verified' + มี omiseRecipientId
   *  6) Re-check status + payout account RIGHT BEFORE Omise call: ปิด race window
   *  + Omise-Idempotency-Key เพื่อกัน Omise ทำซ้ำถ้ายิง 2 ครั้งพร้อมกัน
   *  + FSM transition: ปิด state machine — captured → transferred เท่านั้น (terminal state)
   *
   * ยอดที่โอน = capturedAmount * (1 - PLATFORM_FEE_PERCENT / 100) (default 10% → caregiver ได้ 90%)
   */
  async transferPaymentToCaregiver(bookingId: string, admin: AuthUser): Promise<Payment> {
    // Guard 1: role — เผื่อ resolver ไม่ได้ guard
    if (admin.role < ROLE_ID.ADMIN) {
      throw new ForbiddenException('คุณไม่มีสิทธิ์โอนเงินให้ผู้ดูแล');
    }

    const payment = await this.prisma.payment.findUnique({ where: { bookingId } });
    if (!payment) throw new NotFoundException(`ไม่พบ payment สำหรับ booking "${bookingId}"`);

    // Guard 2: status pre-check
    if ((payment.paymentStatus as PaymentStatus) !== PaymentStatus.captured) {
      throw new BadRequestException(
        `ไม่สามารถโอนเงินได้ — payment ต้องอยู่สถานะ "captured" (ปัจจุบัน: ${payment.paymentStatus})`,
      );
    }

    // Guard 3: idempotency pre-check — omiseTransferId ถูกบันทึกแล้ว = โอนไปแล้ว
    const existingMeta = (payment.metadata ?? {}) as Record<string, unknown>;
    if (existingMeta.omiseTransferId) {
      throw new ConflictException('payment นี้ถูกโอนเงินไปแล้ว');
    }

    // payment.caregiverId คือ USER id (caregiver.userId) — ไม่ใช่ Caregiver row id
    // ที่ CaregiverPayoutAccount.caregiverId อ้างถึง ต้อง resolve ผ่าน userId ก่อนเสมอ
    const caregiverRow = await this.prisma.caregiver.findUnique({
      where: { userId: payment.caregiverId },
      include: { user: { select: { isActive: true, is_suspended: true, is_deleted: true } } },
    });
    if (!caregiverRow) {
      throw new NotFoundException('ไม่พบข้อมูลผู้ดูแลของ payment นี้');
    }

    // Guard 4: caregiver ต้องไม่ถูกระงับ/ลบบัญชี
    if (
      caregiverRow.user.is_suspended ||
      caregiverRow.user.is_deleted ||
      !caregiverRow.user.isActive
    ) {
      throw new BadRequestException('ไม่สามารถโอนเงินให้ผู้ดูแลที่ถูกระงับ/ลบบัญชีได้');
    }

    // Guard 5: payout account ต้องพร้อมรับโอน
    const payoutAccount = await this.prisma.caregiverPayoutAccount.findUnique({
      where: { caregiverId: caregiverRow.id },
    });
    if (
      !payoutAccount ||
      payoutAccount.status !== 'active' ||
      payoutAccount.recipientStatus !== 'verified' ||
      !payoutAccount.omiseRecipientId
    ) {
      throw new BadRequestException('บัญชีรับเงินของผู้ดูแลยังไม่พร้อมรับการโอนเงิน');
    }

    // คำนวณยอดโอน — ทำงานในหน่วย satangs ตลอดเพื่อกัน float precision error
    // ConfigService.get<T>() เป็นแค่ type cast ไม่ได้ coerce runtime — ต้อง Number() เอง
    // ไม่งั้น platformFeePercent จะเป็น string "10" ปนอยู่ใน metadata (JSON) แทนที่จะเป็น number
    const platformFeePercent = Number(this.config.get<string>('PLATFORM_FEE_PERCENT', '10'));
    const capturedAmountBaht = this.toBahtNumber(payment.amount);
    const capturedAmountSatangs = Math.round(capturedAmountBaht * 100);
    const transferAmountSatangs = Math.round(
      capturedAmountSatangs * (1 - platformFeePercent / 100),
    );

    // Guard 6: re-check ทั้ง payment status และ payout account status ก่อนยิง Omise
    // (ปิดช่องที่ webhook recipient.failed แทรกเข้ามาระหว่าง guard 5 กับตรงนี้)
    const recheckPayment = await this.prisma.payment.findUnique({
      where: { id: payment.id },
      select: { paymentStatus: true, metadata: true },
    });
    const recheckPayout = await this.prisma.caregiverPayoutAccount.findUnique({
      where: { caregiverId: caregiverRow.id },
      select: { status: true, recipientStatus: true },
    });
    const recheckMeta = (recheckPayment?.metadata ?? {}) as Record<string, unknown>;
    if (
      !recheckPayment ||
      (recheckPayment.paymentStatus as PaymentStatus) !== PaymentStatus.captured ||
      recheckMeta.omiseTransferId ||
      !recheckPayout ||
      recheckPayout.status !== 'active' ||
      recheckPayout.recipientStatus !== 'verified'
    ) {
      throw new ConflictException(
        'payment หรือบัญชีรับเงินถูกเปลี่ยนสถานะระหว่างการตรวจสอบ — กรุณาลองใหม่',
      );
    }

    // Omise call — outside tx, idempotency key เดียวต่อ payment (มี transfer เดียวเสมอ)
    const idempotencyKey = `transfer:${payment.id}`;
    let transfer;
    try {
      transfer = await this.omiseService.createTransfer(
        payoutAccount.omiseRecipientId,
        transferAmountSatangs,
        idempotencyKey,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[transferPaymentToCaregiver] Omise createTransfer failed: ${msg}`);

      // บันทึก audit ว่าเคยพยายามโอนแล้วไม่สำเร็จ — ไม่เปลี่ยนสถานะ (ยังคง captured, retry ได้)
      await this.fsm.recordCaptureFailure(payment.id, PaymentStatus.captured, {
        changedBy: admin.id,
        reason: msg,
        metadata: { attemptedTransferAmountSatangs: transferAmountSatangs },
      });

      throw new ServiceUnavailableException(
        'ไม่สามารถโอนเงินให้ผู้ดูแลได้ในขณะนี้ กรุณาลองใหม่ภายหลัง',
      );
    }

    const transferredAt = new Date().toISOString();
    const transferMetadata = {
      omiseTransferId: transfer.id,
      platformFeePercent,
      transferAmountSatangs,
      transferredAt,
      transferredBy: admin.id,
    };

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await this.fsm.transition(
        payment.id,
        PaymentStatus.transferred,
        { changedBy: admin.id, metadata: transferMetadata },
        tx,
      );

      const uMeta = u.metadata === null || u.metadata === undefined
        ? {}
        : (u.metadata as Record<string, unknown>);

      const merged = await tx.payment.update({
        where: { id: payment.id },
        data: {
          metadata: {
            ...uMeta,
            ...transferMetadata,
          } as Prisma.InputJsonValue,
        },
      });
      return merged;
    });

    // emit หลัง tx commit (listener อ่านข้อมูลล่าสุดได้)
    this.eventEmitter.emit(BOOKING_EVENTS.PAYMENT_TRANSFERRED, {
      bookingId,
      eventType: BOOKING_EVENTS.PAYMENT_TRANSFERRED,
      patientId: payment.patientId,
      caregiverId: payment.caregiverId,
      metadata: {
        transferAmountSatangs,
        omiseTransferId: transfer.id,
      },
    });

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

  // ── PYG-278: ดึง payment ของ booking สำหรับหน้า booking detail ──────────────

  /** PYG-278: ดึง payment ของ booking 1 รายการ (1:1, bookingId @unique) สำหรับแสดงบนหน้า booking detail */
  async findByBookingId(bookingId: string): Promise<Payment | null> {
    const row = await this.prisma.payment.findUnique({ where: { bookingId } });
    return row ? this.toGql(row) : null;
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
    // PYG-278: optional — read qrCodeUrl out of metadata for PromptPay
    metadata?: Prisma.JsonValue | null;
  }): Payment {
    const meta =
      p.metadata && typeof p.metadata === 'object' && !Array.isArray(p.metadata)
        ? (p.metadata as Record<string, unknown>)
        : undefined;
    const qrCodeUrl =
      meta && typeof meta.qrCodeUrl === 'string' ? meta.qrCodeUrl : undefined;

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
      qrCodeUrl,
      createdAt:      p.createdAt,
      updatedAt:      p.updatedAt,
    };
  }

  // ─── PYG-278: PromptPay flow ────────────────────────────────────────────

  /**
   * finalisePromptPay — สร้าง PromptPay charge + เก็บ QR URL ใน metadata
   *
   * Flow ต่างจากบัตร:
   * - payment เริ่มต้นเป็น 'pending' (ยังไม่ held — ยังไม่มีเงินจริง)
   * - ไม่อัปเดต booking.status (ยังคงเป็น 'accepted' จนกว่าจะมี webhook ยืนยัน)
   * - qrCodeUrl เก็บใน payment.metadata.qrCodeUrl (jsonb) ไม่ต้อง migration
   *
   * ไม่ยิง event PAYMENT_HELD/CONFIRMED ที่นี่ — รอ captureFromWebhook ดำเนินการ
   * ตอน user สแกน QR + bank ยืนยันแล้วเท่านั้น
   */
  private async finalisePromptPay(args: {
    bookingId: string;
    patientId: string;
    caregiverUserId: string;
    amountBaht: number;
    amountSatangs: number;
    existingPayment: { id: string; paymentStatus: string } | null;
    actorId: string;
  }): Promise<Payment> {
    // 1) call Omise (external) — อยู่นอก transaction
    const charge = await this.omiseService.createPromptPayCharge(args.amountSatangs);

    // 2) atomic: upsert payment + write initial history (no booking update)
    const payment = await this.prisma.$transaction(async (tx) => {
      const baseData = {
        patientId: args.patientId,
        caregiverId: args.caregiverUserId,
        amount: args.amountBaht,
        paymentStatus: PaymentStatus.pending,
        paymentMethod: 'promptpay',
        omiseChargeId: charge.id,
        metadata: {
          qrCodeUrl: charge.qrCodeUrl,
          amountSatangs: args.amountSatangs,
        } as Prisma.InputJsonValue,
        failureCode: null,
        failureMessage: null,
      };

      const resultPayment = args.existingPayment
        ? await tx.payment.update({
            where: { id: args.existingPayment.id },
            data: baseData,
          })
        : await tx.payment.create({
            data: { bookingId: args.bookingId, ...baseData },
          });

      await tx.paymentStatusHistory.create({
        data: {
          paymentId: resultPayment.id,
          fromStatus: args.existingPayment
            ? (args.existingPayment.paymentStatus as PaymentStatus)
            : null,
          toStatus: PaymentStatus.pending,
          changedBy: args.actorId,
          reason: 'PromptPay charge created — รอ user สแกน + bank confirm',
          metadata: {
            omiseChargeId: charge.id,
            qrCodeUrl: charge.qrCodeUrl,
            amountSatangs: args.amountSatangs,
          },
        },
      });

      return resultPayment;
    });

    this.logger.log(
      `[PromptPay] charge created paymentId=${payment.id} chargeId=${charge.id} amount=${args.amountSatangs}sth`,
    );

    return this.toGql(payment);
  }

  /**
   * captureFromWebhook — PYG-278: อัปเดต PromptPay payment เมื่อ Omise ส่ง charge.complete
   *
   * เรียกจาก OmiseController webhook handler (signature verified แล้ว)
   *
   * พฤติกรรม:
   * - หา payment จาก omiseChargeId; ไม่เจอ → log + return (Omise อาจส่ง webhook ของ
   *   charge ที่ไม่ใช่ของเรา หรือ retry หลังลบ payment)
   * - retrieveCharge อีกที (defense in depth): webhook body อาจไม่ครบ/ปลอม → re-fetch
   *   จาก Omise ก่อนตัดสินใจ
   * - ถ้า paid+captured+successful → FSM transition pending → captured + booking confirmed
   * - emit CONFIRMED (PYG-292) — ไม่ emit PAYMENT_HELD เพราะ PromptPay ไม่มี "hold" จริง
   *
   * Idempotent: ถ้า payment ไม่ใช่ pending แล้ว (เคย captured/voided/refunded) → log + skip
   * เพื่อกัน Omise retry webhook ซ้ำซ้อน
   */
  async captureFromWebhook(omiseChargeId: string): Promise<void> {
    if (!omiseChargeId) {
      this.logger.warn('[PromptPay/webhook] missing omiseChargeId — skipping');
      return;
    }

    const payment = await this.prisma.payment.findFirst({
      where: { omiseChargeId },
    });
    if (!payment) {
      this.logger.warn(
        `[PromptPay/webhook] no payment found for chargeId=${omiseChargeId} — skipping`,
      );
      return;
    }

    // Idempotent guard — Omise retries until 2xx; skip ถ้า process ไปแล้ว
    if ((payment.paymentStatus as PaymentStatus) !== PaymentStatus.pending) {
      this.logger.log(
        `[PromptPay/webhook] payment ${payment.id} already in '${payment.paymentStatus}' — skipping`,
      );
      return;
    }

    // Re-fetch จาก Omise เพื่อกันใช้ webhook body ที่ tamper
    const omiseCharge = await this.omiseService.retrieveCharge(omiseChargeId);
    if (omiseCharge.status !== 'successful' || !omiseCharge.paid) {
      this.logger.warn(
        `[PromptPay/webhook] charge ${omiseChargeId} not successful (status=${omiseCharge.status}, paid=${omiseCharge.paid}) — skipping`,
      );
      return;
    }

    // FSM-driven transition + booking → confirmed (atomic)
    await this.prisma.$transaction(async (tx) => {
      await this.fsm.transition(
        payment.id,
        PaymentStatus.captured,
        {
          reason: 'PromptPay charge.complete webhook — user scanned + bank confirmed',
          metadata: {
            omiseChargeId,
            capturedAt: new Date().toISOString(),
            source: 'webhook',
          },
        },
        tx,
      );

      await tx.booking.update({
        where: { id: payment.bookingId },
        data: { status: 'confirmed', confirmedAt: new Date() },
      });
    });

    // booking.confirmed → แจ้ง patient/caregiver (PYG-292 listener)
    this.eventEmitter.emit(BOOKING_EVENTS.CONFIRMED, {
      bookingId: payment.bookingId,
      eventType: BOOKING_EVENTS.CONFIRMED,
      patientId: payment.patientId,
      caregiverId: payment.caregiverId,
    });

    this.logger.log(
      `[PromptPay/webhook] payment ${payment.id} → captured (chargeId=${omiseChargeId})`,
    );
  }

  /**
   * paymentByBooking — PYG-278: query สำหรับ FE polling
   *
   * Patient/caregiver/admin เรียกเพื่อดูสถานะ payment ของ booking หนึ่ง — โดยเฉพาะ
   * FE PromptPay screen ที่ poll สถานะระหว่างรอ webhook
   *
   * Polling fallback:
   * - ถ้า payment status = 'pending' AND paymentMethod = 'promptpay' → retrieveCharge
   *   จาก Omise สด ๆ
   * - ถ้า Omise บอก successful + paid → reconcile โดยเรียก captureFromWebhook
   *   (handle เคส webhook เลทหรือหาย)
   *
   * @returns payment ล่าสุด (อาจมี qrCodeUrl ใน metadata)
   * @throws ForbiddenException ถ้าไม่ใช่ party ของ booking
   */
  async paymentByBooking(bookingId: string, user: AuthUser): Promise<Payment | null> {
    const payment = await this.prisma.payment.findUnique({
      where: { bookingId },
    });
    if (!payment) return null;

    const isParty = payment.patientId === user.id || payment.caregiverId === user.id;
    const isAdmin = user.role >= ROLE_ID.ADMIN;
    if (!isParty && !isAdmin) {
      throw new ForbiddenException('คุณไม่มีสิทธิ์ดูรายการชำระเงินนี้');
    }

    // Polling fallback — เฉพาะ PromptPay pending เท่านั้น
    const isPromptPayPending =
      payment.paymentMethod === 'promptpay' &&
      (payment.paymentStatus as PaymentStatus) === PaymentStatus.pending &&
      !!payment.omiseChargeId;

    if (isPromptPayPending) {
      try {
        const omiseCharge = await this.omiseService.retrieveCharge(payment.omiseChargeId!);
        if (omiseCharge.status === 'successful' && omiseCharge.paid) {
          // Webhook อาจยังไม่ถึง / หาย → reconcile เลย
          await this.captureFromWebhook(payment.omiseChargeId!);
          // อ่าน payment ใหม่ที่ status อัปเดตแล้ว
          const refreshed = await this.prisma.payment.findUnique({
            where: { bookingId },
          });
          return refreshed ? this.toGql(refreshed) : null;
        }
      } catch (err) {
        // polling reconcile fail ต้องไม่ทำให้ query พัง — log แล้วคืน payment เดิม
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `[PromptPay/poll] reconcile failed for payment ${payment.id}: ${msg}`,
        );
      }
    }

    return this.toGql(payment);
  }
}
