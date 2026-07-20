import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { AdminTransactionsInput } from './dto/admin-transactions.input';
import { TransactionSortBy } from './dto/transaction-sort.enum';
import { TransactionType } from './entities/transaction-type.enum';
import {
  TransactionDetail,
  TransactionSummary,
  TransactionSummaryConnection,
  TransactionTimelineEntry,
  TransactionTotals,
} from './dto/transaction.types';
import {
  buildTxnId,
  DEFAULT_CURRENCY,
  isUuid,
  parseTxnId,
  REFUND_PAYMENT_STATUSES,
} from './transaction.constants';

// ── shapes ที่ Prisma คืนกลับ (เขียนเองแล้ว cast — ตาม pattern ของ dispute.service) ──

type StatusHistoryRow = {
  fromStatus: string | null;
  toStatus: string;
  changedBy: string | null;
  reason: string | null;
  createdAt: Date;
};

type PaymentRow = {
  id: string;
  bookingId: string;
  patientId: string;
  caregiverId: string;
  amount: { toNumber(): number };
  currency: string;
  paymentMethod: string;
  paymentStatus: string;
  createdAt: Date;
  patient: { id: string; displayName: string | null; email: string };
};

type PaymentDetailRow = PaymentRow & {
  statusHistory: StatusHistoryRow[];
  booking: { id: string; payout: { id: string } | null } | null;
};

type PayoutRow = {
  id: string;
  bookingId: string;
  caregiverId: string;
  amount: { toNumber(): number };
  status: string;
  createdAt: Date;
  caregiver: {
    id: string;
    user: { id: string; displayName: string | null; email: string };
  };
};

type PayoutDetailRow = PayoutRow & {
  statusHistory: StatusHistoryRow[];
  booking: {
    id: string;
    patientId: string;
    payment: { id: string } | null;
  } | null;
};

// groupBy/aggregate result shapes (สำหรับ summary)
type PaymentStatusGroup = {
  paymentStatus: string;
  _count: number;
  _sum: { amount: { toNumber(): number } | null };
};
type PayoutAgg = {
  _count: number;
  _sum: { amount: { toNumber(): number } | null };
};

/**
 * PYG-333 — Admin transactions service (read-only)
 *
 * "transaction" ไม่ใช่ตารางจริง แต่เป็น view รวมของ 2 ตาราง:
 *   payments (payment/refund) + payouts (payout)
 * เราจึง query แยก 2 ตาราง แล้ว merge/sort/paginate ในหน่วยความจำ
 *
 * ข้อจำกัด scale (MVP): list ดึงทุกแถวที่ match filter จาก DB แล้วค่อยตัดหน้า
 * เหมาะกับปริมาณข้อมูล admin dashboard ระดับ MVP — ถ้าโตมากค่อยเปลี่ยนเป็น
 * raw SQL UNION + keyset pagination (ดู PYG-333 note)
 *
 * ทุก method เป็น read-only — ไม่มี mutation ที่ trigger payout (ตาม guard ในตั๋ว)
 */
@Injectable()
export class TransactionService {
  constructor(private readonly prisma: PrismaService) {}

  // ── 1. list: payment + payout + refund รวมกัน ─────────────────────────────

  async adminTransactions(
    input: AdminTransactionsInput,
  ): Promise<TransactionSummaryConnection> {
    const page = Math.max(1, input.page ?? 1);
    const limit = Math.min(100, Math.max(1, input.limit ?? 20));
    const offset = (page - 1) * limit;

    const { wantPayments, wantPayouts } = this.sourcesFor(input);

    const [payments, payouts] = await Promise.all([
      wantPayments
        ? this.prisma.payment.findMany({
            where: this.paymentWhere(input),
            include: {
              patient: { select: { id: true, displayName: true, email: true } },
            },
          })
        : Promise.resolve([]),
      wantPayouts
        ? this.prisma.payout.findMany({
            where: this.payoutWhere(input),
            include: {
              caregiver: {
                select: {
                  id: true,
                  user: {
                    select: { id: true, displayName: true, email: true },
                  },
                },
              },
            },
          })
        : Promise.resolve([]),
    ]);

    const rows: TransactionSummary[] = [
      ...(payments as unknown as PaymentRow[]).map((p) =>
        this.paymentToSummary(p),
      ),
      ...(payouts as unknown as PayoutRow[]).map((p) =>
        this.payoutToSummary(p),
      ),
    ];

    this.sortRows(rows, input.sortBy);

    const totalCount = rows.length;
    const nodes = rows.slice(offset, offset + limit);

    return {
      nodes,
      totalCount,
      page,
      limit,
      hasNextPage: offset + limit < totalCount,
    };
  }

  // ── 2. summary: aggregate totals ตาม filter เดียวกัน ──────────────────────

