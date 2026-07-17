/**
 * PayoutWorkerService tests (PYG-330 ก้อน B — worker side)
 *
 * ครอบคลุม:
 * - recipient null → NO claim, NO Omise call, payout unchanged
 * - recipient_status != 'verified' → NO claim, NO Omise call
 * - claim ไม่ติด (updateMany count=0) → skip เงียบ ๆ ไม่เรียก Omise
 * - success path → status='paid', omise_transfer_id, processed_at + notification
 * - idempotency key คงที่ `payout:<id>` (ไม่มี retry_count/timestamp)
 * - Omise error → retry_count++, กลับ scheduled, ไม่ set 'failed'
 * - notification failure ไม่ rollback payout ที่ paid แล้ว
 * - satangs conversion — amount(THB Decimal) → integer satangs
 */
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PayoutWorkerService } from './payout-worker.service';
import { PrismaService } from '../common/prisma.service';
import { OmiseService } from '../payment/omise/omise.service';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/entities/notification-type.enum';

const PAYOUT_ID = 'payout-1';
const BOOKING_ID = 'booking-1';
const CAREGIVER_PROFILE_ID = 'cg-profile-1';
const CAREGIVER_USER_ID = 'cg-user-1';
const RECIPIENT_ID = 'recp_test_1';

function makePayoutRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYOUT_ID,
    status: 'scheduled',
    bookingId: BOOKING_ID,
    caregiverId: CAREGIVER_PROFILE_ID,
    amount: new Prisma.Decimal('900.00'),
    retryCount: 0,
    caregiver: {
      userId: CAREGIVER_USER_ID,
      payoutAccount: {
        omiseRecipientId: RECIPIENT_ID,
        recipientStatus: 'verified',
      },
    },
    ...overrides,
  };
}

