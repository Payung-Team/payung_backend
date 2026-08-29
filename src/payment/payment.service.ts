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
import type { Prisma, Payment as PrismaPayment } from '@prisma/client';
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
import { RefundService } from './refund.service';
import { CreatePaymentInput } from './dto/create-payment.input';
import { RefundPaymentInput } from './dto/refund-payment.input';

/**
 * Statuses ที่ถือว่า "มี payment ที่ยัง valid อยู่จริง" → บล็อกไม่ให้สร้าง payment ใหม่ซ้ำ
 * (กันจ่ายซ้ำ / กัน Omise charge ซ้อน)
 *
 * ทำไมต้อง whitelist แบบนี้แทนที่จะเช็ค `!== failed`:
 *   - flow บัตร fail จะ throw ตั้งแต่ createCharge ก่อนเขียน record → ไม่มี record 'failed' เกิดจริง
 *     ทำให้ guard เดิม (`!== failed`) เผลอบล็อก 'expired'/'voided' ที่ควร retry ได้
 *
 * ที่ "ไม่" อยู่ในนี้ = ให้ลองใหม่ได้ (retry ทับ record เดิม):
 *   - failed   → authorize ไม่ผ่าน
 *   - expired  → hold หมดอายุ (เกิน PAYMENT_HOLD_DAYS)
 *   - voided   → ยกเลิกการกันวงเงินแล้ว
 */
const BLOCKING_PAYMENT_STATUSES: ReadonlySet<PaymentStatus> = new Set([
  PaymentStatus.pending,
  PaymentStatus.held,
  PaymentStatus.captured,
  PaymentStatus.transferred,
  PaymentStatus.refunded,
  PaymentStatus.partially_refunded,
]);

/**
 * PromptPay `pending` ที่เก่ากว่านี้ = ถือว่า QR ถูกทิ้ง (user ไม่สแกน) → ปลดบล็อกให้จ่ายใหม่ได้
 *
 * ทำไมต้องมี window นี้แทนที่จะปลดบล็อก pending ทั้งหมด:
 *   - pending สดๆ = อาจมี QR ที่ user กำลังจะสแกน → ถ้าให้ overwrite ทันทีจะเสี่ยง double-charge
 *     (จ่าย QR เก่า + จ่ายรอบใหม่พร้อมกัน) → กันด้วย time window
 *   - Omise PromptPay QR หมดอายุในหลักนาที; 15 นาทีเผื่อ clock skew + เวลาสแกนจริง
 */
