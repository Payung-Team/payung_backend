import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { ROLE_ID } from '../common/constants/roles.constant';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { PaymentStatus } from './entities/payment-status.enum';
import { PaymentStatusHistory } from './entities/payment-status-history.entity';
import { PaymentStateMachine } from './payment-state-machine';
import { Payment, PaymentStatusEnum } from './dto/payment.type';
import { PaymentConnection } from './dto/payment-connection.type';
import { AdminPaymentsInput } from './dto/admin-payments.input';
import { CreatePaymentInput } from './dto/create-payment.input';
import { OmiseService, mapOmiseFailureCode } from './omise.service';

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

/** network-layer errors that warrant a single retry */
function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('timeout') || msg.includes('econnreset') || msg.includes('enotfound');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fsm: PaymentStateMachine,
    private readonly omise: OmiseService,
  ) {}

  // ── PYG-264: createPayment mutation ──────────────────────────────────────

  /**
   * สร้างการชำระเงินผ่าน Omise (authorize/hold เท่านั้น — capture:false)
   *
   * ขั้นตอน:
   *  1) advisory lock + validate booking (accepted, patient match, no duplicate)
   *  2) recalc amount server-side (hours × hourlyRate) → satangs
   *  3) insert payment record (pending) inside locked tx
   *  4) call Omise outside tx (retry 1x on network error)
   *  5) atomic tx: transition pending→held + update omiseChargeId + set booking=confirmed
   *     OR: transition pending→failed + store failure details
   */
  async createPayment(input: CreatePaymentInput, user: AuthUser): Promise<Payment> {
    // ── Phase 1: Validate + advisory lock + insert pending payment ─────────
    const { paymentId, amountSatangs, bookingId } =
      await this.prisma.$transaction(async (tx) => {
        // Advisory lock — prevents two concurrent createPayment calls for the same booking
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.bookingId}))`;

        // Load booking + caregiver in one query
        const booking = await tx.booking.findUnique({
          where: { id: input.bookingId },
          include: {
            caregiver: { select: { id: true, hourlyRate: true, userId: true } },
          },
        });

        if (!booking) {
          throw new NotFoundException(`ไม่พบ booking "${input.bookingId}"`);
        }
        if (booking.status !== 'accepted') {
          throw new BadRequestException(
            `booking ต้องมีสถานะ "accepted" ก่อนชำระเงิน (สถานะปัจจุบัน: ${booking.status})`,
          );
        }
        if (booking.patientId !== user.id) {
          throw new ForbiddenException('คุณไม่มีสิทธิ์ชำระเงินสำหรับ booking นี้');
        }
        if (!booking.caregiver || !booking.caregiverId) {
          throw new BadRequestException('booking ยังไม่มี caregiver — ไม่สามารถชำระเงินได้');
        }
        if (!booking.caregiver.hourlyRate) {
          throw new BadRequestException('caregiver ยังไม่ได้ตั้งอัตราค่าจ้าง');
        }

        // Check duplicate payment
        const existing = await tx.payment.findUnique({ where: { bookingId: input.bookingId } });
        if (existing) {
          throw new ConflictException('มีการชำระเงินสำหรับ booking นี้อยู่แล้ว');
        }

        // Recalc amount server-side (never trust client amount)
        const durationHours = Number(booking.durationHours);
        const hourlyRate = booking.caregiver.hourlyRate;
        const amountThb = Math.round(durationHours * hourlyRate * 100) / 100; // 2 decimal places
        const amountSatangs = Math.round(amountThb * 100); // convert to satangs

        // Insert payment (pending) + initial history
        const payment = await tx.payment.create({
          data: {
            bookingId:     input.bookingId,
            patientId:     booking.patientId,
            caregiverId:   booking.caregiver.userId, // FK to users.id not caregivers.id
            amount:        amountThb,
            currency:      'THB',
            omiseToken:    input.omiseToken,
            paymentMethod: input.paymentMethod,
            paymentStatus: PaymentStatus.pending,
            metadata:      {},
          },
        });

        await tx.paymentStatusHistory.create({
          data: {
            paymentId:  payment.id,
            fromStatus: null,
            toStatus:   PaymentStatus.pending,
            changedBy:  user.id,
            reason:     'createPayment mutation',
          },
        });

        return {
          paymentId:    payment.id,
          amountSatangs,
          bookingId:    input.bookingId,
        };
      }); // advisory lock released here

    // ── Phase 2 / 3: branch on payment method ─────────────────────────────
    if (input.paymentMethod === 'promptpay') {
      return this.finalisePromptPay(paymentId, amountSatangs, user);
    }

    // ── Phase 2: Call Omise (outside DB transaction) — credit / debit card ──
    // omiseToken is guaranteed non-null here (ValidateIf on the DTO)
    const cardToken = input.omiseToken ?? '';
    let charge: Awaited<ReturnType<OmiseService['createCharge']>> | undefined;
    let omiseError: Error | undefined;

    try {
      charge = await this.omise.createCharge({
        amount:   amountSatangs,
        currency: 'thb',
        card:     cardToken,
        capture:  false,
      });
    } catch (err) {
      if (isNetworkError(err)) {
        this.logger.warn(`[createPayment] network error, retrying once… (${(err as Error).message})`);
        await sleep(1500);
        try {
          charge = await this.omise.createCharge({
            amount:   amountSatangs,
            currency: 'thb',
            card:     cardToken,
            capture:  false,
          });
        } catch (retryErr) {
          omiseError = retryErr as Error;
        }
      } else {
        omiseError = err as Error;
      }
    }

    // ── Phase 3a: Omise call failed entirely (network / SDK error) ─────────
    if (omiseError && !charge) {
      await this.markFailed(paymentId, {
        failureCode:    'network_error',
        failureMessage: omiseError.message,
        changedBy:      user.id,
      });
      throw new ServiceUnavailableException(
        'ไม่สามารถเชื่อมต่อระบบชำระเงินได้ในขณะนี้ กรุณาลองใหม่ภายหลัง',
      );
    }

    // ── Phase 3b: Omise returned a charge but it failed ───────────────────
    if (!charge || charge.status === 'failed' || (!charge.authorized && !charge.captured)) {
      const failureCode    = charge?.failure_code    ?? 'payment_rejected';
      const failureMessage = charge?.failure_message ?? 'Omise returned unsuccessful charge';

      await this.markFailed(paymentId, {
        failureCode,
        failureMessage,
        omiseChargeId: charge?.id,
        changedBy:     user.id,
      });

      throw new BadRequestException(mapOmiseFailureCode(failureCode));
    }

    // ── Phase 3c: Success — transition to held + update booking ───────────
    const updated = await this.prisma.$transaction(async (tx) => {
      // Inline FSM transition (pending → held) so we can bundle the other updates
      await tx.payment.update({
        where: { id: paymentId },
        data: {
          paymentStatus: PaymentStatus.held,
          omiseChargeId: charge.id,
          updatedAt:     new Date(),
        },
      });

      await tx.paymentStatusHistory.create({
        data: {
          paymentId,
          fromStatus: PaymentStatus.pending,
          toStatus:   PaymentStatus.held,
          changedBy:  user.id,
          metadata:   { omiseChargeId: charge.id, amountSatangs },
        },
      });

      await tx.booking.update({
        where: { id: bookingId },
        data:  { status: 'confirmed', confirmedAt: new Date() },
      });

      return tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    });

    this.logger.log(
      `[createPayment] success paymentId=${paymentId} chargeId=${charge.id} amount=${amountSatangs}sth`,
    );

    return this.toGql(updated);
  }

  // ── PromptPay: create QR charge + keep payment pending ──────────────────

  private async finalisePromptPay(
    paymentId: string,
    amountSatangs: number,
    user: AuthUser,
  ): Promise<Payment> {
    let charge: Awaited<ReturnType<OmiseService['createPromptPayCharge']>> | undefined;
    let omiseError: Error | undefined;

    try {
      charge = await this.omise.createPromptPayCharge({ amount: amountSatangs, currency: 'thb' });
    } catch (err) {
      if (isNetworkError(err)) {
        this.logger.warn(`[createPayment/promptpay] network error, retrying once…`);
        await sleep(1500);
        try {
          charge = await this.omise.createPromptPayCharge({ amount: amountSatangs, currency: 'thb' });
        } catch (retryErr) {
          omiseError = retryErr as Error;
        }
      } else {
        omiseError = err as Error;
      }
    }

    if (omiseError && !charge) {
      await this.markFailed(paymentId, {
        failureCode:    'network_error',
        failureMessage: omiseError.message,
        changedBy:      user.id,
      });
      throw new ServiceUnavailableException(
        'ไม่สามารถเชื่อมต่อระบบชำระเงินได้ในขณะนี้ กรุณาลองใหม่ภายหลัง',
      );
    }

    if (!charge || charge.status === 'failed') {
      await this.markFailed(paymentId, {
        failureCode:    charge?.failure_code    ?? 'payment_rejected',
        failureMessage: charge?.failure_message ?? 'PromptPay charge failed',
        omiseChargeId:  charge?.id,
        changedBy:      user.id,
      });
      throw new BadRequestException('ไม่สามารถสร้าง QR Code ได้ กรุณาลองใหม่');
    }

    const qrCodeUrl = charge.source?.scannable_code?.image?.download_uri;

    // Store chargeId + QR URL in metadata; payment stays 'pending' until webhook fires
    const updated = await this.prisma.payment.update({
      where: { id: paymentId },
      data:  {
        omiseChargeId: charge.id,
        metadata:      { omiseChargeId: charge.id, qrCodeUrl, amountSatangs },
        updatedAt:     new Date(),
      },
    });

    this.logger.log(
      `[createPayment/promptpay] QR created paymentId=${paymentId} chargeId=${charge.id}`,
    );
    return this.toGql(updated);
  }

  // ── Webhook helpers (called from OmiseController) ────────────────────────

  async captureFromWebhook(omiseChargeId: string): Promise<void> {
    const payment = await this.prisma.payment.findFirst({
      where: { omiseChargeId },
    });
    if (!payment) {
      this.logger.warn(`[webhook] charge.complete: no payment found for chargeId=${omiseChargeId}`);
      return;
    }

    const currentStatus = payment.paymentStatus as PaymentStatus;
    const isCard      = currentStatus === PaymentStatus.held;
    const isPromptPay = currentStatus === PaymentStatus.pending;

    if (!isCard && !isPromptPay) {
      this.logger.warn(
        `[webhook] charge.complete: payment ${payment.id} in unexpected status ${payment.paymentStatus}`,
      );
      return;
    }

    await this.fsm.transition(payment.id, PaymentStatus.captured, {
      reason:   'charge.complete webhook',
      metadata: { omiseChargeId, capturedAt: new Date().toISOString() },
    });

    // PromptPay was never confirmed at charge-creation time — do it now
    if (isPromptPay) {
      await this.prisma.booking.update({
        where: { id: payment.bookingId },
        data:  { status: 'confirmed', confirmedAt: new Date() },
      });
    }

    this.logger.log(`[webhook] payment ${payment.id} → captured (via ${isPromptPay ? 'promptpay' : 'card'})`);
  }

  async voidFromWebhook(omiseChargeId: string): Promise<void> {
    const payment = await this.prisma.payment.findFirst({
      where: { omiseChargeId },
    });
    if (!payment) {
      this.logger.warn(`[webhook] charge.reverse: no payment found for chargeId=${omiseChargeId}`);
      return;
    }
    if ((payment.paymentStatus as PaymentStatus) !== PaymentStatus.held) {
      this.logger.warn(
        `[webhook] charge.reverse: payment ${payment.id} not in held status (${payment.paymentStatus})`,
      );
      return;
    }
    await this.fsm.transition(payment.id, PaymentStatus.voided, {
      reason:   'charge.reverse webhook',
      metadata: { omiseChargeId, voidedAt: new Date().toISOString() },
    });
    this.logger.log(`[webhook] payment ${payment.id} → voided`);
  }

  async refundFromWebhook(
    omiseChargeId: string,
    refundData: { refundId?: string; amount?: number },
  ): Promise<void> {
    const payment = await this.prisma.payment.findFirst({
      where: { omiseChargeId },
    });
    if (!payment) {
      this.logger.warn(`[webhook] refund.create: no payment found for chargeId=${omiseChargeId}`);
      return;
    }

    // Partial refund if refund amount < payment amount (×100 converts THB → satangs)
    const paymentSatangs = Math.round(Number(payment.amount) * 100);
    const isPartial =
      refundData.amount !== undefined && refundData.amount < paymentSatangs;

    const targetStatus = isPartial
      ? PaymentStatus.partially_refunded
      : PaymentStatus.refunded;

    const current = payment.paymentStatus as PaymentStatus;
    if (!this.fsm.canTransition(current, targetStatus)) {
      this.logger.warn(
        `[webhook] refund.create: cannot transition ${current} → ${targetStatus} for payment ${payment.id}`,
      );
      return;
    }

    await this.fsm.transition(payment.id, targetStatus, {
      reason:   'refund.create webhook',
      metadata: {
        omiseChargeId,
        omiseRefundId: refundData.refundId,
        refundAmountSatangs: refundData.amount,
        refundedAt: new Date().toISOString(),
      },
    });
    this.logger.log(`[webhook] payment ${payment.id} → ${targetStatus}`);
  }

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
    const isAdmin = user.role >= ROLE_ID.ADMIN;
    if (!isParty && !isAdmin) {
      throw new ForbiddenException('คุณไม่มีสิทธิ์ดูประวัติการชำระเงินนี้');
    }

    const rows = await this.prisma.paymentStatusHistory.findMany({
      where: { paymentId },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((row) => this.mapHistoryRow(row as PrismaHistoryRow));
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

    const updated = await this.fsm.transition(paymentId, PaymentStatus.transferred, {
      changedBy: adminId,
      reason:    notes,
      metadata:  { transferRef, transferredAt: new Date().toISOString() },
    });

    await this.prisma.payment.update({
      where: { id: paymentId },
      data: {
        metadata: {
          ...(updated.metadata === null ? undefined : (updated.metadata as Record<string, unknown>)),
          transferRef,
          adminId,
        },
      },
    });

    this.logger.log(JSON.stringify({
      event: 'payment.transferred',
      payload: {
        paymentId,
        caregiverId: updated.caregiverId,
        bookingId:   updated.bookingId,
        amount:      Number(updated.amount),
      },
    }));

    return this.toGql(updated);
  }

  async adminPayments(input: AdminPaymentsInput): Promise<PaymentConnection> {
    const page   = Math.max(1, input.page  ?? 1);
    const limit  = Math.min(100, Math.max(1, input.limit ?? 20));
    const status = (input.status ?? PaymentStatusEnum.captured) as PaymentStatus;
    const offset = (page - 1) * limit;

    const where = { paymentStatus: status };

    const [items, totalCount] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip:    offset,
        take:    limit,
      }),
      this.prisma.payment.count({ where }),
    ]);

    return {
      nodes:       items.map((p) => this.toGql(p)),
      totalCount,
      page,
      limit,
      hasNextPage: offset + limit < totalCount,
    };
  }

  // ── Query by booking (for frontend polling) ─────────────────────────────
  // For pending PromptPay payments, we also reconcile against Omise's charge API
  // so the status updates even when webhooks can't reach localhost (e.g. ngrok expired).

  async getPaymentByBooking(bookingId: string, user: AuthUser): Promise<Payment | null> {
    const payment = await this.prisma.payment.findFirst({
      where:   { bookingId },
      orderBy: { createdAt: 'desc' },
    });
    if (!payment) return null;

    const isParty = payment.patientId === user.id || payment.caregiverId === user.id;
    const isAdmin = user.role >= ROLE_ID.ADMIN;
    if (!isParty && !isAdmin) {
      throw new ForbiddenException('คุณไม่มีสิทธิ์ดูข้อมูลการชำระเงินนี้');
    }

    // Reconcile: if PromptPay charge is still pending, ask Omise directly
    if (
      (payment.paymentStatus as PaymentStatus) === PaymentStatus.pending &&
      payment.paymentMethod === 'promptpay' &&
      payment.omiseChargeId
    ) {
      try {
        const charge = await this.omise.retrieveCharge(payment.omiseChargeId);
        if (charge.status === 'successful' || charge.captured) {
          // Trigger the same flow as webhook charge.complete
          await this.captureFromWebhook(payment.omiseChargeId);
          // Re-fetch the updated payment
          const updated = await this.prisma.payment.findUniqueOrThrow({
            where: { id: payment.id },
          });
          return this.toGql(updated);
        }
        if (charge.status === 'failed') {
          await this.markFailed(payment.id, {
            failureCode:    charge.failure_code    ?? 'payment_rejected',
            failureMessage: charge.failure_message ?? 'PromptPay charge failed',
            omiseChargeId:  charge.id,
          });
          const updated = await this.prisma.payment.findUniqueOrThrow({
            where: { id: payment.id },
          });
          return this.toGql(updated);
        }
      } catch (err) {
        // Don't fail the poll request if Omise is unreachable — return current DB state
        this.logger.warn(`[getPaymentByBooking] reconcile failed: ${(err as Error).message}`);
      }
    }

    return this.toGql(payment);
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private async markFailed(
    paymentId: string,
    opts: {
      failureCode: string;
      failureMessage: string;
      omiseChargeId?: string;
      changedBy?: string;
    },
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: paymentId },
        data: {
          paymentStatus:  PaymentStatus.failed,
          failureCode:    opts.failureCode,
          failureMessage: opts.failureMessage,
          ...(opts.omiseChargeId ? { omiseChargeId: opts.omiseChargeId } : {}),
          updatedAt:      new Date(),
        },
      });

      await tx.paymentStatusHistory.create({
        data: {
          paymentId,
          fromStatus: PaymentStatus.pending,
          toStatus:   PaymentStatus.failed,
          changedBy:  opts.changedBy,
          reason:     opts.failureMessage,
          metadata:   { failureCode: opts.failureCode, omiseChargeId: opts.omiseChargeId },
        },
      });
    });
  }

  private mapHistoryRow(row: PrismaHistoryRow): PaymentStatusHistory {
    return {
      id:         row.id,
      paymentId:  row.paymentId,
      fromStatus: row.fromStatus ?? undefined,
      toStatus:   row.toStatus,
      changedBy:  row.changedBy  ?? undefined,
      reason:     row.reason     ?? undefined,
      metadata:   row.metadata === null ? undefined : JSON.stringify(row.metadata),
      createdAt:  row.createdAt,
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
    metadata?: unknown;
    createdAt: Date;
    updatedAt: Date;
  }): Payment {
    const meta = p.metadata as Record<string, unknown> | null | undefined;
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
      paymentStatus:  p.paymentStatus  as PaymentStatusEnum,
      failureCode:    p.failureCode    ?? undefined,
      failureMessage: p.failureMessage ?? undefined,
      qrCodeUrl:      meta?.qrCodeUrl  as string | undefined,
      createdAt:      p.createdAt,
      updatedAt:      p.updatedAt,
    };
  }
}