  async adminTransactionSummary(
    input: AdminTransactionsInput,
  ): Promise<TransactionTotals> {
    const { wantPayments, wantPayouts } = this.sourcesFor(input);

    const [paymentGroupsRaw, payoutAggRaw] = await Promise.all([
      wantPayments
        ? this.prisma.payment.groupBy({
            by: ['paymentStatus'],
            where: this.paymentWhere(input),
            _count: true,
            _sum: { amount: true },
          })
        : Promise.resolve([]),
      wantPayouts
        ? this.prisma.payout.aggregate({
            where: this.payoutWhere(input),
            _count: true,
            _sum: { amount: true },
          })
        : Promise.resolve({ _count: 0, _sum: { amount: null } }),
    ]);

    // payments แยกเป็น payment vs refund ตามสถานะ
    let paymentCount = 0;
    let refundCount = 0;
    let totalPaymentAmount = 0;
    let totalRefundAmount = 0;

    for (const g of paymentGroupsRaw as unknown as PaymentStatusGroup[]) {
      const count = g._count;
      const sum = g._sum.amount ? g._sum.amount.toNumber() : 0;
      if (REFUND_PAYMENT_STATUSES.includes(g.paymentStatus)) {
        refundCount += count;
        totalRefundAmount += sum;
      } else {
        paymentCount += count;
        totalPaymentAmount += sum;
      }
    }

    const payoutAgg = payoutAggRaw as unknown as PayoutAgg;
    const payoutCount = payoutAgg._count;
    const totalPayoutAmount = payoutAgg._sum.amount
      ? payoutAgg._sum.amount.toNumber()
      : 0;

    return {
      totalCount: paymentCount + refundCount + payoutCount,
      paymentCount,
      payoutCount,
      refundCount,
      totalPaymentAmount,
      totalPayoutAmount,
      totalRefundAmount,
      // เงินสุทธิที่ platform ถือ = เงินเข้า − เงินคืน − เงินจ่ายออก
      netAmount: totalPaymentAmount - totalRefundAmount - totalPayoutAmount,
      currency: DEFAULT_CURRENCY,
    };
  }

  // ── 3. detail: 1 transaction + timeline + related links ───────────────────

  async adminTransaction(id: string): Promise<TransactionDetail> {
    const parsed = parseTxnId(id);
    if (!parsed) {
      throw new BadRequestException(
        'รูปแบบ id ไม่ถูกต้อง — ต้องเป็น "payment:<uuid>" หรือ "payout:<uuid>"',
      );
    }
    return parsed.source === 'payment'
      ? this.paymentDetail(parsed.uuid)
      : this.payoutDetail(parsed.uuid);
  }

  private async paymentDetail(uuid: string): Promise<TransactionDetail> {
    const p = await this.prisma.payment.findUnique({
      where: { id: uuid },
      include: {
        patient: { select: { id: true, displayName: true, email: true } },
        statusHistory: {
          orderBy: { createdAt: 'asc' },
          select: {
            fromStatus: true,
            toStatus: true,
            changedBy: true,
            reason: true,
            createdAt: true,
          },
        },
        booking: { select: { id: true, payout: { select: { id: true } } } },
      },
    });
    if (!p) {
      throw new NotFoundException('ไม่พบ transaction (payment) ตาม id ที่ระบุ');
    }

    const row = p as unknown as PaymentDetailRow;
    return {
      ...this.paymentToSummary(row),
      timeline: this.toTimeline(row.statusHistory),
      relatedLinks: {
        bookingId: row.bookingId,
        paymentId: row.id,
        payoutId: row.booking?.payout?.id ?? undefined,
        patientId: row.patientId,
        caregiverId: row.caregiverId, // Payment.caregiverId = user id อยู่แล้ว
      },
    };
  }

