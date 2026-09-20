/**
 * BookingSettlementService (PYG-461/462 เฟส 2) — ปิด booking ที่ยังไม่จบ + จัดการเงินที่ค้างให้ถูก
 *
 * core ร่วมของ PYG-461 (ผู้ป่วยยกเลิก) และ PYG-462 (ระบบปิดให้) — เฟสนี้ "ยังไม่มีใครเรียก"
 * (ไม่ export ออกจาก PaymentModule) เฟส 3a/3b จะต่อ flow เข้ามา
 *
 * Matrix เงิน (ตัดสินจากสถานะ payment "ใต้ lock" เท่านั้น):
 *   ไม่มี row / failed / expired / voided → ไม่แตะเงิน ปิด booking ได้เลย
 *   held (บัตร)                            → void ที่ Omise → voided
 *   captured                               → RefundService.refund() ตามนโยบาย → refunded / partially_refunded
 *   pending (PromptPay)                    → retrieveCharge นอก tx ก่อน:
 *        จ่ายแล้ว      → reuse PaymentService.captureFromWebhook (ห้ามเขียน capture ใหม่) → ทาง captured
 *        ตายที่ Omise  → pending → expired/failed (ตาม expires_at ผ่าน ClockService หรือ status ของ Omise)
 *        ยังสแกนได้    → 422 promptpay_still_scannable (ชั่วคราว ให้ประเมินใหม่รอบหน้า)
 *        retrieve พัง → 422 omise_unreachable (fail-closed: ไม่เปลี่ยนอะไรเลย)
 *   partially_refunded / refunded / transferred → 422 payment_not_settleable
 *
 * Concurrency (มติ 2026-09-11 — แพทเทิร์นเดียวกับ PYG-375 capture/refund):
 *   - ทั้งก้อน (lock → ตรวจ → Omise write 1 ครั้ง → FSM → booking → history) อยู่ใน $transaction เดียว
 *     Omise fail → rollback ทั้งก้อน → booking ไม่เปลี่ยน (ไม่มีทาง cancelled ทั้งที่เงินยังไม่คืน)
 *   - ★ LOCK ORDER ทั้ง repo: bookings → payments
 *       settle (ที่นี่) · CompleteBookingService.captureCardPayment · PaymentService.captureFromWebhook
 *       · createPayment/cancelBooking (UPDATE bookings ก่อน payments อยู่แล้ว)
 *       RefundService ล็อกแค่ payments (ใน settle เรียกหลังล็อก booking แล้ว)
 *   - HTTP ที่เป็น read (retrieveCharge) อยู่นอก tx; write (void/refund) อยู่ใน tx และมี timeout
 *     (OMISE_HTTP_TIMEOUT_MS 10s < SETTLEMENT_TX_TIMEOUT_MS 20s)
 *   - idempotent 3 ชั้น: (1) booking อยู่ในสถานะปลายทางแล้ว → คืน alreadySettled ไม่แตะเงิน
 *     (2) IdempotencyService.runOnce ของ PYG-375 (void:{chargeId} / refund:{paymentId}:{refundedBefore})
 *     (3) key เดียวกันส่งเป็น Omise-Idempotency-Key — ชั้นเดียวที่กันได้ถ้า tx rollback หลัง Omise สำเร็จ
 *
 * Event: ยิง PAYMENT_VOIDED / REFUND_ISSUED หลัง commit เท่านั้น
 *   แจ้งเตือนระดับ booking (ยกเลิก/หมดอายุ) เป็นหน้าที่ของผู้เรียกในเฟส 3 (ข้อความต่างกันตามสาเหตุ)
 */
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Payment, Prisma } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../common/prisma.service';
import { ClockService } from '../../common/clock.service';
import {
  BOOKING_EVENTS,
  type BookingEvent,
} from '../../notification/events/booking-event';
import { recordBookingStatusChange } from '../../booking/booking-status-history';
import { scheduledStartOf } from '../../monitoring/booking-schedule.util';
import { PayoutStatus } from '../../payout/entities/payout-status.enum';
import { PaymentStateMachine } from '../payment-state-machine';
import { PaymentStatus } from '../entities/payment-status.enum';
import { OmiseService } from '../omise/omise.service';
import { IdempotencyService } from '../idempotency.service';
import {
  PAYOUT_BLOCKING,
  RefundService,
  type RefundSource,
} from '../refund.service';
import { PaymentService } from '../payment.service';
import {
  CANCELLATION_POLICY,
  SETTLEMENT_TX_TIMEOUT_MS,
} from './cancellation-policy.config';
import {
  type Actor,
  type MoneyAction,
  SettlementBlockedError,
  SettlementReason,
  type SettlementResult,
} from './booking-settlement.types';

