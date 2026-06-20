import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
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
