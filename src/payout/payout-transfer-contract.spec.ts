/**
 * Contract test — PayoutWorkerService × OmiseService ตัวจริง
 *
 * ── ทำไมต้องมีไฟล์นี้ทั้งที่ payout-worker.service.spec.ts assert args อยู่แล้ว ──
 *
 * เทสต์ในไฟล์นั้นใช้ `{ provide: OmiseService, useValue: { createTransfer: jest.fn() } }`
 * ซึ่ง **จับบั๊กที่เราเพิ่งเจอไม่ได้เลย**:
 *
 *   commit e819878 (PYG-307) เคยเพิ่ม createTransfer อีกตัวที่รับ args สลับกัน
 *     dev (PYG-330): createTransfer(amountSatangs, recipientId, idempotencyKey)
 *     PYG-307      : createTransfer(recipientId, amountSatangs, idempotencyKey?)
 *   TypeScript ยอมให้ประกาศเมธอดชื่อซ้ำในคลาสเดียวโดยไม่เตือน และตัวหลังชนะตอน runtime
 *   → worker ส่งจำนวนเงินไปเป็น recipient id และส่ง 'recp_...' ไปเป็นจำนวนเงิน
 *
 *   ถ้าวันหนึ่งมีคน merge branch เก่ากลับมา เทสต์แบบ mock จะยังเขียว เพราะ worker
 *   ก็ยัง "เรียกด้วยลำดับเดิม" อยู่ — ตัวที่ตีความผิดคือ implementation จริง
 *   ที่ mock แทนที่ไปแล้ว mock จึงมองไม่เห็นความผิดพลาดชนิดนี้ตลอดกาล
 *
 * ไฟล์นี้จึงใช้ OmiseService ตัวจริง แล้ว mock แค่ `fetch` ชั้นนอกสุด
 * ทำให้ assert ได้ว่า "ค่าที่ออกไปถึง Omise จริง ๆ ลงถูกช่องไหม" ซึ่งเป็นสิ่งเดียว
 * ที่สำคัญจริงเรื่องเงิน — ไม่ว่า signature จะเปลี่ยนไปกี่รอบก็ตาม
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PayoutWorkerService } from './payout-worker.service';
import { PrismaService } from '../common/prisma.service';
import { OmiseService } from '../payment/omise/omise.service';
import { NotificationService } from '../notification/notification.service';
import { PayoutStateMachine } from './payout-state-machine';
import { PayoutStatus } from './entities/payout-status.enum';
import { PayoutRetryPolicy } from './payout-retry-policy';
import { PayoutKillswitch } from './payout-killswitch';
import { PayoutEligibilityService } from './payout-eligibility.service';

const PAYOUT_ID = 'payout-1';
const BOOKING_ID = 'booking-1';
const RECIPIENT_ID = 'recp_test_1';
const API_BASE = 'https://api.omise.test';

describe('Payout → Omise transfer contract (ค่าต้องลงถูกช่องจริง ๆ)', () => {
  let worker: PayoutWorkerService;
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        object: 'transfer',
        id: 'trsf_test_1',
        status: 'pending',
        amount: 90000,
        currency: 'THB',
        recipient: RECIPIENT_ID,
        sent: false,
        paid: false,
      }),
    } as Response);

    const prisma = {
      payout: {
        findUnique: jest.fn().mockResolvedValue({
          id: PAYOUT_ID,
          status: PayoutStatus.scheduled,
          bookingId: BOOKING_ID,
          caregiverId: 'cg-profile-1',
          amount: new Prisma.Decimal('900.00'),
          retryCount: 0,
          caregiver: {
            userId: 'cg-user-1',
            payoutAccount: {
              omiseRecipientId: RECIPIENT_ID,
              recipientStatus: 'verified',
            },
          },
        }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn(async (cb: (t: unknown) => Promise<unknown>) => cb({})),
    };

    const config = {
      get: jest.fn((key: string, fallback?: string) => {
        if (key === 'OMISE_API_BASE') return API_BASE;
        if (key === 'OMISE_SECRET_KEY') return 'skey_test_contract';
        return fallback;
      }),
    };

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        PayoutWorkerService,
        OmiseService, // ★ ตัวจริง ไม่ใช่ mock — คือหัวใจของไฟล์นี้
        { provide: ConfigService, useValue: config },
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationService, useValue: { create: jest.fn().mockResolvedValue({}) } },
        {
          provide: PayoutStateMachine,
          useValue: {
            claim: jest.fn().mockResolvedValue({ claimed: true }),
            transition: jest.fn().mockResolvedValue({}),
          },
        },
        { provide: PayoutRetryPolicy, useValue: { decide: jest.fn() } },
        { provide: PayoutKillswitch, useValue: { gate: jest.fn().mockReturnValue(false) } },
        {
          provide: PayoutEligibilityService,
          useValue: {
            check: jest.fn().mockResolvedValue({
              kind: 'eligible',
              reason: 'proof_valid',
              evidence: {},
            }),
          },
        },
      ],
    }).compile();

    worker = mod.get(PayoutWorkerService);
  });

  afterEach(() => fetchSpy.mockRestore());

  it('payout ฿900 → POST /transfers ที่มี recipient=recp_* และ amount=90000 (ไม่สลับกัน)', async () => {
    await worker.processOne(PAYOUT_ID);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(`${API_BASE}/transfers`);

    const params = init?.body as URLSearchParams;

    // ★ สองบรรทัดนี้คือทั้งหมดที่ไฟล์นี้มีไว้เพื่อ:
    //   ถ้ามีใครเอา createTransfer ที่ args สลับกลับเข้ามา สองบรรทัดนี้จะแดงทันที
    //   ขณะที่เทสต์แบบ mock จะยังเขียวอยู่
    expect(params.get('recipient')).toBe(RECIPIENT_ID);
    expect(params.get('amount')).toBe('90000');

    // recipient ต้องเป็น recp_* ไม่ใช่ตัวเลข / amount ต้องเป็นตัวเลขล้วน
    expect(params.get('recipient')).toMatch(/^recp_/);
    expect(params.get('amount')).toMatch(/^\d+$/);

    // idempotency key ต้องคงที่ต่อ payout — retry แล้ว Omise dedup ได้
    const headers = init?.headers as Record<string, string>;
    expect(headers['Omise-Idempotency-Key']).toBe(`payout:${PAYOUT_ID}`);
  });
});