/**
 * ค่าเดียวกับ BookingStatusEnum.EXPIRED ใน PR phase-1 — สอง PR แยกกันจึง import ข้ามไม่ได้
 * TODO: หลัง merge ทั้งคู่ เปลี่ยนเป็น BookingStatusEnum.EXPIRED / CANCELLED
 */
const BOOKING_EXPIRED = 'expired';
const BOOKING_CANCELLED = 'cancelled';
const BOOKING_CONFIRMED = 'confirmed';

/** ผู้ป่วยยกเลิก = cancelled · ระบบปิดให้ = expired (นโยบายคืนเงินต่างกันในเฟส 3) */
const TARGET_STATUS: Record<SettlementReason, string> = {
  [SettlementReason.PATIENT_CANCEL]: BOOKING_CANCELLED,
  [SettlementReason.EXPIRED_NO_ACCEPT]: BOOKING_EXPIRED,
  [SettlementReason.EXPIRED_NO_PAYMENT]: BOOKING_EXPIRED,
  [SettlementReason.CAREGIVER_NO_SHOW]: BOOKING_EXPIRED,
};

/** booking สถานะไหนที่ reason นี้ปิดได้ — นอกเหนือจากนี้ = ใช้ reason ผิดที่ → 422 */
const SETTLEABLE_FROM: Record<SettlementReason, readonly string[]> = {
  [SettlementReason.PATIENT_CANCEL]: [
    'unmatched',
    'pending',
    'accepted',
    'confirmed',
  ],
  [SettlementReason.EXPIRED_NO_ACCEPT]: ['pending'],
  [SettlementReason.EXPIRED_NO_PAYMENT]: ['accepted'],
  [SettlementReason.CAREGIVER_NO_SHOW]: ['confirmed'],
};

/** ต้นทาง refund ที่เขียนลง payment_status_history.metadata.source */
const REFUND_SOURCE: Record<SettlementReason, RefundSource> = {
  [SettlementReason.PATIENT_CANCEL]: 'patient_cancel',
  [SettlementReason.EXPIRED_NO_ACCEPT]: 'booking_expired',
  [SettlementReason.EXPIRED_NO_PAYMENT]: 'booking_expired',
  [SettlementReason.CAREGIVER_NO_SHOW]: 'caregiver_no_show',
};

/** payment ที่ไม่มีเงินค้าง — ปิด booking ได้โดยไม่แตะเงิน */
const NO_MONEY: ReadonlySet<string> = new Set([
  PaymentStatus.failed,
  PaymentStatus.expired,
  PaymentStatus.voided,
]);

const HOUR_MS = 60 * 60 * 1000;

/** ผลจากการถาม Omise เรื่อง PromptPay ที่ค้าง pending (ทำนอก tx) */
type PromptPayPlan =
  | { kind: 'captured_now'; omiseChargeId: string }
  | {
      kind: 'dead';
      omiseChargeId: string;
      omiseStatus: string;
      expiresAt: string | null;
      target: PaymentStatus.expired | PaymentStatus.failed;
    };