describe('PayoutWorkerService', () => {
  let worker: PayoutWorkerService;
  let prisma: {
    payout: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
      update: jest.Mock;
    };
  };
  let omise: { createTransfer: jest.Mock };
  let notifications: { create: jest.Mock };

  beforeEach(async () => {
    prisma = {
      payout: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
      },
    };
    omise = { createTransfer: jest.fn() };
    notifications = { create: jest.fn().mockResolvedValue({}) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PayoutWorkerService,
        { provide: PrismaService, useValue: prisma },
        { provide: OmiseService, useValue: omise },
        { provide: NotificationService, useValue: notifications },
      ],
    }).compile();

    worker = moduleRef.get(PayoutWorkerService);
  });

  // ── Guards (BEFORE claim) ────────────────────────────────────────────────

  it('recipient null → NO claim, NO Omise call, log warn and skip', async () => {
    prisma.payout.findUnique.mockResolvedValue(
      makePayoutRow({
        caregiver: {
          userId: CAREGIVER_USER_ID,
          payoutAccount: {
            omiseRecipientId: null,
            recipientStatus: 'unverified',
          },
        },
      }),
    );

    await worker.processOne(PAYOUT_ID);

    // No claim: updateMany not called, no status churn
    expect(prisma.payout.updateMany).not.toHaveBeenCalled();
    // No Omise call
    expect(omise.createTransfer).not.toHaveBeenCalled();
    // No paid update
    expect(prisma.payout.update).not.toHaveBeenCalled();
  });

  it('recipient_status != verified → NO claim, NO Omise call', async () => {
    prisma.payout.findUnique.mockResolvedValue(
      makePayoutRow({
        caregiver: {
          userId: CAREGIVER_USER_ID,
          payoutAccount: {
            omiseRecipientId: RECIPIENT_ID,
            recipientStatus: 'unverified',
          },
        },
      }),
    );

    await worker.processOne(PAYOUT_ID);

    expect(prisma.payout.updateMany).not.toHaveBeenCalled();
    expect(omise.createTransfer).not.toHaveBeenCalled();
  });

  it('caregiver has no payoutAccount → NO claim', async () => {
    prisma.payout.findUnique.mockResolvedValue(
      makePayoutRow({
        caregiver: {
          userId: CAREGIVER_USER_ID,
          payoutAccount: null,
        },
      }),
    );

    await worker.processOne(PAYOUT_ID);

    expect(prisma.payout.updateMany).not.toHaveBeenCalled();
    expect(omise.createTransfer).not.toHaveBeenCalled();
  });

  // ── Concurrency (claim race) ─────────────────────────────────────────────

  it('claim conditional UPDATE count=0 (another worker won) → skip, no Omise call', async () => {
    prisma.payout.findUnique.mockResolvedValue(makePayoutRow());
    prisma.payout.updateMany.mockResolvedValue({ count: 0 });

    await worker.processOne(PAYOUT_ID);

    // Claim was attempted but lost race
    expect(prisma.payout.updateMany).toHaveBeenCalledWith({
      where: { id: PAYOUT_ID, status: 'scheduled' },
      data: { status: 'processing', recipientId: RECIPIENT_ID },
    });
    // No Omise, no paid update
    expect(omise.createTransfer).not.toHaveBeenCalled();
    expect(prisma.payout.update).not.toHaveBeenCalled();
  });

  // ── Success path ─────────────────────────────────────────────────────────

  it('success → status=paid + omise_transfer_id + processed_at + notification', async () => {
    prisma.payout.findUnique.mockResolvedValue(makePayoutRow());
    prisma.payout.updateMany.mockResolvedValue({ count: 1 });
    omise.createTransfer.mockResolvedValue({
      id: 'trsf_test_1',
      status: 'pending',
      amount: 90000,
      recipient: RECIPIENT_ID,
      currency: 'THB',
      sent: false,
      paid: false,
    });

    await worker.processOne(PAYOUT_ID);

    // Claim first
    expect(prisma.payout.updateMany).toHaveBeenCalledWith({
      where: { id: PAYOUT_ID, status: 'scheduled' },
      data: { status: 'processing', recipientId: RECIPIENT_ID },
    });

    // Omise call — satangs = 90000, idempotency key stable
    expect(omise.createTransfer).toHaveBeenCalledWith(
      90000,
      RECIPIENT_ID,
      `payout:${PAYOUT_ID}`,
    );

    // paid update
    expect(prisma.payout.update).toHaveBeenCalledWith({
      where: { id: PAYOUT_ID },
      data: expect.objectContaining({
        status: 'paid',
        omiseTransferId: 'trsf_test_1',
        processedAt: expect.any(Date),
      }),
    });

    // Notification
    expect(notifications.create).toHaveBeenCalledTimes(1);
    expect(notifications.create).toHaveBeenCalledWith(
      CAREGIVER_USER_ID,
      NotificationType.payment_transferred,
      expect.any(String),
      expect.stringContaining('900'),
      expect.objectContaining({
        payoutId: PAYOUT_ID,
        bookingId: BOOKING_ID,
        omiseTransferId: 'trsf_test_1',
      }),
    );
  });

  it('idempotency key is stable — no retry_count or timestamp', async () => {
    // simulate retryCount=3 payout — key must NOT include this value
    prisma.payout.findUnique.mockResolvedValue(
      makePayoutRow({ retryCount: 3 }),
    );
    prisma.payout.updateMany.mockResolvedValue({ count: 1 });
    omise.createTransfer.mockResolvedValue({
      id: 'trsf_test_2',
      status: 'pending',
      amount: 90000,
      recipient: RECIPIENT_ID,
      currency: 'THB',
      sent: false,
      paid: false,
    });

    await worker.processOne(PAYOUT_ID);

    const [, , key] = omise.createTransfer.mock.calls[0];
    // exact match proves no retry counter, no timestamp appended
    // (payout id itself may contain digits — that's fine; what matters is stability)
    expect(key).toBe(`payout:${PAYOUT_ID}`);
    // Extra guard: string length equals prefix + id, i.e. nothing appended
    expect(key.length).toBe(`payout:${PAYOUT_ID}`.length);
  });

  // ── satangs conversion ──────────────────────────────────────────────────

  it('satangs conversion — amount 900.00 THB → 90000 satangs (integer)', async () => {
    prisma.payout.findUnique.mockResolvedValue(makePayoutRow());
    prisma.payout.updateMany.mockResolvedValue({ count: 1 });
    omise.createTransfer.mockResolvedValue({
      id: 'trsf_x',
      status: 'pending',
      amount: 90000,
      recipient: RECIPIENT_ID,
      currency: 'THB',
      sent: false,
      paid: false,
    });

    await worker.processOne(PAYOUT_ID);
    const [amt] = omise.createTransfer.mock.calls[0];
    expect(amt).toBe(90000);
    expect(Number.isInteger(amt)).toBe(true);
  });

  it('satangs conversion — 300.05 THB → 30005 satangs (HALF_UP no float drift)', async () => {
    prisma.payout.findUnique.mockResolvedValue(
      makePayoutRow({ amount: new Prisma.Decimal('300.05') }),
    );
    prisma.payout.updateMany.mockResolvedValue({ count: 1 });
    omise.createTransfer.mockResolvedValue({
      id: 'trsf_x',
      status: 'pending',
      amount: 30005,
      recipient: RECIPIENT_ID,
      currency: 'THB',
      sent: false,
      paid: false,
    });

    await worker.processOne(PAYOUT_ID);
    const [amt] = omise.createTransfer.mock.calls[0];
    expect(amt).toBe(30005);
  });

  // ── Failure path ─────────────────────────────────────────────────────────

  it('Omise error → retry_count++, status back to scheduled, NOT failed', async () => {
    prisma.payout.findUnique.mockResolvedValue(makePayoutRow());
    prisma.payout.updateMany.mockResolvedValue({ count: 1 });
    omise.createTransfer.mockRejectedValue(new Error('Omise 500'));

    // must not throw — worker loop must continue with next payout
    await expect(worker.processOne(PAYOUT_ID)).resolves.toBeUndefined();

    // Rollback update
    expect(prisma.payout.update).toHaveBeenCalledWith({
      where: { id: PAYOUT_ID },
      data: {
        status: 'scheduled',
        retryCount: { increment: 1 },
      },
    });

    // ⚠️ status MUST NOT be 'failed' — PYG-331 owns that
    const paidCall = prisma.payout.update.mock.calls.find(
      (c) => c[0]?.data?.status === 'paid',
    );
    expect(paidCall).toBeUndefined();
    const failedCall = prisma.payout.update.mock.calls.find(
      (c) => c[0]?.data?.status === 'failed',
    );
    expect(failedCall).toBeUndefined();

    // No notification
    expect(notifications.create).not.toHaveBeenCalled();
  });

  // ── Notification failure isolation ───────────────────────────────────────

  it('notification failure does NOT rollback payout that was already paid', async () => {
    prisma.payout.findUnique.mockResolvedValue(makePayoutRow());
    prisma.payout.updateMany.mockResolvedValue({ count: 1 });
    omise.createTransfer.mockResolvedValue({
      id: 'trsf_test_1',
      status: 'pending',
      amount: 90000,
      recipient: RECIPIENT_ID,
      currency: 'THB',
      sent: false,
      paid: false,
    });
    notifications.create.mockRejectedValue(new Error('notification DB down'));

    await expect(worker.processOne(PAYOUT_ID)).resolves.toBeUndefined();

    // paid update DID happen
    expect(prisma.payout.update).toHaveBeenCalledWith({
      where: { id: PAYOUT_ID },
      data: expect.objectContaining({
        status: 'paid',
        omiseTransferId: 'trsf_test_1',
      }),
    });
    // No second update to roll back
    expect(prisma.payout.update).toHaveBeenCalledTimes(1);
  });

  // ── Scan (batch) ─────────────────────────────────────────────────────────

  it('run() — empty scan → no error, no update', async () => {
    prisma.payout.findMany.mockResolvedValue([]);
    await expect(worker.run()).resolves.toBeUndefined();
    expect(prisma.payout.updateMany).not.toHaveBeenCalled();
  });

  it('run() — one due payout → processOne called with correct filter', async () => {
    prisma.payout.findMany.mockResolvedValue([{ id: PAYOUT_ID }]);
    prisma.payout.findUnique.mockResolvedValue(makePayoutRow());
    prisma.payout.updateMany.mockResolvedValue({ count: 1 });
    omise.createTransfer.mockResolvedValue({
      id: 'trsf_x',
      status: 'pending',
      amount: 90000,
      recipient: RECIPIENT_ID,
      currency: 'THB',
      sent: false,
      paid: false,
    });

    await worker.run();

    // findMany used the correct filter
    expect(prisma.payout.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 'scheduled',
          scheduledAt: { lte: expect.any(Date) },
        },
      }),
    );

    // One transfer attempted
    expect(omise.createTransfer).toHaveBeenCalledTimes(1);
  });

  it('run() — one payout throws inside processOne → next payout still processes', async () => {
    prisma.payout.findMany.mockResolvedValue([
      { id: 'payout-a' },
      { id: 'payout-b' },
    ]);
    // First call throws BEFORE the try/catch inside processOne (simulate DB fail on findUnique)
    prisma.payout.findUnique
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(makePayoutRow({ id: 'payout-b' }));
    prisma.payout.updateMany.mockResolvedValue({ count: 1 });
    omise.createTransfer.mockResolvedValue({
      id: 'trsf_b',
      status: 'pending',
      amount: 90000,
      recipient: RECIPIENT_ID,
      currency: 'THB',
      sent: false,
      paid: false,
    });

    await expect(worker.run()).resolves.toBeUndefined();

    // Second payout processed
    expect(omise.createTransfer).toHaveBeenCalledTimes(1);
    expect(omise.createTransfer).toHaveBeenCalledWith(
      90000,
      RECIPIENT_ID,
      'payout:payout-b',
    );
  });
});
