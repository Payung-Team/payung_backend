/**
 * PayoutWorkerService tests (PYG-330 + PYG-331 ก้อน B)
 *
 * ครอบคลุม:
 * - kill-switch on → skip ทั้งรอบ ไม่เรียก Omise
 * - recipient not ready → no claim, no Omise call
 * - claim lost (state machine returns claimed=false) → no Omise call
 * - success path → transition to 'paid' via state machine + notification
 * - idempotency key stable (payout:${id})
 * - failure + retry (< max) → state machine transition scheduled + retry_count++ + next_retry_at
 * - failure + terminate (>= max) → tx: scheduled → failed
 * - next_retry_at filter — worker query respects backoff
 * - satangs conversion + notification failure isolation
 */
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PayoutWorkerService } from './payout-worker.service';
import { PrismaService } from '../common/prisma.service';
import { OmiseService } from '../payment/omise/omise.service';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/entities/notification-type.enum';
import { PayoutStateMachine } from './payout-state-machine';
import { PayoutStatus } from './entities/payout-status.enum';
import { PayoutRetryPolicy } from './payout-retry-policy';
import { PayoutKillswitch } from './payout-killswitch';
import { PayoutEligibilityService } from './payout-eligibility.service';

const PAYOUT_ID = 'payout-1';
const BOOKING_ID = 'booking-1';
const CAREGIVER_PROFILE_ID = 'cg-profile-1';
const CAREGIVER_USER_ID = 'cg-user-1';
const RECIPIENT_ID = 'recp_test_1';

function makePayoutRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYOUT_ID,
    status: PayoutStatus.scheduled,
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

