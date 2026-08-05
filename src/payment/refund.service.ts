/**
 * RefundService (PYG-374) — จุดเดียวของ refund logic ทั้งระบบ
 *
 * ทุกเส้นทางคืนเงิน (dispute / payout_exception / admin_manual / admin_override)
 * ต้องผ่าน refund() นี้ และนี่คือ "ที่เดียว" ที่เรียก omise.createRefund ได้
 * (constraint: grep createRefund ต้องเจอแค่ไฟล์นี้)
 *
 * กฎเงินที่รักษาไว้:
 * - ยอดคืนได้ = captured_amount − refunded_amount เสมอ (ไม่ใช่ amount เดี่ยว ๆ)
 * - refund ไม่ได้ถ้า payout ของ booking นั้นจ่ายให้ผู้ดูแลแล้ว/กำลังโอน (กัน double payment)
 * - เปลี่ยน payment_status ผ่าน PaymentStateMachine เท่านั้น (มี audit ทุกครั้ง)
 * - ทั้งก้อน (lock → guards → Omise 1 ครั้ง → update) อยู่ใน transaction เดียวที่ถือ
 *   SELECT … FOR UPDATE บนแถว payment → refund พร้อมกันบน payment เดียวถูก serialize
 */
import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Payment, Prisma } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../common/prisma.service';
import { PaymentStateMachine } from './payment-state-machine';
import { PaymentStatus } from './entities/payment-status.enum';
import { OmiseService } from './omise/omise.service';
import { IdempotencyService } from './idempotency.service';
import { BOOKING_EVENTS } from '../notification/events/booking-event';
import { PayoutStatus } from '../payout/entities/payout-status.enum';

/** ต้นทางของ refund — เก็บลง payment_status_history.metadata.source */
export type RefundSource =
  | 'dispute'
  | 'payout_exception'
  | 'admin_manual'
  | 'admin_override';

export interface RefundParams {
  paymentId: string;
  /** ไม่ระบุ = คืนยอดที่เหลือทั้งหมด (captured − refunded) */
  amount?: number;
  /** บังคับ, อย่างน้อย 10 ตัวอักษร */
  reason: string;
  source: RefundSource;
  actorId?: string;
}

const MIN_REASON_LENGTH = 10;

/** สถานะที่ยังคืนเงินต่อได้ */
const REFUNDABLE_STATUSES: PaymentStatus[] = [
  PaymentStatus.captured,
  PaymentStatus.partially_refunded,
];

/** payout สถานะที่ถือว่าเงินผูกกับผู้ดูแลแล้ว → refund อัตโนมัติไม่ได้ */
const PAYOUT_BLOCKING: PayoutStatus[] = [
  PayoutStatus.paid,
  PayoutStatus.processing,
];

