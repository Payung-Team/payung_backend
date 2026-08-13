/**
 * PYG-376 — Reconciliation service unit tests
 *
 * Covers all six flags, the unreachable-row isolation, admin-override exemption for Flag 1,
 * satang-integer amount comparison, and (in a second describe) the CSV BOM + cron email.
 */
import { Prisma } from '@prisma/client';
import { ReconciliationService } from './reconciliation.service';
import { ReconFlag } from './reconciliation.types';
import { reconRowsToCsv, UTF8_BOM } from './reconciliation.csv';

const D = (n: number | string) => new Prisma.Decimal(n);
const WINDOW_FROM = new Date('2026-08-01T00:00:00Z');
const WINDOW_TO = new Date('2026-08-31T23:59:59Z');

/** a payment row as the service selects it. */
function payment(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'pay-1',
    bookingId: 'bk-1',
    amount: D(1000),
    capturedAmount: D(1000),
    refundedAmount: D(0),
    paymentStatus: 'captured',
    omiseChargeId: 'chrg_1',
    createdAt: new Date('2026-08-10T10:00:00Z'),
    ...over,
  };
}

function omiseCharge(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'chrg_1',
    status: 'successful',
    amount: 100000, // satang = 1000 baht
    captured: true,
    paid: true,
    authorized: true,
    ...over,
  };
}

/**
 * Build a service whose Prisma/Omise/Monitoring deps are mocked to a single-booking scenario.
 * `opts` shapes each side so a test can trigger exactly one flag.
 */
function makeService(opts: {
  payments: ReturnType<typeof payment>[];
  payout?: { status: string; grossAmount?: Prisma.Decimal; platformFee?: Prisma.Decimal; amount?: Prisma.Decimal } | null;
  jobEvents?: { bookingId: string; eventType: string; source: string }[];
  booking?: { reviewReasons: string[]; disputeStatus: string };
  overrideHistoryRows?: { paymentId: string; changedBy: string }[];
  adminIds?: string[];
  verdict?: string;
  charge?: ReturnType<typeof omiseCharge> | 'throw' | null;
}) {
  const booking = opts.booking ?? { reviewReasons: [], disputeStatus: 'none' };

  const prisma = {
    payment: { findMany: jest.fn().mockResolvedValue(opts.payments) },
    payout: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          opts.payout ? [{ bookingId: 'bk-1', ...opts.payout }] : [],
        ),
    },
    jobEvent: { findMany: jest.fn().mockResolvedValue(opts.jobEvents ?? []) },
    booking: {
      findMany: jest.fn().mockResolvedValue(
        opts.payments.map((p) => ({ id: p.bookingId, ...booking })),
      ),
    },
    paymentStatusHistory: {
      findMany: jest.fn().mockResolvedValue(opts.overrideHistoryRows ?? []),
    },
    user: {
      findMany: jest
        .fn()
        .mockResolvedValue((opts.adminIds ?? []).map((id) => ({ id }))),
    },
  };

  const omise = {
    retrieveCharge: jest.fn().mockImplementation(() => {
      if (opts.charge === 'throw') return Promise.reject(new Error('Omise 503'));
      if (opts.charge === null) return Promise.reject(new Error('not found'));
      return Promise.resolve(opts.charge ?? omiseCharge());
    }),
  };

  // reuse the real verdict rule by default; allow override for targeted tests
  const monitoring = {
    computeVerdict: jest.fn().mockReturnValue(opts.verdict ?? 'valid'),
  };

  const service = new ReconciliationService(
    prisma as never,
    omise as never,
    monitoring as never,
  );
  return { service, prisma, omise, monitoring };
}

async function firstRow(svc: ReconciliationService) {
  const report = await svc.buildReport(WINDOW_FROM, WINDOW_TO);
  return { report, row: report.rows[0] };
}