describe('PayoutWorkerService (ก้อน B — state machine + backoff + kill-switch)', () => {
  let worker: PayoutWorkerService;
  let prisma: {
    payout: { findMany: jest.Mock; findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let omise: { createTransfer: jest.Mock };
  let notifications: { create: jest.Mock };
  let stateMachine: { claim: jest.Mock; transition: jest.Mock };
  let retryPolicy: { decide: jest.Mock };
  let killswitch: { gate: jest.Mock };
  let eligibility: { check: jest.Mock };

  beforeEach(async () => {
    prisma = {
      payout: { findMany: jest.fn(), findUnique: jest.fn() },
      $transaction: jest.fn(async (cb: (t: unknown) => Promise<unknown>) =>
        cb({}),
      ),
    };
    omise = { createTransfer: jest.fn() };
    notifications = { create: jest.fn().mockResolvedValue({}) };
    stateMachine = {
      claim: jest.fn(),
      transition: jest.fn().mockResolvedValue({}),
    };
    retryPolicy = { decide: jest.fn() };
    killswitch = { gate: jest.fn().mockReturnValue(false) };
    // default: ไม่มี dispute → จ่ายได้ (เทสต์ที่สนใจ gate จะ override เอง)
    eligibility = {
      check: jest.fn().mockResolvedValue({
        kind: 'eligible',
        reason: 'no_dispute',
        evidence: {
          verdict: 'valid',
          checkInId: 'evt-in-1',
          checkOutId: 'evt-out-1',
        },
      }),
    };

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        PayoutWorkerService,
        { provide: PrismaService, useValue: prisma },
        { provide: OmiseService, useValue: omise },
        { provide: NotificationService, useValue: notifications },
        { provide: PayoutStateMachine, useValue: stateMachine },
        { provide: PayoutRetryPolicy, useValue: retryPolicy },
        { provide: PayoutKillswitch, useValue: killswitch },
        { provide: PayoutEligibilityService, useValue: eligibility },
      ],
    }).compile();

    worker = mod.get(PayoutWorkerService);
  });

  // ── re-check ตอนจะโอนจริง (dispute ยื่นหลังสร้าง payout) ────────────────────

  describe('payout gate re-check ก่อนโอน', () => {
    it('dispute ยื่นหลัง payout ถูกสร้าง → worker ไม่โอน', async () => {
      prisma.payout.findUnique.mockResolvedValue(makePayoutRow());
      eligibility.check.mockResolvedValue({
        kind: 'hold',
        reason: 'proof_needs_review',
        evidence: { verdict: 'needs_review', disputed: true },
      });

      await worker.processOne(PAYOUT_ID);

      expect(omise.createTransfer).not.toHaveBeenCalled();
      expect(stateMachine.claim).not.toHaveBeenCalled();
    });

    it('hold → ไม่แตะ row เลย (payout ยังอยู่ scheduled รอ admin ตัดสิน)', async () => {
      prisma.payout.findUnique.mockResolvedValue(makePayoutRow());
      eligibility.check.mockResolvedValue({
        kind: 'hold',
        reason: 'proof_needs_review',
        evidence: {},
      });

      await worker.processOne(PAYOUT_ID);

      // ห้าม cancel — cancelled เป็น terminal + booking_id UNIQUE = กู้คืนไม่ได้
      expect(stateMachine.claim).not.toHaveBeenCalled();
      expect(stateMachine.transition).not.toHaveBeenCalled();
    });

    it('deny (คืนเงินลูกค้าไปแล้ว) → cancel ผ่าน state machine ไม่โอน', async () => {
      prisma.payout.findUnique.mockResolvedValue(makePayoutRow());
      eligibility.check.mockResolvedValue({
        kind: 'deny',
        reason: 'payment_refunded',
        evidence: { verdict: 'valid', refundedAmount: 1000 },
      });
      stateMachine.claim.mockResolvedValue({ claimed: true, payout: {} });

      await worker.processOne(PAYOUT_ID);

      expect(omise.createTransfer).not.toHaveBeenCalled();
      expect(stateMachine.claim).toHaveBeenCalledWith(
        PAYOUT_ID,
        PayoutStatus.scheduled,
        PayoutStatus.cancelled,
        expect.objectContaining({
          reason: 'payout_gate_denied:payment_refunded',
        }),
      );
    });

    it('gate ถูกเช็คก่อนอ่าน recipient — recipient ไม่พร้อมก็ยังต้อง cancel ได้', async () => {
      prisma.payout.findUnique.mockResolvedValue(
        makePayoutRow({
          caregiver: {
            userId: CAREGIVER_USER_ID,
            payoutAccount: { omiseRecipientId: null, recipientStatus: null },
          },
        }),
      );
      eligibility.check.mockResolvedValue({
        kind: 'deny',
        reason: 'payment_refunded',
        evidence: {},
      });
      stateMachine.claim.mockResolvedValue({ claimed: true, payout: {} });

      await worker.processOne(PAYOUT_ID);

      expect(stateMachine.claim).toHaveBeenCalledWith(
        PAYOUT_ID,
        PayoutStatus.scheduled,
        PayoutStatus.cancelled,
        expect.anything(),
      );
    });

    it('eligible → เดินหน้าโอนตามปกติ', async () => {
      prisma.payout.findUnique.mockResolvedValue(makePayoutRow());
      stateMachine.claim.mockResolvedValue({
        claimed: true,
        payout: makePayoutRow(),
      });
      omise.createTransfer.mockResolvedValue({
        id: 'trsf_1',
        status: 'pending',
      });

      await worker.processOne(PAYOUT_ID);

      expect(eligibility.check).toHaveBeenCalledWith(BOOKING_ID);
      expect(omise.createTransfer).toHaveBeenCalledTimes(1);
    });
  });

  // ── kill-switch ──────────────────────────────────────────────────────────

  it('kill-switch on → skip whole tick, no query, no Omise', async () => {
    killswitch.gate.mockReturnValue(true);

    await worker.run();

    expect(prisma.payout.findMany).not.toHaveBeenCalled();
    expect(omise.createTransfer).not.toHaveBeenCalled();
    expect(stateMachine.claim).not.toHaveBeenCalled();
  });

  // ── worker query respects next_retry_at ──────────────────────────────────

  it('run() query filter includes nextRetryAt backoff guard', async () => {
    prisma.payout.findMany.mockResolvedValue([]);

    await worker.run();

    expect(prisma.payout.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: PayoutStatus.scheduled,
          scheduledAt: { lte: expect.any(Date) },
          OR: [
            { nextRetryAt: null },
            { nextRetryAt: { lte: expect.any(Date) } },
          ],
        }),
      }),
    );
  });

  // ── recipient guards (no claim) ──────────────────────────────────────────

  it('recipient null → no claim, no state machine call, no Omise', async () => {
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

    expect(stateMachine.claim).not.toHaveBeenCalled();
    expect(omise.createTransfer).not.toHaveBeenCalled();
  });

  it('recipient not verified → no claim', async () => {
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
    expect(stateMachine.claim).not.toHaveBeenCalled();
  });

  it('no payoutAccount → no claim', async () => {
    prisma.payout.findUnique.mockResolvedValue(
      makePayoutRow({
        caregiver: { userId: CAREGIVER_USER_ID, payoutAccount: null },
      }),
    );
    await worker.processOne(PAYOUT_ID);
    expect(stateMachine.claim).not.toHaveBeenCalled();
  });

  // ── claim race lost ──────────────────────────────────────────────────────

  it('state machine claim returns claimed=false → no Omise, no notification', async () => {
    prisma.payout.findUnique.mockResolvedValue(makePayoutRow());
    stateMachine.claim.mockResolvedValue({ claimed: false, payout: null });

    await worker.processOne(PAYOUT_ID);

    expect(omise.createTransfer).not.toHaveBeenCalled();
    expect(stateMachine.transition).not.toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();
  });

  // ── success path ─────────────────────────────────────────────────────────

  it('success → state machine transition to paid + notification', async () => {
    prisma.payout.findUnique.mockResolvedValue(makePayoutRow());
    stateMachine.claim.mockResolvedValue({
      claimed: true,
      payout: makePayoutRow({ status: PayoutStatus.processing }),
    });
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

    // Claim ผ่าน state machine
    expect(stateMachine.claim).toHaveBeenCalledWith(
      PAYOUT_ID,
      PayoutStatus.scheduled,
      PayoutStatus.processing,
      expect.objectContaining({
        reason: 'worker_claim',
        extraPayoutFields: { recipientId: RECIPIENT_ID },
      }),
    );

    // Omise: 90000 satangs, stable idempotency key
    expect(omise.createTransfer).toHaveBeenCalledWith(
      90000,
      RECIPIENT_ID,
      `payout:${PAYOUT_ID}`,
    );

    // transition to paid ผ่าน state machine
    expect(stateMachine.transition).toHaveBeenCalledWith(
      PAYOUT_ID,
      PayoutStatus.paid,
      expect.objectContaining({
        reason: 'omise_transfer_success',
        nextRetryAt: null,
        extraPayoutFields: expect.objectContaining({
          omiseTransferId: 'trsf_x',
        }),
      }),
    );

    // notification
    expect(notifications.create).toHaveBeenCalledWith(
      CAREGIVER_USER_ID,
      NotificationType.payment_transferred,
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ payoutId: PAYOUT_ID }),
    );
  });

  it('idempotency key is stable — no retry_count or timestamp', async () => {
    prisma.payout.findUnique.mockResolvedValue(
      makePayoutRow({ retryCount: 3 }),
    );
    stateMachine.claim.mockResolvedValue({
      claimed: true,
      payout: makePayoutRow({ status: PayoutStatus.processing, retryCount: 3 }),
    });
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
    const [, , key] = omise.createTransfer.mock.calls[0];
    expect(key).toBe(`payout:${PAYOUT_ID}`);
    expect(key.length).toBe(`payout:${PAYOUT_ID}`.length); // no suffix
  });

  // ── satangs conversion ───────────────────────────────────────────────────

  it('satangs conversion — 300.05 THB → 30005 satangs', async () => {
    prisma.payout.findUnique.mockResolvedValue(
      makePayoutRow({ amount: new Prisma.Decimal('300.05') }),
    );
    stateMachine.claim.mockResolvedValue({
      claimed: true,
      payout: makePayoutRow({ status: PayoutStatus.processing }),
    });
    omise.createTransfer.mockResolvedValue({
      id: 't',
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

  // ── retry path ───────────────────────────────────────────────────────────

  it('Omise fail + policy=retry → state machine transition scheduled + retry_count++ + next_retry_at', async () => {
    prisma.payout.findUnique.mockResolvedValue(
      makePayoutRow({ retryCount: 0 }),
    );
    stateMachine.claim.mockResolvedValue({
      claimed: true,
      payout: makePayoutRow({ status: PayoutStatus.processing }),
    });
    omise.createTransfer.mockRejectedValue(new Error('Omise 500'));
    const nextRetryAt = new Date('2026-08-01T10:10:00Z');
    retryPolicy.decide.mockReturnValue({
      kind: 'retry',
      nextRetryAt,
      newRetryCount: 1,
      backoffMinutes: 10,
    });

    await expect(worker.processOne(PAYOUT_ID)).resolves.toBeUndefined();

    expect(retryPolicy.decide).toHaveBeenCalledWith(0);
    // transition ผ่าน state machine (ไม่ใช่ raw update)
    expect(stateMachine.transition).toHaveBeenCalledWith(
      PAYOUT_ID,
      PayoutStatus.scheduled,
      expect.objectContaining({
        reason: 'omise_transfer_failed_retry',
        nextRetryAt,
        extraPayoutFields: { retryCount: { increment: 1 } },
      }),
    );
    // ⚠️ ไม่มี direct set status=failed
    const failedCall = stateMachine.transition.mock.calls.find(
      (c) => c[1] === PayoutStatus.failed,
    );
    expect(failedCall).toBeUndefined();
    expect(notifications.create).not.toHaveBeenCalled();
  });

  // ── terminate path ───────────────────────────────────────────────────────

  it('Omise fail + policy=terminate → tx: transition scheduled then failed', async () => {
    prisma.payout.findUnique.mockResolvedValue(
      makePayoutRow({ retryCount: 4 }),
    );
    stateMachine.claim.mockResolvedValue({
      claimed: true,
      payout: makePayoutRow({ status: PayoutStatus.processing, retryCount: 4 }),
    });
    omise.createTransfer.mockRejectedValue(new Error('Omise dead'));
    retryPolicy.decide.mockReturnValue({ kind: 'terminate', newRetryCount: 5 });

    await worker.processOne(PAYOUT_ID);

    expect(retryPolicy.decide).toHaveBeenCalledWith(4);
    // ต้องเปิด $transaction สำหรับ terminate (scheduled → failed)
    expect(prisma.$transaction).toHaveBeenCalled();

    // ต้องมีทั้ง scheduled และ failed transitions
    const targets = stateMachine.transition.mock.calls.map((c) => c[1]);
    expect(targets).toContain(PayoutStatus.scheduled);
    expect(targets).toContain(PayoutStatus.failed);

    // failed transition มี reason=max_retries_exceeded
    const failedCall = stateMachine.transition.mock.calls.find(
      (c) => c[1] === PayoutStatus.failed,
    );
    expect(failedCall).toBeDefined();
    expect(failedCall![2]).toMatchObject({ reason: 'max_retries_exceeded' });

    // ไม่ส่ง notification ให้ caregiver ตอน failed (ยังไม่มี enum ที่เหมาะ)
    expect(notifications.create).not.toHaveBeenCalled();
  });

  // ── notification failure isolation ───────────────────────────────────────

  it('notification failure does NOT rollback the paid transition', async () => {
    prisma.payout.findUnique.mockResolvedValue(makePayoutRow());
    stateMachine.claim.mockResolvedValue({
      claimed: true,
      payout: makePayoutRow({ status: PayoutStatus.processing }),
    });
    omise.createTransfer.mockResolvedValue({
      id: 'trsf_x',
      status: 'pending',
      amount: 90000,
      recipient: RECIPIENT_ID,
      currency: 'THB',
      sent: false,
      paid: false,
    });
    notifications.create.mockRejectedValue(new Error('notify DB down'));

    await expect(worker.processOne(PAYOUT_ID)).resolves.toBeUndefined();

    // paid transition still happened
    const paidCall = stateMachine.transition.mock.calls.find(
      (c) => c[1] === PayoutStatus.paid,
    );
    expect(paidCall).toBeDefined();
  });

  // ── scan / batch ─────────────────────────────────────────────────────────

  it('run() — empty scan → no processing', async () => {
    prisma.payout.findMany.mockResolvedValue([]);
    await expect(worker.run()).resolves.toBeUndefined();
    expect(stateMachine.claim).not.toHaveBeenCalled();
  });

  it('run() — per-payout errors are isolated (next payout still runs)', async () => {
    prisma.payout.findMany.mockResolvedValue([
      { id: 'payout-a' },
      { id: 'payout-b' },
    ]);
    prisma.payout.findUnique
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(makePayoutRow({ id: 'payout-b' }));
    stateMachine.claim.mockResolvedValue({
      claimed: true,
      payout: makePayoutRow({ status: PayoutStatus.processing }),
    });
    omise.createTransfer.mockResolvedValue({
      id: 't',
      status: 'pending',
      amount: 90000,
      recipient: RECIPIENT_ID,
      currency: 'THB',
      sent: false,
      paid: false,
    });

    await expect(worker.run()).resolves.toBeUndefined();
    expect(omise.createTransfer).toHaveBeenCalledTimes(1);
    expect(omise.createTransfer).toHaveBeenCalledWith(
      90000,
      RECIPIENT_ID,
      'payout:payout-b',
    );
  });
});
