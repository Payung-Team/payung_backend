/**
 * PYG-376 — cron alerting tests. Flag 1/2 → email admins + error log; else warn/info.
 */
import { ReconciliationCron } from './reconciliation.cron';
import { ReconFlag, type ReconReport } from './reconciliation.types';

function report(rows: Partial<ReconReport['rows'][number]>[]): ReconReport {
  const full = rows.map((r) => ({
    bookingId: 'bk',
    paymentId: 'pay',
    date: '2026-08-10T00:00:00Z',
    amount: 1000,
    capturedAmount: 1000,
    refundedAmount: 0,
    paymentStatus: 'captured',
    omiseStatus: 'successful',
    payoutStatus: null,
    verdict: 'valid',
    reviewReasons: [],
    grossAmount: null,
    platformFee: null,
    netAmount: null,
    omiseUnreachable: false,
    flags: [],
    primaryFlag: null,
    ...r,
  }));
  return {
    dateFrom: 'x',
    dateTo: 'y',
    totalRows: full.length,
    flaggedRows: full.filter((r) => r.flags.length > 0).length,
    unreachableRows: full.filter((r) => r.omiseUnreachable).length,
    rows: full,
  };
}

function makeCron(rep: ReconReport) {
  const service = { buildReport: jest.fn().mockResolvedValue(rep) };
  const prisma = {
    user: { findMany: jest.fn().mockResolvedValue([{ email: 'admin@payung.app' }]) },
  };
  const email = { sendAdminAlert: jest.fn().mockResolvedValue(undefined) };
  const clock = { now: jest.fn().mockReturnValue(new Date('2026-08-13T03:00:00Z')) };
  const cron = new ReconciliationCron(
    service as never,
    prisma as never,
    email as never,
    clock as never,
  );
  return { cron, service, prisma, email, clock };
}

describe('ReconciliationCron', () => {
  it('Flag 1 present → emails admins (DoD: really sends)', async () => {
    const { cron, email, prisma } = makeCron(
      report([{ flags: [ReconFlag.CAPTURE_WITHOUT_PROOF], primaryFlag: ReconFlag.CAPTURE_WITHOUT_PROOF }]),
    );
    await cron.run();
    expect(prisma.user.findMany).toHaveBeenCalled();
    expect(email.sendAdminAlert).toHaveBeenCalledTimes(1);
    const [recipients, subject] = email.sendAdminAlert.mock.calls[0];
    expect(recipients).toContain('admin@payung.app');
    expect(subject).toContain('Reconciliation ALERT');
  });

  it('Flag 2 present → emails admins', async () => {
    const { cron, email } = makeCron(
      report([{ paymentStatus: 'pending', payoutStatus: 'paid', flags: [ReconFlag.PAYOUT_WITHOUT_CAPTURE], primaryFlag: ReconFlag.PAYOUT_WITHOUT_CAPTURE }]),
    );
    await cron.run();
    expect(email.sendAdminAlert).toHaveBeenCalledTimes(1);
  });

  it('only a lesser flag (Flag 3) → NO email', async () => {
    const { cron, email } = makeCron(
      report([{ flags: [ReconFlag.AMOUNT_MISMATCH], primaryFlag: ReconFlag.AMOUNT_MISMATCH }]),
    );
    await cron.run();
    expect(email.sendAdminAlert).not.toHaveBeenCalled();
  });

  it('INFO-tier only (HELD_AWAITING_PROOF) → NO email, even in bulk', async () => {
    const heldRows = Array.from({ length: 33 }, () => ({
      flags: [ReconFlag.HELD_AWAITING_PROOF],
      primaryFlag: ReconFlag.HELD_AWAITING_PROOF,
    }));
    const { cron, email } = makeCron(report(heldRows));
    await cron.run();
    expect(email.sendAdminAlert).not.toHaveBeenCalled(); // 33 held rows must never alert
  });

  it('clean report → NO email', async () => {
    const { cron, email } = makeCron(report([{}]));
    await cron.run();
    expect(email.sendAdminAlert).not.toHaveBeenCalled();
  });

  it('uses ClockService.now (not new Date)', async () => {
    const { cron, clock, service } = makeCron(report([{}]));
    await cron.run();
    expect(clock.now).toHaveBeenCalled();
    expect(service.buildReport).toHaveBeenCalled();
  });
});
