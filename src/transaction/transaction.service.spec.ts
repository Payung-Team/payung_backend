import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TransactionService } from './transaction.service';
import { TransactionType } from './entities/transaction-type.enum';
import { TransactionSortBy } from './dto/transaction-sort.enum';

// Decimal mock — Prisma คืน Decimal ที่มี .toNumber()
const dec = (n: number) => ({ toNumber: () => n });

// UUID จริง(ผ่าน regex) สำหรับ test detail
const PAYMENT_UUID = '11111111-1111-1111-1111-111111111111';
const PAYOUT_UUID = '22222222-2222-2222-2222-222222222222';
const BOOKING_UUID = '33333333-3333-3333-3333-333333333333';

describe('TransactionService (PYG-333)', () => {
  let service: TransactionService;
  let prisma: {
    payment: {
      findMany: jest.Mock;
      groupBy: jest.Mock;
      findUnique: jest.Mock;
    };
    payout: {
      findMany: jest.Mock;
      aggregate: jest.Mock;
      findUnique: jest.Mock;
    };
  };

  // helper: 1 payment row ตาม shape ที่ service คาดหวัง
  const paymentRow = (over: Partial<any> = {}) => ({
    id: PAYMENT_UUID,
    bookingId: BOOKING_UUID,
    patientId: 'patient-1',
    caregiverId: 'cg-user-1',
    amount: dec(100),
    currency: 'THB',
    paymentMethod: 'credit_card',
    paymentStatus: 'captured',
    createdAt: new Date('2026-07-02T00:00:00Z'),
    patient: { id: 'patient-1', displayName: 'Patient A', email: 'a@x.com' },
    ...over,
  });

  const payoutRow = (over: Partial<any> = {}) => ({
    id: PAYOUT_UUID,
    bookingId: BOOKING_UUID,
    caregiverId: 'cg-1',
    amount: dec(80),
    status: 'paid',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    caregiver: {
      id: 'cg-1',
      user: { id: 'cg-user-1', displayName: 'Care B', email: 'b@x.com' },
    },
    ...over,
  });

  beforeEach(() => {
    prisma = {
      payment: {
        findMany: jest.fn(),
        groupBy: jest.fn(),
        findUnique: jest.fn(),
      },
      payout: {
        findMany: jest.fn(),
        aggregate: jest.fn(),
        findUnique: jest.fn(),
      },
    };
    service = new TransactionService(prisma as any);
  });

  // ── adminTransactions (list) ──────────────────────────────────────────────

  describe('adminTransactions', () => {
    it('merges payments + payouts, classifies refund, sorts created_desc', async () => {
      prisma.payment.findMany.mockResolvedValue([
        paymentRow({
          paymentStatus: 'captured',
          createdAt: new Date('2026-07-02T00:00:00Z'),
        }),
        paymentRow({
          id: '44444444-4444-4444-4444-444444444444',
          paymentStatus: 'refunded',
          amount: dec(50),
          createdAt: new Date('2026-07-03T00:00:00Z'),
        }),
      ]);
      prisma.payout.findMany.mockResolvedValue([payoutRow()]); // 2026-07-01

      const result = await service.adminTransactions({});

      expect(result.totalCount).toBe(3);
      expect(result.hasNextPage).toBe(false);
      // created_desc: refund(07-03) → payment(07-02) → payout(07-01)
      expect(result.nodes.map((n) => n.type)).toEqual([
        TransactionType.refund,
        TransactionType.payment,
        TransactionType.payout,
      ]);
      // composite id prefix
      expect(result.nodes[0].id.startsWith('payment:')).toBe(true);
      expect(result.nodes[2].id).toBe(`payout:${PAYOUT_UUID}`);
      // payout counterparty = caregiver user
      expect(result.nodes[2].counterparty.email).toBe('b@x.com');
      expect(result.nodes[2].currency).toBe('THB');
    });

    it('paginates in memory (limit/page/hasNextPage)', async () => {
      prisma.payment.findMany.mockResolvedValue([
        paymentRow({ createdAt: new Date('2026-07-05T00:00:00Z') }),
        paymentRow({
          id: '55555555-5555-5555-5555-555555555555',
          createdAt: new Date('2026-07-04T00:00:00Z'),
        }),
      ]);
      prisma.payout.findMany.mockResolvedValue([payoutRow()]);

      const page1 = await service.adminTransactions({ page: 1, limit: 2 });
      expect(page1.nodes).toHaveLength(2);
      expect(page1.totalCount).toBe(3);
      expect(page1.hasNextPage).toBe(true);

      const page2 = await service.adminTransactions({ page: 2, limit: 2 });
      expect(page2.nodes).toHaveLength(1);
      expect(page2.hasNextPage).toBe(false);
    });

    it('type=payout only queries payouts (payments untouched)', async () => {
      prisma.payout.findMany.mockResolvedValue([payoutRow()]);

      const result = await service.adminTransactions({
        type: TransactionType.payout,
      });

      expect(prisma.payment.findMany).not.toHaveBeenCalled();
      expect(prisma.payout.findMany).toHaveBeenCalledTimes(1);
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].type).toBe(TransactionType.payout);
    });

    it('sorts by amount_desc across sources', async () => {
      prisma.payment.findMany.mockResolvedValue([
        paymentRow({ amount: dec(100) }),
      ]);
      prisma.payout.findMany.mockResolvedValue([
        payoutRow({ amount: dec(500) }),
      ]);

      const result = await service.adminTransactions({
        sortBy: TransactionSortBy.amount_desc,
      });

      expect(result.nodes.map((n) => n.amount)).toEqual([500, 100]);
    });
  });

  // ── adminTransactionSummary ───────────────────────────────────────────────

  describe('adminTransactionSummary', () => {
    it('aggregates counts/sums and splits refund from payment', async () => {
      prisma.payment.groupBy.mockResolvedValue([
        { paymentStatus: 'captured', _count: 2, _sum: { amount: dec(200) } },
        { paymentStatus: 'refunded', _count: 1, _sum: { amount: dec(50) } },
      ]);
      prisma.payout.aggregate.mockResolvedValue({
        _count: 1,
        _sum: { amount: dec(80) },
      });

      const totals = await service.adminTransactionSummary({});

      expect(totals.paymentCount).toBe(2);
      expect(totals.refundCount).toBe(1);
      expect(totals.payoutCount).toBe(1);
      expect(totals.totalCount).toBe(4);
      expect(totals.totalPaymentAmount).toBe(200);
      expect(totals.totalRefundAmount).toBe(50);
      expect(totals.totalPayoutAmount).toBe(80);
      // net = 200 − 50 − 80
      expect(totals.netAmount).toBe(70);
      expect(totals.currency).toBe('THB');
    });

    it('handles empty _sum (null) as 0', async () => {
      prisma.payment.groupBy.mockResolvedValue([]);
      prisma.payout.aggregate.mockResolvedValue({
        _count: 0,
        _sum: { amount: null },
      });

      const totals = await service.adminTransactionSummary({});
      expect(totals.totalCount).toBe(0);
      expect(totals.totalPayoutAmount).toBe(0);
      expect(totals.netAmount).toBe(0);
    });
  });

  // ── adminTransaction (detail) ─────────────────────────────────────────────

  describe('adminTransaction', () => {
    it('rejects a malformed id', async () => {
      await expect(service.adminTransaction('not-a-real-id')).rejects.toThrow(
        BadRequestException,
      );
      await expect(
        service.adminTransaction('payment:not-a-uuid'),
      ).rejects.toThrow(BadRequestException);
    });

    it('returns payment detail with timeline + related links', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        ...paymentRow(),
        statusHistory: [
          {
            fromStatus: null,
            toStatus: 'held',
            changedBy: null,
            reason: 'authorized',
            createdAt: new Date('2026-07-01T00:00:00Z'),
          },
          {
            fromStatus: 'held',
            toStatus: 'captured',
            changedBy: 'admin-1',
            reason: 'service done',
            createdAt: new Date('2026-07-02T00:00:00Z'),
          },
        ],
        booking: { id: BOOKING_UUID, payout: { id: PAYOUT_UUID } },
      });

      const detail = await service.adminTransaction(`payment:${PAYMENT_UUID}`);

      expect(detail.type).toBe(TransactionType.payment);
      expect(detail.timeline).toHaveLength(2);
      expect(detail.timeline[0].fromStatus).toBeUndefined();
      expect(detail.timeline[1].toStatus).toBe('captured');
      expect(detail.relatedLinks.bookingId).toBe(BOOKING_UUID);
      expect(detail.relatedLinks.payoutId).toBe(PAYOUT_UUID);
      expect(detail.relatedLinks.paymentId).toBe(PAYMENT_UUID);
      expect(prisma.payment.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: PAYMENT_UUID } }),
      );
    });

    it('throws NotFound when payout id does not exist', async () => {
      prisma.payout.findUnique.mockResolvedValue(null);
      await expect(
        service.adminTransaction(`payout:${PAYOUT_UUID}`),
      ).rejects.toThrow(NotFoundException);
    });

    it('returns payout detail (caregiver id normalized to user id)', async () => {
      prisma.payout.findUnique.mockResolvedValue({
        ...payoutRow(),
        statusHistory: [
          {
            fromStatus: 'scheduled',
            toStatus: 'paid',
            changedBy: null,
            reason: null,
            createdAt: new Date('2026-07-01T00:00:00Z'),
          },
        ],
        booking: {
          id: BOOKING_UUID,
          patientId: 'patient-1',
          payment: { id: PAYMENT_UUID },
        },
      });

      const detail = await service.adminTransaction(`payout:${PAYOUT_UUID}`);

      expect(detail.type).toBe(TransactionType.payout);
      expect(detail.relatedLinks.paymentId).toBe(PAYMENT_UUID);
      expect(detail.relatedLinks.patientId).toBe('patient-1');
      // caregiverId = user id (not Caregiver.id)
      expect(detail.relatedLinks.caregiverId).toBe('cg-user-1');
    });
  });
});