type MoneyOutcome = {
  moneyAction: MoneyAction;
  paymentStatusAfter: string | null;
  refundAmount: number | null;
  refundPercentage: number | null;
  events: BookingEvent[];
};

/**
 * % ที่ต้องคืนตามนโยบาย (pure — แยกออกมาให้เทสขอบ cutoff ได้ตรง ๆ)
 * PATIENT_CANCEL: เหลือเวลาก่อนเริ่มงาน >= cutoff → 100 ไม่งั้นใช้ LATE_CANCELLATION_REFUND_PERCENTAGE
 */
export function refundPercentageFor(
  reason: SettlementReason,
  scheduledStart: Date,
  now: Date,
  policy: typeof CANCELLATION_POLICY = CANCELLATION_POLICY,
): number {
  switch (reason) {
    case SettlementReason.PATIENT_CANCEL: {
      const hoursBefore = (scheduledStart.getTime() - now.getTime()) / HOUR_MS;
      return hoursBefore >= policy.CANCELLATION_FULL_REFUND_CUTOFF_HOURS
        ? 100
        : policy.LATE_CANCELLATION_REFUND_PERCENTAGE;
    }
    case SettlementReason.CAREGIVER_NO_SHOW:
      return policy.CAREGIVER_NO_SHOW_REFUND_PERCENTAGE;
    default:
      return policy.SYSTEM_CLOSED_REFUND_PERCENTAGE;
  }
}

@Injectable()
export class BookingSettlementService {
  private readonly logger = new Logger(BookingSettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fsm: PaymentStateMachine,
    private readonly omise: OmiseService,
    private readonly idempotency: IdempotencyService,
    private readonly refunds: RefundService,
    private readonly payments: PaymentService,
    private readonly events: EventEmitter2,
    private readonly clock: ClockService,
  ) {}