@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fsm: PaymentStateMachine,
    private readonly omise: OmiseService,
    private readonly events: EventEmitter2,
    private readonly idempotency: IdempotencyService,
  ) {}

  async refund(params: RefundParams): Promise<Payment> {
    const { paymentId, source } = params;
    const reason = (params.reason ?? '').trim();

    // Guard 5 (fail fast ก่อน lock): reason บังคับ >= 10 ตัวอักษร
    if (reason.length < MIN_REASON_LENGTH) {
      throw new BadRequestException(
        `reason ต้องมีอย่างน้อย ${MIN_REASON_LENGTH} ตัวอักษร`,
      );
    }

    // ถือ lock คร่อม Omise HTTP → timeout ยาวขึ้น (refund เกิดไม่บ่อย + admin-driven)
    const result = await this.prisma.$transaction(
      async (tx) => {
        // Guard 1: SELECT … FOR UPDATE — ล็อคแถว payment กันคืนเงินพร้อมกัน
        await tx.$queryRaw`SELECT 1 FROM "payments" WHERE "id" = ${paymentId}::uuid FOR UPDATE`;
        const payment = await tx.payment.findUnique({ where: { id: paymentId } });
        if (!payment) throw new NotFoundException(`ไม่พบ payment "${paymentId}"`);

        const status = payment.paymentStatus as PaymentStatus;

        // Guard 2: สถานะต้องเป็น captured หรือ partially_refunded
        if (!REFUNDABLE_STATUSES.includes(status)) {
          throw new BadRequestException('ไม่สามารถคืนเงินได้ในสถานะนี้');
        }
        if (!payment.omiseChargeId) {
          throw new BadRequestException(
            'payment ไม่มี omiseChargeId — ไม่สามารถคืนเงินได้',
          );
        }

        // legacy guard: partially_refunded ที่ captured_amount = NULL คือแถวเก่าก่อน PYG-374
        // (refunded_amount ไม่เคยถูกติดตาม) → refund ต่อจะเสี่ยง double-refund → ให้ตรวจด้วยมือ
        if (
          status === PaymentStatus.partially_refunded &&
          payment.capturedAmount == null
        ) {
          throw new ConflictException(
            'payment นี้ถูกคืนเงินบางส่วนก่อนระบบใหม่ — ต้องตรวจสอบยอดด้วยมือผ่านช่องทาง admin',
          );
        }

        // ทำงานเป็น satangs (int) กัน float. capture เต็มจำนวนเสมอ (ไม่มี partial capture)
        // → captured_amount ที่ยังไม่ set ใช้ amount แทนได้ถูกต้อง และหัก refunded_amount เสมอ
        const capturedSatangs = this.toSatangs(
          payment.capturedAmount ?? payment.amount,
        );
        const refundedBeforeSatangs = this.toSatangs(payment.refundedAmount);
        const remainingSatangs = capturedSatangs - refundedBeforeSatangs;

        const isFull = params.amount === undefined;
        const refundSatangs = isFull
          ? remainingSatangs
          : Math.round(params.amount! * 100);

        // Guard 3: ยอดคืน <= captured − refunded (ไม่คำนวณจาก amount เดี่ยว ๆ)
        if (refundSatangs <= 0) {
          throw new BadRequestException('จำนวนเงินที่คืนต้องมากกว่า 0');
        }
        if (refundSatangs > remainingSatangs) {
          throw new BadRequestException('จำนวนเงินคืนเกินยอดที่เก็บได้');
        }

        // Guard 4: payout จ่าย/กำลังโอนให้ผู้ดูแลแล้ว → refund อัตโนมัติไม่ได้ (กัน double payment)
        const payout = await tx.payout.findUnique({
          where: { bookingId: payment.bookingId },
          select: { status: true },
        });
        if (payout && PAYOUT_BLOCKING.includes(payout.status as PayoutStatus)) {
          throw new ConflictException(
            'ค่าตอบแทนถูกโอน/กำลังโอนให้ผู้ดูแลแล้ว — คืนเงินอัตโนมัติไม่ได้ ' +
              'กรุณาใช้ช่องทาง admin (การเรียกคืนจากผู้ดูแลเป็นกระบวนการ manual)',
        );
        }

        // Omise refund — เรียก "ครั้งเดียว". idempotency key = refunded_amount ก่อนหน้า (satangs)
        // ยิงซ้ำด้วย state เดิม → Omise คืน cached ไม่ refund ซ้ำ
        const idempotencyKey = `refund:${paymentId}:${refundedBeforeSatangs}`;
        let omiseRefund: { id: string };
        try {
          // PYG-375: INSERT key ก่อน (PK ชนกัน → คืน stored result, ไม่ refund ซ้ำ) +
          // ส่ง key เป็น Omise header ด้วย. อยู่ใน tx เดียวกับ FOR UPDATE → rollback = ปลดคีย์
          omiseRefund = await this.idempotency.runOnce(
            {
              key: idempotencyKey,
              action: 'refund',
              bookingId: payment.bookingId,
              fn: (k) =>
                this.omise.createRefund(
                  payment.omiseChargeId!,
                  isFull ? undefined : refundSatangs,
                  k,
                ),
            },
            tx,
          );
        } catch (err) {
          if (err instanceof ConflictException) throw err; // in-flight → บอกให้ลองใหม่
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error(
            `[refund] Omise createRefund failed payment=${paymentId}: ${msg}`,
          );
          throw new ServiceUnavailableException(
            'ไม่สามารถดำเนินการคืนเงินได้ในขณะนี้ กรุณาลองใหม่ภายหลัง',
          );
        }

        const refundedAfterSatangs = refundedBeforeSatangs + refundSatangs;
        const target =
          refundedAfterSatangs >= capturedSatangs
            ? PaymentStatus.refunded
            : PaymentStatus.partially_refunded;

        const refundBaht = refundSatangs / 100;
        const metadata = {
          source,
          reason,
          actorId: params.actorId ?? null,
          amount: refundBaht,
          omiseRefundId: omiseRefund.id,
        };

        // เปลี่ยนสถานะ + เขียน history ผ่าน FSM (ประตูเดียว, audit ครบ source+reason)
        await this.fsm.transition(
          paymentId,
          target,
          { changedBy: params.actorId, reason, metadata },
          tx,
        );

        // persist refunded_amount (+ self-heal captured_amount) + merge metadata ให้ FE เห็น
        const existingMeta =
          payment.metadata &&
          typeof payment.metadata === 'object' &&
          !Array.isArray(payment.metadata)
            ? (payment.metadata as Record<string, unknown>)
            : {};
        const updated = await tx.payment.update({
          where: { id: paymentId },
          data: {
            capturedAmount: payment.capturedAmount ?? payment.amount,
            refundedAmount: refundedAfterSatangs / 100,
            metadata: { ...existingMeta, ...metadata } as Prisma.InputJsonValue,
          },
        });

        return {
          updated,
          omiseRefundId: omiseRefund.id,
          refundBaht,
          bookingId: payment.bookingId,
          patientId: payment.patientId,
          caregiverId: payment.caregiverId,
        };
      },
      { timeout: 20000 },
    );

    // emit หลัง commit — listener อ่าน booking ล่าสุดจาก DB
    this.events.emit(BOOKING_EVENTS.REFUND_ISSUED, {
      bookingId: result.bookingId,
      eventType: BOOKING_EVENTS.REFUND_ISSUED,
      patientId: result.patientId,
      caregiverId: result.caregiverId,
      metadata: {
        amount: result.refundBaht,
        omiseRefundId: result.omiseRefundId,
        source,
      },
    });

    return result.updated;
  }

  /** Decimal | number | string (THB) → satangs (int) กัน float precision */
  private toSatangs(v: Prisma.Decimal | number | string): number {
    const n =
      typeof v === 'number'
        ? v
        : typeof v === 'string'
          ? Number(v)
          : typeof (v as Prisma.Decimal).toNumber === 'function'
            ? (v as Prisma.Decimal).toNumber()
            : Number(v);
    return Math.round(n * 100);
  }
}