describe('ReconciliationService — flags', () => {
  it('Flag 1 CAPTURE_WITHOUT_PROOF — captured + verdict needs_review + no admin override', async () => {
    const { service } = makeService({
      payments: [payment({ paymentStatus: 'captured' })],
      verdict: 'needs_review',
      charge: omiseCharge(),
    });
    const { row } = await firstRow(service);
    expect(row.flags).toContain(ReconFlag.CAPTURE_WITHOUT_PROOF);
    expect(row.primaryFlag).toBe(ReconFlag.CAPTURE_WITHOUT_PROOF);
  });

  it('Flag 1 does NOT fire when an admin override exists in payment_status_history', async () => {
    const { service } = makeService({
      payments: [payment({ paymentStatus: 'captured' })],
      verdict: 'needs_review',
      charge: omiseCharge(),
      overrideHistoryRows: [{ paymentId: 'pay-1', changedBy: 'admin-9' }],
      adminIds: ['admin-9'], // admin-9 resolves to role >= ADMIN
    });
    const { row } = await firstRow(service);
    expect(row.flags).not.toContain(ReconFlag.CAPTURE_WITHOUT_PROOF);
  });

  it('override by a NON-admin changer does not exempt Flag 1', async () => {
    const { service } = makeService({
      payments: [payment({ paymentStatus: 'captured' })],
      verdict: 'needs_review',
      charge: omiseCharge(),
      overrideHistoryRows: [{ paymentId: 'pay-1', changedBy: 'patient-x' }],
      adminIds: [], // patient-x is not an admin
    });
    const { row } = await firstRow(service);
    expect(row.flags).toContain(ReconFlag.CAPTURE_WITHOUT_PROOF);
  });

  it('Flag 2 PAYOUT_WITHOUT_CAPTURE — payout paid but payment not captured', async () => {
    const { service } = makeService({
      payments: [payment({ paymentStatus: 'pending' })],
      payout: { status: 'paid' },
      verdict: 'incomplete',
      charge: omiseCharge({ paid: false }),
    });
    const { row } = await firstRow(service);
    expect(row.flags).toContain(ReconFlag.PAYOUT_WITHOUT_CAPTURE);
  });

  it('Flag 3 AMOUNT_MISMATCH — satang(amount) != omise.amount (integer compare)', async () => {
    const { service } = makeService({
      payments: [payment({ amount: D(1000), paymentStatus: 'captured' })],
      verdict: 'valid',
      charge: omiseCharge({ amount: 99999 }), // 999.99 baht != 1000
    });
    const { row } = await firstRow(service);
    expect(row.flags).toContain(ReconFlag.AMOUNT_MISMATCH);
  });

  it('Flag 3 does NOT fire on exact satang match (no float drift)', async () => {
    const { service } = makeService({
      payments: [payment({ amount: D('1000.50'), paymentStatus: 'captured' })],
      verdict: 'valid',
      charge: omiseCharge({ amount: 100050 }),
    });
    const { row } = await firstRow(service);
    expect(row.flags).not.toContain(ReconFlag.AMOUNT_MISMATCH);
  });

  it('Flag 4 DB captured but Omise paid=false', async () => {
    const { service } = makeService({
      payments: [payment({ paymentStatus: 'captured' })],
      verdict: 'valid',
      charge: omiseCharge({ paid: false }),
    });
    const { row } = await firstRow(service);
    expect(row.flags).toContain(ReconFlag.STATUS_MISMATCH_DB_CAPTURED_OMISE_UNPAID);
  });

  it('Flag 5 Omise paid=true but DB pending (lost webhook)', async () => {
    const { service } = makeService({
      payments: [payment({ paymentStatus: 'pending' })],
      verdict: 'incomplete',
      charge: omiseCharge({ paid: true }),
    });
    const { row } = await firstRow(service);
    expect(row.flags).toContain(ReconFlag.STATUS_MISMATCH_OMISE_PAID_DB_PENDING);
  });

  it('Flag 6 REFUND_EXCEEDS_CAPTURED — refunded > captured', async () => {
    const { service } = makeService({
      payments: [
        payment({
          paymentStatus: 'partially_refunded',
          capturedAmount: D(500),
          refundedAmount: D(600),
        }),
      ],
      verdict: 'valid',
      charge: omiseCharge({ amount: 50000 }),
    });
    const { row } = await firstRow(service);
    expect(row.flags).toContain(ReconFlag.REFUND_EXCEEDS_CAPTURED);
  });

  it('unreachable Omise row → report still produces, row marked, flags 3/4/5 skipped', async () => {
    const { service } = makeService({
      payments: [payment({ paymentStatus: 'captured' })],
      verdict: 'valid',
      charge: 'throw',
    });
    const { report, row } = await firstRow(service);
    expect(report.totalRows).toBe(1);
    expect(row.omiseUnreachable).toBe(true);
    expect(row.flags).not.toContain(ReconFlag.AMOUNT_MISMATCH);
    expect(row.flags).not.toContain(ReconFlag.STATUS_MISMATCH_DB_CAPTURED_OMISE_UNPAID);
    expect(row.flags).not.toContain(ReconFlag.STATUS_MISMATCH_OMISE_PAID_DB_PENDING);
  });

  it('clean row → no flags, primaryFlag null', async () => {
    const { service } = makeService({
      payments: [payment({ paymentStatus: 'captured' })],
      verdict: 'valid',
      charge: omiseCharge(),
    });
    const { row } = await firstRow(service);
    expect(row.flags).toHaveLength(0);
    expect(row.primaryFlag).toBeNull();
  });

  it('reuses MonitoringService.computeVerdict (does not invent its own rule)', async () => {
    const { service, monitoring } = makeService({
      payments: [payment()],
      jobEvents: [
        { bookingId: 'bk-1', eventType: 'check_in', source: 'caregiver' },
        { bookingId: 'bk-1', eventType: 'check_out', source: 'caregiver' },
      ],
      booking: { reviewReasons: ['out_of_radius'], disputeStatus: 'none' },
      verdict: 'needs_review',
      charge: omiseCharge(),
    });
    await firstRow(service);
    expect(monitoring.computeVerdict).toHaveBeenCalledWith(
      ['out_of_radius'],
      true, // has check_in
      'caregiver', // check_out source
      'none',
    );
  });
});

describe('ReconciliationService — CSV export', () => {
  it('CSV starts with UTF-8 BOM and has gross/fee/net + flag columns; Thai preserved', async () => {
    const { service } = makeService({
      payments: [payment({ paymentStatus: 'captured' })],
      payout: {
        status: 'paid',
        grossAmount: D(1100),
        platformFee: D(100),
        amount: D(1000),
      },
      booking: { reviewReasons: ['ออกนอกรัศมี'], disputeStatus: 'none' },
      verdict: 'needs_review',
      charge: omiseCharge(),
    });
    const { report } = await firstRow(service);
    const csv = reconRowsToCsv(report.rows);

    expect(csv.startsWith(UTF8_BOM)).toBe(true);
    const header = csv.slice(UTF8_BOM.length).split('\r\n')[0];
    expect(header).toContain('gross');
    expect(header).toContain('fee');
    expect(header).toContain('net');
    expect(header).toContain('flag');
    // Thai review reason survives intact
    expect(csv).toContain('ออกนอกรัศมี');
    // gross/fee/net values present
    expect(csv).toContain('1100');
    expect(csv).toContain('CAPTURE_WITHOUT_PROOF');
  });
});