  async settle(
    bookingId: string,
    reason: SettlementReason,
    actor: Actor,
  ): Promise<SettlementResult> {
    const target = TARGET_STATUS[reason];

    // ① อ่านแบบไม่ล็อก — ใช้ตัดสินใจเรื่อง HTTP ที่ต้องทำ "นอก tx" เท่านั้น ตัวจริงคือ re-read ใต้ lock
    const pre = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { payment: true },
    });
    if (!pre) throw new NotFoundException(`ไม่พบ booking "${bookingId}"`);
    if (pre.status === target) {
      return this.alreadySettled(
        bookingId,
        reason,
        target,
        pre.payment?.paymentStatus ?? null,
      );
    }
    this.assertSettleable(reason, pre.status, false);

    // ② PromptPay ค้าง pending → ถาม Omise นอก tx (read ไม่มี side effect) แล้วเลือกทาง
    const plan =
      pre.payment &&
      (pre.payment.paymentStatus as PaymentStatus) === PaymentStatus.pending
        ? await this.planPendingPromptPay(pre.payment)
        : null;

    // ③ critical section — ทุก write อยู่ใน tx เดียวที่ถือ lock booking → payment
    const outcome = await this.prisma.$transaction(
      (tx) => this.settleLocked(tx, bookingId, reason, actor, plan),
      { timeout: SETTLEMENT_TX_TIMEOUT_MS },
    );

    // ④ event หลัง commit เท่านั้น (listener อ่านข้อมูลที่ลงจริงแล้ว)
    for (const e of outcome.events) this.events.emit(e.eventType, e);

    this.logger.log({
      event: 'booking.settled',
      bookingId,
      reason,
      actorRole: actor.role,
      alreadySettled: outcome.result.alreadySettled,
      moneyAction: outcome.result.moneyAction,
    });
    return outcome.result;
  }

  // ── critical section ──────────────────────────────────────────────────────

  private async settleLocked(
    tx: Prisma.TransactionClient,
    bookingId: string,
    reason: SettlementReason,
    actor: Actor,
    plan: PromptPayPlan | null,
  ): Promise<{ result: SettlementResult; events: BookingEvent[] }> {
    const target = TARGET_STATUS[reason];

    // ★ LOCK ORDER: bookings → payments (ดูหัวไฟล์) — ห้ามสลับ ไม่งั้น deadlock กับ capture
    await tx.$queryRaw`SELECT 1 FROM "bookings" WHERE "id" = ${bookingId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT 1 FROM "payments" WHERE "booking_id" = ${bookingId}::uuid FOR UPDATE`;

    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, status: true, bookingDate: true, startTime: true },
    });
    if (!booking) throw new NotFoundException(`ไม่พบ booking "${bookingId}"`);

    const payment = await tx.payment.findUnique({ where: { bookingId } });
    const paymentStatusBefore = payment?.paymentStatus ?? null;

    // เรียกซ้ำ/ชนกัน: อีกตัวปิดไปแล้วระหว่างที่เรารอ lock → ไม่แตะเงินซ้ำ
    if (booking.status === target) {
      return {
        result: this.buildAlreadySettled(
          bookingId,
          reason,
          target,
          paymentStatusBefore,
        ),
        events: [],
      };
    }
    // captureFromWebhook (ที่เราเพิ่งเรียกใน ②) พลิก booking เป็น confirmed เสมอ → ยอมรับเฉพาะกรณีนั้น
    this.assertSettleable(
      reason,
      booking.status,
      plan?.kind === 'captured_now',
    );

    const now = this.clock.now();
    const money = await this.settleMoney(tx, {
      bookingId,
      reason,
      actor,
      plan,
      payment,
      scheduledStart: scheduledStartOf(booking.bookingDate, booking.startTime),
      now,
    });

    await tx.booking.update({
      where: { id: bookingId },
      data: { status: target, updatedAt: now },
    });

    await recordBookingStatusChange(tx, {
      bookingId,
      fromStatus: booking.status,
      toStatus: target,
      changedBy: actor.id,
      reason,
      metadata: {
        source: 'booking_settlement',
        actorRole: actor.role,
        moneyAction: money.moneyAction,
        paymentStatusBefore,
        paymentStatusAfter: money.paymentStatusAfter,
        refundAmount: money.refundAmount,
        refundPercentage: money.refundPercentage,
        promptpayLateCapture: plan?.kind === 'captured_now',
      },
    });

    return {
      result: {
        bookingId,
        reason,
        alreadySettled: false,
        bookingStatusBefore: booking.status,
        bookingStatusAfter: target,
        moneyAction: money.moneyAction,
        paymentStatusBefore,
        paymentStatusAfter: money.paymentStatusAfter,
        refundAmount: money.refundAmount,
        refundPercentage: money.refundPercentage,
      },
      events: money.events,
    };
  }

  /** matrix เงิน — ตัดสินจากสถานะ payment ที่อ่าน "ใต้ lock" (ผล retrieve ใช้เลือกทางเท่านั้น) */
  private async settleMoney(
    tx: Prisma.TransactionClient,
    ctx: {
      bookingId: string;
      reason: SettlementReason;
      actor: Actor;
      plan: PromptPayPlan | null;
      payment: Payment | null;
      scheduledStart: Date;
      now: Date;
    },
  ): Promise<MoneyOutcome> {
    const { payment } = ctx;
    const none = (after: string | null): MoneyOutcome => ({
      moneyAction: 'none',
      paymentStatusAfter: after,
      refundAmount: null,
      refundPercentage: null,
      events: [],
    });

    if (!payment) return none(null);
    const status = payment.paymentStatus as PaymentStatus;
    if (NO_MONEY.has(status)) return none(status);

    switch (status) {
      case PaymentStatus.pending:
        return this.expirePendingPromptPay(tx, ctx, payment);
      case PaymentStatus.held:
        return this.voidHeld(tx, ctx, payment);
      case PaymentStatus.captured:
        return this.refundCaptured(tx, ctx, payment);
      default:
        // partially_refunded / refunded / transferred — มีคนจัดการเงินก้อนนี้ไปแล้ว ห้ามเดาต่อ
        throw new SettlementBlockedError(
          'payment_not_settleable',
          status === PaymentStatus.transferred
            ? 'เงินของงานนี้โอนให้ผู้ดูแลแล้ว (transferred) — ปิด/คืนเงินอัตโนมัติไม่ได้ ต้องให้แอดมินตัดสิน'
            : `payment อยู่ในสถานะ ${status} (มีการคืนเงินไปแล้ว) — settle อัตโนมัติไม่ได้ ต้องให้แอดมินตรวจยอด`,
          { paymentId: payment.id, paymentStatus: status },
        );
    }
  }

  /** pending: ทำได้เฉพาะเมื่อ Omise ยืนยันแล้วว่า QR ตาย (plan มาจาก ② นอก tx) */
  private async expirePendingPromptPay(
    tx: Prisma.TransactionClient,
    ctx: { reason: SettlementReason; actor: Actor; plan: PromptPayPlan | null },
    payment: Payment,
  ): Promise<MoneyOutcome> {
    const { plan } = ctx;
    // ไม่มี plan (payment เพิ่งกลายเป็น pending หลัง ①) / captureFromWebhook ไม่ได้พลิกจริง /
    // QR ถูกสร้างใหม่ (chargeId เปลี่ยน) → ข้อมูลที่ใช้ตัดสินใจเก่าแล้ว ห้ามทำต่อ
    if (
      !plan ||
      plan.kind !== 'dead' ||
      plan.omiseChargeId !== payment.omiseChargeId
    ) {
      throw new SettlementBlockedError(
        'state_changed_retry',
        'สถานะ PromptPay เปลี่ยนระหว่างตรวจสอบ — ไม่เปลี่ยนสถานะใด ๆ ให้เรียกใหม่อีกครั้ง',
        {
          paymentId: payment.id,
          omiseChargeId: payment.omiseChargeId,
          planKind: plan?.kind ?? null,
        },
      );
    }

    await this.fsm.transition(
      payment.id,
      plan.target,
      {
        changedBy: ctx.actor.id ?? undefined,
        reason: `booking settlement (${ctx.reason}): PromptPay ไม่ได้จ่ายและหมดอายุ/ล้มเหลวที่ Omise แล้ว`,
        metadata: {
          source: 'booking_settlement',
          settlementReason: ctx.reason,
          omiseChargeId: plan.omiseChargeId,
          omiseStatus: plan.omiseStatus,
          expiresAt: plan.expiresAt,
        },
      },
      tx,
    );
    return {
      moneyAction: 'promptpay_expired',
      paymentStatusAfter: plan.target,
      refundAmount: null,
      refundPercentage: null,
      events: [],
    };
  }

  /**
   * held (บัตร): void ทั้งก้อน — ลำดับเดียวกับ void ของ PYG-286 (booking.service.ts cancelBooking)
   * voidCharge → FSM held→voided → PAYMENT_VOIDED ต่างกันที่ย้ายมาอยู่ใน tx + runOnce ตามมติ
   */
  private async voidHeld(
    tx: Prisma.TransactionClient,
    ctx: {
      bookingId: string;
      reason: SettlementReason;
      actor: Actor;
      scheduledStart: Date;
      now: Date;
    },
    payment: Payment,
  ): Promise<MoneyOutcome> {
    const pct = this.policyPercentage(ctx.reason, ctx.scheduledStart, ctx.now);
    if (pct !== 100) {
      throw new SettlementBlockedError(
        'policy_not_supported',
        `นโยบายคืน ${pct}% ใช้กับบัตรที่กันวงเงินไว้ (held) ไม่ได้ — void ได้ทั้งก้อนเท่านั้น (ต้อง capture บางส่วนก่อน ซึ่งยังไม่มี)`,
        { paymentId: payment.id, refundPercentage: pct },
      );
    }
    if (!payment.omiseChargeId) {
      throw new SettlementBlockedError(
        'payment_not_settleable',
        'payment held แต่ไม่มี omiseChargeId — void ที่ Omise ไม่ได้ ต้องให้แอดมินตรวจ',
        { paymentId: payment.id },
      );
    }
    const chargeId = payment.omiseChargeId;

    try {
      // PYG-375: key ต่อ charge (ไม่ใช่ต่อ payment — แถว payment ถูกใช้ซ้ำตอนจ่ายใหม่ chargeId เปลี่ยน)
      await this.idempotency.runOnce(
        {
          key: `void:${chargeId}`,
          action: 'void',
          bookingId: ctx.bookingId,
          fn: (k) => this.omise.voidCharge(chargeId, k),
        },
        tx,
      );
    } catch (err) {
      if (err instanceof ConflictException) throw err; // in-flight → ให้ลองใหม่
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[settle] Omise void failed chargeId=${chargeId}: ${msg}`,
      );
      throw new ServiceUnavailableException(
        'ไม่สามารถยกเลิกการกันวงเงินได้ในขณะนี้ กรุณาลองใหม่ภายหลัง',
      );
    }

    await this.fsm.transition(
      payment.id,
      PaymentStatus.voided,
      {
        changedBy: ctx.actor.id ?? undefined,
        reason: `booking settlement (${ctx.reason})`,
        metadata: {
          source: 'booking_settlement',
          settlementReason: ctx.reason,
          omiseChargeId: chargeId,
          voidedAt: ctx.now.toISOString(),
        },
      },
      tx,
    );

    return {
      moneyAction: 'voided',
      paymentStatusAfter: PaymentStatus.voided,
      refundAmount: null,
      refundPercentage: 100,
      events: [
        {
          bookingId: ctx.bookingId,
          eventType: BOOKING_EVENTS.PAYMENT_VOIDED,
          patientId: payment.patientId,
          caregiverId: payment.caregiverId,
          metadata: {
            amount: payment.amount,
            omiseChargeId: chargeId,
            source: 'booking_settlement',
            settlementReason: ctx.reason,
          },
        },
      ],
    };
  }

  /** captured: คืนผ่าน RefundService (จุดเดียวที่เรียก createRefund) บน tx เดียวกัน */
  private async refundCaptured(
    tx: Prisma.TransactionClient,
    ctx: {
      bookingId: string;
      reason: SettlementReason;
      actor: Actor;
      scheduledStart: Date;
      now: Date;
    },
    payment: Payment,
  ): Promise<MoneyOutcome> {
    // payout ออกไปแล้ว/กำลังโอน → คืนอัตโนมัติไม่ได้ (product decision แยก — ไม่ตัดสินเอง)
    // RefundService ก็บล็อกเคสนี้อยู่แล้ว แต่ตรวจก่อนเพื่อคืน error ที่บอกได้ว่าติด payout ใบไหน
    const payout = await tx.payout.findUnique({
      where: { bookingId: ctx.bookingId },
      select: { id: true, status: true },
    });
    if (payout && PAYOUT_BLOCKING.includes(payout.status as PayoutStatus)) {
      throw new SettlementBlockedError(
        'payout_already_released',
        `ค่าตอบแทนของงานนี้ถูกโอน/กำลังโอนให้ผู้ดูแลแล้ว (payout ${payout.status}) — คืนเงินอัตโนมัติไม่ได้ ต้องให้แอดมินตัดสิน`,
        {
          paymentId: payment.id,
          payoutId: payout.id,
          payoutStatus: payout.status,
        },
      );
    }

    const pct = this.policyPercentage(ctx.reason, ctx.scheduledStart, ctx.now);
    if (pct === 0) {
      return {
        moneyAction: 'none',
        paymentStatusAfter: payment.paymentStatus,
        refundAmount: null,
        refundPercentage: 0,
        events: [],
      };
    }

    const capturedSatangs = toSatangs(payment.capturedAmount ?? payment.amount);
    const refundedBeforeSatangs = toSatangs(payment.refundedAmount);
    // 100% → ไม่ส่ง amount = RefundService คืน "ยอดที่เหลือทั้งหมด" (captured − refunded) เอง
    const amount =
      pct === 100 ? undefined : Math.round((capturedSatangs * pct) / 100) / 100;

    const source = REFUND_SOURCE[ctx.reason];
    const updated = await this.refunds.refund(
      {
        paymentId: payment.id,
        amount,
        reason: `booking settlement: ${ctx.reason}`,
        source,
        actorId: ctx.actor.id ?? undefined,
      },
      tx, // ★ ส่ง tx → RefundService ไม่เปิด tx ซ้อน และไม่ emit (เรา emit เองหลัง commit)
    );

    const refundBaht =
      (toSatangs(updated.refundedAmount) - refundedBeforeSatangs) / 100;
    const meta =
      updated.metadata &&
      typeof updated.metadata === 'object' &&
      !Array.isArray(updated.metadata)
        ? (updated.metadata as Record<string, unknown>)
        : {};

    return {
      moneyAction: 'refunded',
      paymentStatusAfter: updated.paymentStatus,
      refundAmount: refundBaht,
      refundPercentage: pct,
      events: [
        {
          bookingId: ctx.bookingId,
          eventType: BOOKING_EVENTS.REFUND_ISSUED,
          patientId: payment.patientId,
          caregiverId: payment.caregiverId,
          metadata: {
            amount: refundBaht,
            omiseRefundId: meta.omiseRefundId ?? null,
            source,
          },
        },
      ],
    };
  }

  // ── PromptPay pending (นอก tx) ─────────────────────────────────────────────

  /**
   * ถาม Omise ว่า QR ที่ค้างอยู่เป็นยังไง — read ล้วน ไม่มี lock ไม่มี tx
   * ผลใช้ "เลือกทาง" เท่านั้น การเขียนจริงตัดสินใหม่ใต้ lock ใน settleLocked
   */
  private async planPendingPromptPay(payment: Payment): Promise<PromptPayPlan> {
    if (payment.paymentMethod !== 'promptpay' || !payment.omiseChargeId) {
      throw new SettlementBlockedError(
        'payment_not_settleable',
        'payment ค้าง pending แต่ไม่ใช่ PromptPay หรือไม่มี charge id — ตรวจสถานะกับ Omise ไม่ได้',
        { paymentId: payment.id, paymentMethod: payment.paymentMethod },
      );
    }
    const chargeId = payment.omiseChargeId;

    let charge: Awaited<ReturnType<OmiseService['retrieveCharge']>>;
    try {
      charge = await this.omise.retrieveCharge(chargeId);
    } catch (err) {
      // fail-closed: ห้ามเดาว่าหมดอายุ ห้ามปิด booking
      const msg = err instanceof Error ? err.message : String(err);
      throw new SettlementBlockedError(
        'omise_unreachable',
        'ติดต่อ Omise เพื่อตรวจสถานะ PromptPay ไม่ได้ — ไม่เปลี่ยนสถานะใด ๆ ลองใหม่ภายหลัง',
        { omiseChargeId: chargeId, error: msg },
      );
    }

    if (charge.paid) {
      // จ่ายแล้ว (webhook ยังไม่มา/หาย) — reuse routine เดียวกับ webhook ห้ามเขียน capture ขึ้นมาใหม่
      await this.payments.captureFromWebhook(chargeId);
      return { kind: 'captured_now', omiseChargeId: chargeId };
    }

    const expiresAt = charge.expiresAt ?? null;
    const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
    const pastExpiry =
      Number.isFinite(expiresAtMs) && this.clock.now().getTime() >= expiresAtMs;

    if (
      charge.status === 'expired' ||
      charge.status === 'failed' ||
      pastExpiry
    ) {
      return {
        kind: 'dead',
        omiseChargeId: chargeId,
        omiseStatus: charge.status,
        expiresAt,
        target:
          charge.status === 'failed'
            ? PaymentStatus.failed
            : PaymentStatus.expired,
      };
    }

    throw new SettlementBlockedError(
      'promptpay_still_scannable',
      expiresAt
        ? `QR PromptPay ยังสแกนจ่ายได้ถึง ${expiresAt} — ยังปิด booking ไม่ได้ ให้ประเมินใหม่รอบหน้า`
        : 'QR PromptPay ยังไม่หมดอายุ (Omise ไม่ส่ง expires_at) — ยังปิด booking ไม่ได้ ให้ประเมินใหม่รอบหน้า',
      { omiseChargeId: chargeId, omiseStatus: charge.status, expiresAt },
    );
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  private assertSettleable(
    reason: SettlementReason,
    status: string,
    capturedNow: boolean,
  ): void {
    const allowed = capturedNow
      ? [...SETTLEABLE_FROM[reason], BOOKING_CONFIRMED]
      : SETTLEABLE_FROM[reason];
    if (!allowed.includes(status)) {
      throw new SettlementBlockedError(
        'booking_not_settleable',
        `booking สถานะ "${status}" ปิดด้วยเหตุผล ${reason} ไม่ได้`,
        { bookingStatus: status, reason, allowed },
      );
    }
  }

  /** % ตามนโยบาย + ตรวจค่าคอนฟิกให้อยู่ในช่วงที่รองรับจริงก่อนเงินจะขยับ */
  private policyPercentage(
    reason: SettlementReason,
    scheduledStart: Date,
    now: Date,
  ): number {
    if (CANCELLATION_POLICY.OMISE_FEE_BORNE_BY !== 'platform') {
      throw new SettlementBlockedError(
        'policy_not_supported',
        'OMISE_FEE_BORNE_BY=patient ยังไม่รองรับ (ต้องรู้อัตราค่าธรรมเนียมจริง) — ไม่คืนเงินแบบเดาตัวเลข',
        { omiseFeeBorneBy: CANCELLATION_POLICY.OMISE_FEE_BORNE_BY },
      );
    }
    const pct = refundPercentageFor(reason, scheduledStart, now);
    if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
      throw new SettlementBlockedError(
        'policy_not_supported',
        `ค่า % คืนเงินในคอนฟิกไม่ถูกต้อง (${pct}) — ต้องเป็นจำนวนเต็ม 0–100`,
        { reason, refundPercentage: pct },
      );
    }
    return pct;
  }

  private async alreadySettled(
    bookingId: string,
    reason: SettlementReason,
    target: string,
    paymentStatus: string | null,
  ): Promise<SettlementResult> {
    this.logger.log({
      event: 'booking.settle_already_done',
      bookingId,
      reason,
    });
    return Promise.resolve(
      this.buildAlreadySettled(bookingId, reason, target, paymentStatus),
    );
  }

  private buildAlreadySettled(
    bookingId: string,
    reason: SettlementReason,
    target: string,
    paymentStatus: string | null,
  ): SettlementResult {
    return {
      bookingId,
      reason,
      alreadySettled: true,
      bookingStatusBefore: target,
      bookingStatusAfter: target,
      moneyAction: 'none',
      paymentStatusBefore: paymentStatus,
      paymentStatusAfter: paymentStatus,
      refundAmount: null,
      refundPercentage: null,
    };
  }
}

/** Decimal | number | string (THB) → satangs (int) กัน float — สูตรเดียวกับ RefundService */
function toSatangs(v: Prisma.Decimal | number | string): number {
  const n = typeof v === 'object' ? v.toNumber() : Number(v);
  return Math.round(n * 100);
}