  private async payoutDetail(uuid: string): Promise<TransactionDetail> {
    const p = await this.prisma.payout.findUnique({
      where: { id: uuid },
      include: {
        caregiver: {
          select: {
            id: true,
            user: { select: { id: true, displayName: true, email: true } },
          },
        },
        statusHistory: {
          orderBy: { createdAt: 'asc' },
          select: {
            fromStatus: true,
            toStatus: true,
            changedBy: true,
            reason: true,
            createdAt: true,
          },
        },
        booking: {
          select: {
            id: true,
            patientId: true,
            payment: { select: { id: true } },
          },
        },
      },
    });
    if (!p) {
      throw new NotFoundException('ไม่พบ transaction (payout) ตาม id ที่ระบุ');
    }

    const row = p as unknown as PayoutDetailRow;
    return {
      ...this.payoutToSummary(row),
      timeline: this.toTimeline(row.statusHistory),
      relatedLinks: {
        bookingId: row.bookingId,
        payoutId: row.id,
        paymentId: row.booking?.payment?.id ?? undefined,
        patientId: row.booking?.patientId ?? undefined,
        // ใช้ user id ให้ตรงกับฝั่ง payment (Payout.caregiverId เป็น Caregiver.id)
        caregiverId: row.caregiver.user.id,
      },
    };
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  // ตารางไหนต้อง query บ้างตาม filter type
  private sourcesFor(input: AdminTransactionsInput): {
    wantPayments: boolean;
    wantPayouts: boolean;
  } {
    return {
      wantPayments:
        !input.type ||
        input.type === TransactionType.payment ||
        input.type === TransactionType.refund,
      wantPayouts: !input.type || input.type === TransactionType.payout,
    };
  }

  private paymentWhere(
    input: AdminTransactionsInput,
  ): Prisma.PaymentWhereInput {
    const where: Prisma.PaymentWhereInput = {};

    // สถานะ/ประเภท: status ระบุตรง ๆ = ชนะ; ไม่งั้นแยก payment vs refund ตาม type
    if (input.status) {
      where.paymentStatus = input.status as PaymentStatus;
    } else if (input.type === TransactionType.refund) {
      where.paymentStatus = { in: REFUND_PAYMENT_STATUSES as PaymentStatus[] };
    } else if (input.type === TransactionType.payment) {
      where.paymentStatus = {
        notIn: REFUND_PAYMENT_STATUSES as PaymentStatus[],
      };
    }

    if (input.dateFrom || input.dateTo) {
      where.createdAt = {
        ...(input.dateFrom ? { gte: input.dateFrom } : {}),
        ...(input.dateTo ? { lte: input.dateTo } : {}),
      };
    }

    const q = input.q?.trim();
    if (q) {
      const or: Prisma.PaymentWhereInput[] = [
        { omiseChargeId: { contains: q, mode: 'insensitive' } },
        { patient: { displayName: { contains: q, mode: 'insensitive' } } },
        { patient: { email: { contains: q, mode: 'insensitive' } } },
        { caregiver: { displayName: { contains: q, mode: 'insensitive' } } },
        { caregiver: { email: { contains: q, mode: 'insensitive' } } },
      ];
      // id / bookingId เป็น column uuid → ใส่ equals เฉพาะตอน q เป็น UUID
      if (isUuid(q)) {
        or.push({ id: q }, { bookingId: q });
      }
      where.OR = or;
    }

    return where;
  }

  private payoutWhere(input: AdminTransactionsInput): Prisma.PayoutWhereInput {
    const where: Prisma.PayoutWhereInput = {};

    // payout.status เป็น text อิสระ (scheduled/processing/paid/failed/...) → equals ตรง ๆ
    if (input.status) {
      where.status = input.status;
    }

    if (input.dateFrom || input.dateTo) {
      where.createdAt = {
        ...(input.dateFrom ? { gte: input.dateFrom } : {}),
        ...(input.dateTo ? { lte: input.dateTo } : {}),
      };
    }

    const q = input.q?.trim();
    if (q) {
      const or: Prisma.PayoutWhereInput[] = [
        { omiseTransferId: { contains: q, mode: 'insensitive' } },
        {
          caregiver: {
            user: { displayName: { contains: q, mode: 'insensitive' } },
          },
        },
        {
          caregiver: { user: { email: { contains: q, mode: 'insensitive' } } },
        },
      ];
      if (isUuid(q)) {
        or.push({ id: q }, { bookingId: q });
      }
      where.OR = or;
    }

    return where;
  }

  private paymentToSummary(p: PaymentRow): TransactionSummary {
    // refund = payment ที่สถานะ refunded/partially_refunded (เงินคืน patient)
    const isRefund = REFUND_PAYMENT_STATUSES.includes(p.paymentStatus);
    return {
      id: buildTxnId('payment', p.id),
      type: isRefund ? TransactionType.refund : TransactionType.payment,
      status: p.paymentStatus,
      amount: p.amount.toNumber(),
      currency: p.currency,
      bookingId: p.bookingId,
      method: p.paymentMethod,
      counterparty: {
        id: p.patient.id,
        displayName: p.patient.displayName ?? undefined,
        email: p.patient.email,
      },
      createdAt: p.createdAt,
    };
  }

  private payoutToSummary(p: PayoutRow): TransactionSummary {
    return {
      id: buildTxnId('payout', p.id),
      type: TransactionType.payout,
      status: p.status,
      amount: p.amount.toNumber(),
      currency: DEFAULT_CURRENCY, // payouts ไม่มี column currency
      bookingId: p.bookingId,
      method: 'omise_transfer',
      counterparty: {
        id: p.caregiver.user.id,
        displayName: p.caregiver.user.displayName ?? undefined,
        email: p.caregiver.user.email,
      },
      createdAt: p.createdAt,
    };
  }

  private toTimeline(history: StatusHistoryRow[]): TransactionTimelineEntry[] {
    return history.map((h) => ({
      fromStatus: h.fromStatus ?? undefined,
      toStatus: h.toStatus,
      changedBy: h.changedBy ?? undefined,
      reason: h.reason ?? undefined,
      createdAt: h.createdAt,
    }));
  }

  private sortRows(
    rows: TransactionSummary[],
    sortBy?: TransactionSortBy,
  ): void {
    switch (sortBy) {
      case TransactionSortBy.amount_asc:
        rows.sort((a, b) => a.amount - b.amount);
        break;
      case TransactionSortBy.amount_desc:
        rows.sort((a, b) => b.amount - a.amount);
        break;
      case TransactionSortBy.created_asc:
        rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        break;
      case TransactionSortBy.created_desc:
      default:
        rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        break;
    }
  }
}