const PROMPTPAY_PENDING_STALE_MS = 15 * 60 * 1000;

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
    private readonly refundService: RefundService,
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

  /**
   * isPaymentBlocking — มี payment ที่ยัง valid อยู่จริงไหม (→ บล็อกไม่ให้จ่ายซ้ำ กัน Omise charge ซ้อน)
   *
   *   - failed / expired / voided        → ไม่บล็อก (ให้ retry ได้)
   *   - pending ที่เก่าเกิน stale window  → ไม่บล็อก (QR ถูกทิ้ง → ให้ overwrite จ่ายใหม่)
   *   - pending สดๆ, held, captured, ...  → บล็อก
   *
   * ใช้ `updatedAt` (ไม่ใช่ createdAt) วัดอายุ pending — QR ที่ถูกสร้างใหม่ทับ record เดิมจะ
   * bump updatedAt ทำให้ถูก "ป้องกัน" ใหม่อีกรอบ กัน double-charge กับ QR ที่เพิ่ง regenerate
   */
  private isPaymentBlocking(payment: { paymentStatus: string; updatedAt: Date }): boolean {
    const status = payment.paymentStatus as PaymentStatus;
    if (!BLOCKING_PAYMENT_STATUSES.has(status)) return false;

    if (status === PaymentStatus.pending) {
      const ageMs = Date.now() - new Date(payment.updatedAt).getTime();
      if (ageMs >= PROMPTPAY_PENDING_STALE_MS) return false; // stale QR → allow retry
    }
    return true;
  }

  /**
   * reconcileStalePromptPay (PYG-309/375) — ask Omise the truth about a stale pending PromptPay.
   * retrieveCharge FIRST (never guess from elapsed time):
   *   paid      → captured (webhook was lost — repair, don't double-charge)
   *   not paid  → expired  (prefer expires_at when Omise provides it)
   *   not found → failed
   * All transitions go through the FSM (pending → captured/expired/failed are valid edges).
   */
  private async reconcileStalePromptPay(payment: PrismaPayment): Promise<PrismaPayment> {
    if (!payment.omiseChargeId) {
      return this.fsm.transition(payment.id, PaymentStatus.failed, {
        reason: 'PromptPay ไม่มี charge id — ยืนยันการจ่ายไม่ได้',
      });
    }

    let charge;
    try {
      charge = await this.omiseService.retrieveCharge(payment.omiseChargeId);
    } catch {
      return this.fsm.transition(payment.id, PaymentStatus.failed, {
        reason: 'PromptPay charge ไม่พบบน Omise — ถือว่าล้มเหลว',
        metadata: { omiseChargeId: payment.omiseChargeId },
      });
    }

    if (charge.paid) {
      return this.fsm.transition(payment.id, PaymentStatus.captured, {
        reason: 'PromptPay จ่ายแล้ว (webhook หาย) — reconcile เป็น captured',
        metadata: {
          omiseChargeId: payment.omiseChargeId,
          reconciledAt: new Date().toISOString(),
        },
      });
    }

    return this.fsm.transition(payment.id, PaymentStatus.expired, {
      reason: charge.expiresAt
        ? `PromptPay หมดอายุ (expires_at=${charge.expiresAt})`
        : 'PromptPay ยังไม่จ่าย — reconcile เป็น expired',
      metadata: {
        omiseChargeId: payment.omiseChargeId,
        expiresAt: charge.expiresAt ?? null,
      },
    });
  }

  /**
   * recordFailedAuthorize (PYG-309/375) — write a `failed` payment row when the card is declined.
   * booking_id is UNIQUE → upsert the single row (never a 2nd). New row → recordInitialStatus
   * (FSM's from=null init), existing row → update + a direct history row (mirrors the authorize
   * outcome path used for `held`). Any write failure is swallowed + logged so it never masks the
   * original Omise error the caller rethrows.
   */
  private async recordFailedAuthorize(
    bookingId: string,
    existingPayment: PrismaPayment | null,
    actorId: string,
    err: unknown,
    ctx: { patientId: string; caregiverId: string; amountBaht: number; omiseToken: string },
  ): Promise<void> {
    const e = err as {
      code?: string;
      message?: string;
      details?: { omiseCode?: string; omiseMessage?: string };
    };
    const failureCode = e.details?.omiseCode ?? e.code ?? 'authorize_failed';
    const failureMessage =
      e.details?.omiseMessage ?? (err instanceof Error ? err.message : String(err));

    try {
      if (existingPayment) {
        await this.prisma.payment.update({
          where: { id: existingPayment.id },
          data: {
            paymentStatus: PaymentStatus.failed,
            failureCode,
            failureMessage,
            omiseToken: ctx.omiseToken,
          },
        });
        await this.prisma.paymentStatusHistory.create({
          data: {
            paymentId: existingPayment.id,
            fromStatus: existingPayment.paymentStatus as PaymentStatus,
            toStatus: PaymentStatus.failed,
            changedBy: actorId,
            reason: 'บัตรถูกปฏิเสธ — authorize ไม่สำเร็จ',
            metadata: { failureCode, failureMessage },
          },
        });
      } else {
        const created = await this.prisma.payment.create({
          data: {
            bookingId,
            patientId: ctx.patientId,
            caregiverId: ctx.caregiverId,
            amount: ctx.amountBaht,
            paymentStatus: PaymentStatus.failed,
            paymentMethod: 'credit_card',
            omiseToken: ctx.omiseToken,
            failureCode,
            failureMessage,
          },
        });
        await this.fsm.recordInitialStatus(created.id, PaymentStatus.failed, {
          changedBy: actorId,
          reason: 'บัตรถูกปฏิเสธ — authorize ไม่สำเร็จ',
          metadata: { failureCode, failureMessage },
        });
      }
    } catch (writeErr) {
      const m = writeErr instanceof Error ? writeErr.message : String(writeErr);
      this.logger.error(
        `[recordFailedAuthorize] persist failed-payment ไม่สำเร็จ booking=${bookingId}: ${m}`,
      );
    }
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

    let existingPayment = await this.prisma.payment.findUnique({
      where: { bookingId: booking.id },
    });

    // PYG-309/375: a stale PromptPay `pending` must not lock the customer out. Ask Omise FIRST
    // (retrieveCharge) — a paid-but-webhook-lost charge is repaired to captured (no 2nd payment);
    // a genuinely dead charge goes terminal (expired/failed) so this new attempt can proceed.
    // Never mark expired on elapsed time alone.
    if (
      existingPayment &&
      existingPayment.paymentMethod === 'promptpay' &&
      (existingPayment.paymentStatus as PaymentStatus) === PaymentStatus.pending
    ) {
      const reconciled = await this.reconcileStalePromptPay(existingPayment);
      if ((reconciled.paymentStatus as PaymentStatus) === PaymentStatus.captured) {
        // paid all along — webhook was lost. Return the repaired payment, do NOT charge again.
        return this.toGql(reconciled);
      }
      existingPayment = reconciled; // now expired/failed → non-blocking, retry proceeds below
    }

    if (existingPayment && this.isPaymentBlocking(existingPayment)) {
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

    // PYG-309/375: card declined → createCharge throws BEFORE the success tx. Record a `failed`
    // payment row (FE try-again button + audit) then rethrow the SAME user-facing error.
    // Booking stays `accepted` (the confirm/held tx below never runs). Retry itself already
    // works via the non-blocking guard; this write is for the failed-state record.
    let chargeResult;
    try {
      chargeResult = await this.omiseService.createCharge(amountSatangs, omiseToken);
    } catch (err) {
      await this.recordFailedAuthorize(booking.id, existingPayment, user.id, err, {
        patientId: user.id,
        caregiverId: caregiver.userId,
        amountBaht,
        omiseToken,
      });
      throw err;
    }

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

    // PYG-374: refund logic ถูกรวมศูนย์ไว้ที่ RefundService (จุดเดียวที่เรียก Omise + คุมกฎเงิน)
    // guard เดิม (status/amount/race) ย้ายเข้า RefundService ทั้งหมด — wrapper บาง ๆ นี้คงไว้
    // เพื่อไม่ให้ GraphQL schema / FE เดิมพัง (source = admin_manual)
    const updated = await this.refundService.refund({
      paymentId: input.paymentId,
      amount: input.amount,
      reason: input.reason,
      source: 'admin_manual',
      actorId: admin.id,
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
