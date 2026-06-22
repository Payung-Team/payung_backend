import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
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
import { OmiseService } from './omise/omise.service';
import { CreatePaymentInput } from './dto/create-payment.input';

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

    const existingPayment = await this.prisma.payment.findUnique({
      where: { bookingId: booking.id },
    });

    if (existingPayment && existingPayment.paymentStatus !== PaymentStatus.failed) {
      throw new ConflictException('A valid payment already exists for this booking');
    }

    const duration = typeof (booking.durationHours as any).toNumber === 'function' 
      ? (booking.durationHours as any).toNumber() 
      : Number(booking.durationHours);
      
    const hourlyRate = booking.caregiver.hourlyRate ?? 0;
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
        caregiverId: booking.caregiver.userId,
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

  // ── Private helpers ──────────────────────────────────────────────────────

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
