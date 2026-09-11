/**
 * BookingSettlementService tests (PYG-461/462 เฟส 2)
 *
 * ใช้ของจริง: PaymentStateMachine + RefundService + IdempotencyService (โค้ดเงินจริงทั้งเส้น)
 * mock: OmiseService (ห้ามยิงจริง), PaymentService.captureFromWebhook, ClockService, EventEmitter
 * DB: FakeDb ในไฟล์นี้ — in-memory ที่ (1) rollback จริงเมื่อ tx throw (2) รัน tx ทีละตัวแทน FOR UPDATE
 *
 * ครอบ: matrix (payment state × SettlementReason) ทุกช่อง · Omise fail → booking ไม่เปลี่ยน ·
 *       เรียกซ้ำ/พร้อมกัน → ไม่คืนซ้ำ · payout ออกไปแล้ว → error ชัด · ก่อน/หลัง cutoff ·
 *       payment_status_history ครบทุก transition · lock order · PromptPay 4 เคส
 *
 * ⚠ ข้อจำกัด: ไม่มี Postgres จริง — FakeDb จำลอง "ผลลัพธ์" ของ lock/rollback ไม่ได้พิสูจน์ตัว lock เอง
 */
import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  BookingSettlementService,
  refundPercentageFor,
} from './booking-settlement.service';
import {
  SettlementBlockedError,
  SettlementReason,
  type Actor,
} from './booking-settlement.types';
import { CANCELLATION_POLICY } from './cancellation-policy.config';
import { PaymentStateMachine } from '../payment-state-machine';
import { RefundService } from '../refund.service';
import { IdempotencyService } from '../idempotency.service';
import { BOOKING_EVENTS } from '../../notification/events/booking-event';

// FakeDb เป็น in-memory stand-in ของ Prisma client — ต้องใช้ any + alias this ใน closure ของ client()
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-this-alias */
type Row = Record<string, any>;

const BOOKING_ID = 'bk-1';
const PAYMENT_ID = 'pay-1';
const CHARGE = 'chrg_1';
const PATIENT = 'user-patient';
const CG_USER = 'user-cg';
// เวลาเริ่มงาน 2026-07-10 09:00 เวลาไทย = 02:00Z · NOW = 9 วันก่อน (เกิน cutoff 24 ชม.)
const START = new Date('2026-07-10T02:00:00.000Z');
const NOW = new Date('2026-07-01T02:00:00.000Z');
const HOUR = 60 * 60 * 1000;

// ── FakeDb ──────────────────────────────────────────────────────────────────

class FakeDb {
  bookings = new Map<string, Row>();
  payments = new Map<string, Row>();
  payouts = new Map<string, Row>(); // key = bookingId
  idempotencyKeys = new Map<string, Row>();
  paymentStatusHistory: Row[] = [];
  bookingStatusHistory: Row[] = [];
  lockLog: string[] = [];
  /** จำลอง insert history พังครั้งถัดไป (ทดสอบ rollback หลัง Omise สำเร็จ) */
  failNextBookingHistory = false;
  /**
   * รันครั้งเดียวทันทีหลัง pre-read (ขั้น ① ที่ไม่ล็อก) คืนค่าไปแล้ว — จำลองมีคนแก้ DB
   * ระหว่าง ① กับ ③ (ก่อน settle ได้ lock)
   */
  afterPreRead?: () => void;
  private queue: Promise<unknown> = Promise.resolve();

  dump(): Row {
    return structuredClone({
      bookings: [...this.bookings],
      payments: [...this.payments],
      payouts: [...this.payouts],
      keys: [...this.idempotencyKeys],
      psh: this.paymentStatusHistory,
      bsh: this.bookingStatusHistory,
    });
  }

  private restore(s: Row): void {
    this.bookings = new Map(s.bookings);
    this.payments = new Map(s.payments);
    this.payouts = new Map(s.payouts);
    this.idempotencyKeys = new Map(s.keys);
    this.paymentStatusHistory = s.psh;
    this.bookingStatusHistory = s.bsh;
  }

  paymentOf(bookingId: string): Row | undefined {
    return [...this.payments.values()].find((p) => p.bookingId === bookingId);
  }

  client(): any {
    const db = this;
    const clone = (v: Row | undefined): Row | null =>
      v ? structuredClone(v) : null;
    const c: any = {
      $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join('?');
        if (sql.includes('FOR UPDATE')) {
          db.lockLog.push(
            `${sql.includes('"bookings"') ? 'bookings' : 'payments'}:${String(values[0])}`,
          );
        }
        return Promise.resolve([]);
      },
      booking: {
        findUnique: ({ where, include }: Row) => {
          const b = clone(db.bookings.get(where.id));
          if (b && include?.payment) b.payment = clone(db.paymentOf(where.id));
          // include.payment = pre-read ของ settle (ขั้น ①) — ผลถูก clone ไปแล้ว ค่อยแก้ DB ตามหลัง
          if (include?.payment && db.afterPreRead) {
            const hook = db.afterPreRead;
            db.afterPreRead = undefined;
            hook();
          }
          return Promise.resolve(b);
        },
        update: ({ where, data }: Row) => {
          Object.assign(db.bookings.get(where.id)!, data);
          return Promise.resolve(clone(db.bookings.get(where.id)));
        },
      },
      payment: {
        findUnique: ({ where }: Row) =>
          Promise.resolve(
            clone(
              where.id
                ? db.payments.get(where.id)
                : db.paymentOf(where.bookingId),
            ),
          ),
        update: ({ where, data }: Row) => {
          Object.assign(db.payments.get(where.id)!, data);
          return Promise.resolve(clone(db.payments.get(where.id)));
        },
      },
      payout: {
        findUnique: ({ where }: Row) =>
          Promise.resolve(clone(db.payouts.get(where.bookingId))),
      },
      paymentStatusHistory: {
        create: ({ data }: Row) => {
          db.paymentStatusHistory.push(structuredClone(data));
          return Promise.resolve({});
        },
      },
      bookingStatusHistory: {
        create: ({ data }: Row) => {
          if (db.failNextBookingHistory) {
            db.failNextBookingHistory = false;
            return Promise.reject(
              new Error('insert booking_status_history failed'),
            );
          }
          db.bookingStatusHistory.push(structuredClone(data));
          return Promise.resolve({});
        },
      },
      idempotencyKey: {
        create: ({ data }: Row) => {
          if (db.idempotencyKeys.has(data.key)) {
            return Promise.reject(
              new Prisma.PrismaClientKnownRequestError(
                'Unique constraint failed',
                {
                  code: 'P2002',
                  clientVersion: 'test',
                },
              ),
            );
          }
          db.idempotencyKeys.set(data.key, { ...data, result: null });
          return Promise.resolve({});
        },
        findUnique: ({ where }: Row) =>
          Promise.resolve(clone(db.idempotencyKeys.get(where.key))),
        update: ({ where, data }: Row) => {
          Object.assign(db.idempotencyKeys.get(where.key)!, data);
          return Promise.resolve({});
        },
      },
      // tx ทีละตัว (แทน FOR UPDATE) + rollback ทั้งก้อนเมื่อ throw
      $transaction: (fn: (tx: any) => Promise<unknown>) => {
        const run = db.queue.then(async () => {
          const snap = db.dump();
          try {
            return await fn(c);
          } catch (e) {
            db.restore(snap);
            throw e;
          }
        });
        db.queue = run.catch(() => undefined);
        return run;
      },
    };
    return c;
  }
}

// ── setup ───────────────────────────────────────────────────────────────────

function seedBooking(db: FakeDb, status: string): void {
  db.bookings.set(BOOKING_ID, {
    id: BOOKING_ID,
    status,
    patientId: PATIENT,
    bookingDate: new Date('2026-07-10'),
    startTime: new Date('1970-01-01T09:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
  });
}

function seedPayment(db: FakeDb, status: string, overrides: Row = {}): void {
  const captured = [
    'captured',
    'partially_refunded',
    'refunded',
    'transferred',
  ].includes(status);
  db.payments.set(PAYMENT_ID, {
    id: PAYMENT_ID,
    bookingId: BOOKING_ID,
    patientId: PATIENT,
    caregiverId: CG_USER,
    amount: 1200,
    capturedAmount: captured ? 1200 : null,
    refundedAmount:
      status === 'partially_refunded' ? 400 : status === 'refunded' ? 1200 : 0,
    paymentStatus: status,
    paymentMethod: status === 'held' ? 'credit_card' : 'promptpay',
    omiseChargeId: CHARGE,
    metadata: {},
    ...overrides,
  });
}

function build(now: Date = NOW) {
  const db = new FakeDb();
  const prisma = db.client();
  const omise = {
    voidCharge: jest.fn().mockResolvedValue({ id: CHARGE, status: 'reversed' }),
    createRefund: jest.fn().mockResolvedValue({ id: 'rfnd_1' }),
    retrieveCharge: jest.fn(),
  };
  const events = { emit: jest.fn() };
  const fsm = new PaymentStateMachine(prisma);
  const idempotency = new IdempotencyService(prisma);
  const refunds = new RefundService(
    prisma,
    fsm,
    omise as never,
    events as never,
    idempotency,
  );
  const payments = {
    captureFromWebhook: jest.fn().mockResolvedValue(undefined),
  };
  const clock = { now: () => now };
  const service = new BookingSettlementService(
    prisma,
    fsm,
    omise as never,
    idempotency,
    refunds,
    payments as never,
    events as never,
    clock as never,
  );
  return { db, omise, events, payments, service };
}

/** จำลองผลของ captureFromWebhook ตัวจริง: pending → captured + booking → confirmed + history */
function simulateWebhookCapture(db: FakeDb): () => Promise<void> {
  return () => {
    const p = db.payments.get(PAYMENT_ID)!;
    db.paymentStatusHistory.push({
      paymentId: PAYMENT_ID,
      fromStatus: p.paymentStatus,
      toStatus: 'captured',
    });
    p.paymentStatus = 'captured';
    db.bookings.get(BOOKING_ID)!.status = 'confirmed';
    return Promise.resolve();
  };
}

async function blocked(p: Promise<unknown>): Promise<SettlementBlockedError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SettlementBlockedError);
  return err as SettlementBlockedError;
}

const SYSTEM: Actor = { id: null, role: 'system' };
const PATIENT_ACTOR: Actor = { id: PATIENT, role: 'patient' };

/** reason × สถานะ booking ต้นทางที่ reason นั้นใช้ได้ × สถานะปลายทาง */
const REASONS: Array<[SettlementReason, string, string, Actor, string]> = [
  [
    SettlementReason.PATIENT_CANCEL,
    'confirmed',
    'cancelled',
    PATIENT_ACTOR,
    'patient_cancel',
  ],
  [
    SettlementReason.EXPIRED_NO_ACCEPT,
    'pending',
    'expired',
    SYSTEM,
    'booking_expired',
  ],
  [
    SettlementReason.EXPIRED_NO_PAYMENT,
    'accepted',
    'expired',
    SYSTEM,
    'booking_expired',
  ],
  [
    SettlementReason.CAREGIVER_NO_SHOW,
    'confirmed',
    'expired',
    SYSTEM,
    'caregiver_no_show',
  ],
];

afterEach(() => {
  jest.restoreAllMocks();
});

// ── matrix: payment state × SettlementReason ────────────────────────────────

describe.each(REASONS)(
  'matrix — reason=%s (booking %s → %s)',
  (reason, fromStatus, target, actor, refundSource) => {
    it.each([['ไม่มี row'], ['failed'], ['expired'], ['voided']])(
      'payment %s → ปิด booking ได้เลย ไม่แตะเงิน',
      async (state) => {
        const { db, omise, service } = build();
        seedBooking(db, fromStatus);
        if (state !== 'ไม่มี row') seedPayment(db, state);

        const res = await service.settle(BOOKING_ID, reason, actor);

        expect(res).toMatchObject({
          alreadySettled: false,
          moneyAction: 'none',
          bookingStatusAfter: target,
        });
        expect(db.bookings.get(BOOKING_ID)!.status).toBe(target);
        expect(omise.voidCharge).not.toHaveBeenCalled();
        expect(omise.createRefund).not.toHaveBeenCalled();
        expect(omise.retrieveCharge).not.toHaveBeenCalled();
        expect(db.paymentStatusHistory).toHaveLength(0);
        expect(db.bookingStatusHistory).toEqual([
          expect.objectContaining({
            bookingId: BOOKING_ID,
            fromStatus,
            toStatus: target,
            changedBy: actor.id,
            reason,
          }),
        ]);
      },
    );

    it('held (บัตร) → void ที่ Omise (key void:{chargeId}) → voided + history + PAYMENT_VOIDED', async () => {
      const { db, omise, events, service } = build();
      seedBooking(db, fromStatus);
      seedPayment(db, 'held');

      const res = await service.settle(BOOKING_ID, reason, actor);

      expect(omise.voidCharge).toHaveBeenCalledTimes(1);
      expect(omise.voidCharge).toHaveBeenCalledWith(CHARGE, `void:${CHARGE}`);
      expect(db.payments.get(PAYMENT_ID)!.paymentStatus).toBe('voided');
      expect(db.paymentStatusHistory).toEqual([
        expect.objectContaining({
          paymentId: PAYMENT_ID,
          fromStatus: 'held',
          toStatus: 'voided',
        }),
      ]);
      expect(db.bookings.get(BOOKING_ID)!.status).toBe(target);
      expect(db.bookingStatusHistory).toHaveLength(1);
      expect(res).toMatchObject({
        moneyAction: 'voided',
        paymentStatusAfter: 'voided',
      });
      expect(events.emit).toHaveBeenCalledWith(
        BOOKING_EVENTS.PAYMENT_VOIDED,
        expect.objectContaining({
          bookingId: BOOKING_ID,
          patientId: PATIENT,
          caregiverId: CG_USER,
        }),
      );
    });

    it(`captured → RefundService คืนเต็ม → refunded + history (source=${refundSource}) + REFUND_ISSUED`, async () => {
      const { db, omise, events, service } = build();
      seedBooking(db, fromStatus);
      seedPayment(db, 'captured');

      const res = await service.settle(BOOKING_ID, reason, actor);

      expect(omise.createRefund).toHaveBeenCalledTimes(1);
      expect(omise.createRefund).toHaveBeenCalledWith(
        CHARGE,
        undefined,
        `refund:${PAYMENT_ID}:0`,
      );
      expect(db.payments.get(PAYMENT_ID)!.paymentStatus).toBe('refunded');
      expect(db.payments.get(PAYMENT_ID)!.refundedAmount).toBe(1200);
      expect(db.paymentStatusHistory).toEqual([
        expect.objectContaining({
          fromStatus: 'captured',
          toStatus: 'refunded',
          metadata: expect.objectContaining({ source: refundSource }),
        }),
      ]);
      expect(res).toMatchObject({
        moneyAction: 'refunded',
        refundAmount: 1200,
        refundPercentage: 100,
      });
      expect(events.emit).toHaveBeenCalledWith(
        BOOKING_EVENTS.REFUND_ISSUED,
        expect.objectContaining({
          metadata: expect.objectContaining({
            amount: 1200,
            omiseRefundId: 'rfnd_1',
          }),
        }),
      );
    });

    it('pending PromptPay + Omise บอกจ่ายแล้ว → reuse captureFromWebhook แล้วคืนเงิน', async () => {
      const { db, omise, payments, service } = build();
      seedBooking(db, fromStatus);
      seedPayment(db, 'pending');
      omise.retrieveCharge.mockResolvedValue({
        id: CHARGE,
        status: 'successful',
        paid: true,
      });
      payments.captureFromWebhook.mockImplementation(
        simulateWebhookCapture(db),
      );

      const res = await service.settle(BOOKING_ID, reason, actor);

      expect(payments.captureFromWebhook).toHaveBeenCalledWith(CHARGE);
      expect(omise.createRefund).toHaveBeenCalledTimes(1);
      expect(db.payments.get(PAYMENT_ID)!.paymentStatus).toBe('refunded');
      expect(
        db.paymentStatusHistory.map((h) => `${h.fromStatus}→${h.toStatus}`),
      ).toEqual(['pending→captured', 'captured→refunded']);
      expect(db.bookingStatusHistory[0]).toMatchObject({
        fromStatus: 'confirmed', // captureFromWebhook พลิกเป็น confirmed ก่อนเสมอ
        toStatus: target,
        metadata: expect.objectContaining({ promptpayLateCapture: true }),
      });
      expect(res.moneyAction).toBe('refunded');
    });

    it('pending PromptPay + Omise บอก expired → pending→expired ไม่มีเงินขยับ', async () => {
      const { db, omise, service } = build();
      seedBooking(db, fromStatus);
      seedPayment(db, 'pending');
      omise.retrieveCharge.mockResolvedValue({
        id: CHARGE,
        status: 'expired',
        paid: false,
        expiresAt: null,
      });

      const res = await service.settle(BOOKING_ID, reason, actor);

      expect(db.payments.get(PAYMENT_ID)!.paymentStatus).toBe('expired');
      expect(db.paymentStatusHistory).toEqual([
        expect.objectContaining({ fromStatus: 'pending', toStatus: 'expired' }),
      ]);
      expect(omise.voidCharge).not.toHaveBeenCalled();
      expect(omise.createRefund).not.toHaveBeenCalled();
      expect(db.bookings.get(BOOKING_ID)!.status).toBe(target);
      expect(res.moneyAction).toBe('promptpay_expired');
    });

    it('pending PromptPay ยังสแกนได้ (expires_at ยังไม่ถึงตาม ClockService) → 422 retryable ไม่มีอะไรเปลี่ยน', async () => {
      const { db, omise, service } = build();
      seedBooking(db, fromStatus);
      seedPayment(db, 'pending');
      omise.retrieveCharge.mockResolvedValue({
        id: CHARGE,
        status: 'pending',
        paid: false,
        expiresAt: new Date(NOW.getTime() + HOUR).toISOString(),
      });
      const before = db.dump();

      const err = await blocked(service.settle(BOOKING_ID, reason, actor));

      expect(err.code).toBe('promptpay_still_scannable');
      expect(err.retryable).toBe(true);
      expect(db.dump()).toEqual(before);
    });

    it('pending PromptPay + retrieveCharge พัง → 422 omise_unreachable (fail-closed) ไม่มีอะไรใน DB เปลี่ยน', async () => {
      const { db, omise, payments, service } = build();
      seedBooking(db, fromStatus);
      seedPayment(db, 'pending');
      omise.retrieveCharge.mockRejectedValue(new Error('Omise timeout'));
      const before = db.dump();

      const err = await blocked(service.settle(BOOKING_ID, reason, actor));

      expect(err.code).toBe('omise_unreachable');
      expect(db.dump()).toEqual(before);
      expect(payments.captureFromWebhook).not.toHaveBeenCalled();
    });

    it.each(['partially_refunded', 'refunded', 'transferred'])(
      '%s → 422 payment_not_settleable บอกสถานะ ไม่แตะอะไร',
      async (state) => {
        const { db, omise, service } = build();
        seedBooking(db, fromStatus);
        seedPayment(db, state);
        const before = db.dump();

        const err = await blocked(service.settle(BOOKING_ID, reason, actor));

        expect(err.code).toBe('payment_not_settleable');
        expect(err.details).toMatchObject({ paymentStatus: state });
        expect(db.dump()).toEqual(before);
        expect(omise.voidCharge).not.toHaveBeenCalled();
        expect(omise.createRefund).not.toHaveBeenCalled();
      },
    );
  },
);

// ── PromptPay: ตัดสินด้วย expires_at ผ่าน ClockService ───────────────────────

describe('PromptPay pending — expires_at', () => {
  it('Omise ยัง status=pending แต่ ClockService เลย expires_at แล้ว → expired', async () => {
    const { db, omise, service } = build();
    seedBooking(db, 'accepted');
    seedPayment(db, 'pending');
    omise.retrieveCharge.mockResolvedValue({
      id: CHARGE,
      status: 'pending',
      paid: false,
      expiresAt: new Date(NOW.getTime() - 1000).toISOString(),
    });

    const res = await service.settle(
      BOOKING_ID,
      SettlementReason.EXPIRED_NO_PAYMENT,
      SYSTEM,
    );

    expect(res.moneyAction).toBe('promptpay_expired');
    expect(db.payments.get(PAYMENT_ID)!.paymentStatus).toBe('expired');
  });

  it('retrieve บอกหมดอายุ แต่ webhook จ่ายเข้ามาก่อนเราได้ lock → สถานะใต้ lock ชนะ → คืนเงิน', async () => {
    const { db, omise, service } = build();
    seedBooking(db, 'accepted');
    seedPayment(db, 'pending');
    omise.retrieveCharge.mockImplementation(() => {
      // webhook มาแทรกระหว่าง ② กับ ③
      db.payments.get(PAYMENT_ID)!.paymentStatus = 'captured';
      db.payments.get(PAYMENT_ID)!.capturedAmount = 1200;
      return Promise.resolve({ id: CHARGE, status: 'expired', paid: false });
    });

    const res = await service.settle(
      BOOKING_ID,
      SettlementReason.EXPIRED_NO_PAYMENT,
      SYSTEM,
    );

    expect(res.moneyAction).toBe('refunded');
    expect(omise.createRefund).toHaveBeenCalledTimes(1);
  });

  it('จ่ายแล้วแต่ captureFromWebhook ไม่ได้พลิกจริง (payment ยัง pending ใต้ lock) → state_changed_retry ไม่เปลี่ยนอะไร', async () => {
    const { db, omise, service } = build();
    seedBooking(db, 'accepted');
    seedPayment(db, 'pending');
    omise.retrieveCharge.mockResolvedValue({
      id: CHARGE,
      status: 'successful',
      paid: true,
    });
    const before = db.dump();

    const err = await blocked(
      service.settle(BOOKING_ID, SettlementReason.EXPIRED_NO_PAYMENT, SYSTEM),
    );

    expect(err.code).toBe('state_changed_retry');
    expect(db.dump()).toEqual(before);
  });

  it('QR ถูกสร้างใหม่ระหว่างทาง (chargeId ใต้ lock ไม่ตรง) → state_changed_retry', async () => {
    const { db, omise, service } = build();
    seedBooking(db, 'accepted');
    seedPayment(db, 'pending');
    omise.retrieveCharge.mockImplementation(() => {
      db.payments.get(PAYMENT_ID)!.omiseChargeId = 'chrg_new';
      return Promise.resolve({ id: CHARGE, status: 'expired', paid: false });
    });

    const err = await blocked(
      service.settle(BOOKING_ID, SettlementReason.EXPIRED_NO_PAYMENT, SYSTEM),
    );

    expect(err.code).toBe('state_changed_retry');
    expect(db.payments.get(PAYMENT_ID)!.paymentStatus).toBe('pending');
  });
});

// ── Omise fail → booking ต้องไม่เปลี่ยนสถานะ ──────────────────────────────────

describe('Omise fail → booking ต้องไม่เปลี่ยนสถานะ', () => {
  it('void fail → ServiceUnavailable + rollback ทั้งก้อน (booking/payment/history/idempotency key)', async () => {
    const { db, omise, events, service } = build();
    seedBooking(db, 'confirmed');
    seedPayment(db, 'held');
    omise.voidCharge.mockRejectedValue(new Error('Omise 503'));
    const before = db.dump();

    await expect(
      service.settle(
        BOOKING_ID,
        SettlementReason.PATIENT_CANCEL,
        PATIENT_ACTOR,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(db.dump()).toEqual(before);
    expect(db.bookings.get(BOOKING_ID)!.status).toBe('confirmed');
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('refund fail → ServiceUnavailable + booking ไม่เปลี่ยน (ไม่มี cancelled ทั้งที่เงินยังไม่คืน)', async () => {
    const { db, omise, events, service } = build();
    seedBooking(db, 'confirmed');
    seedPayment(db, 'captured');
    omise.createRefund.mockRejectedValue(new Error('Omise 503'));
    const before = db.dump();

    await expect(
      service.settle(
        BOOKING_ID,
        SettlementReason.PATIENT_CANCEL,
        PATIENT_ACTOR,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(db.dump()).toEqual(before);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('Omise สำเร็จแต่ tx rollback ทีหลัง → DB กลับเหมือนเดิม และรอบถัดไปส่ง key เดิมให้ Omise (dedup ชั้น Omise)', async () => {
    const { db, omise, service } = build();
    seedBooking(db, 'confirmed');
    seedPayment(db, 'held');
    db.failNextBookingHistory = true;
    const before = db.dump();

    await expect(
      service.settle(
        BOOKING_ID,
        SettlementReason.PATIENT_CANCEL,
        PATIENT_ACTOR,
      ),
    ).rejects.toThrow('insert booking_status_history failed');
    expect(db.dump()).toEqual(before); // แถว idempotency_keys หายไปกับ rollback ด้วย

    await service.settle(
      BOOKING_ID,
      SettlementReason.PATIENT_CANCEL,
      PATIENT_ACTOR,
    );

    // ⚠ ชั้น DB กันไม่ได้ในเคสนี้ — ที่กันจริงคือ Omise-Idempotency-Key เดิมทั้งสองครั้ง
    expect(omise.voidCharge).toHaveBeenCalledTimes(2);
    expect(omise.voidCharge.mock.calls[0][1]).toBe(`void:${CHARGE}`);
    expect(omise.voidCharge.mock.calls[1][1]).toBe(`void:${CHARGE}`);
    expect(db.payments.get(PAYMENT_ID)!.paymentStatus).toBe('voided');
  });
});

// ── idempotent ──────────────────────────────────────────────────────────────

describe('เรียกซ้ำ → ไม่คืนเงินซ้ำ', () => {
  it('captured: เรียกซ้ำตามลำดับ → ครั้งที่ 2 alreadySettled, createRefund ครั้งเดียว, history ไม่เพิ่ม', async () => {
    const { db, omise, service } = build();
    seedBooking(db, 'confirmed');
    seedPayment(db, 'captured');

    await service.settle(
      BOOKING_ID,
      SettlementReason.PATIENT_CANCEL,
      PATIENT_ACTOR,
    );
    const second = await service.settle(
      BOOKING_ID,
      SettlementReason.PATIENT_CANCEL,
      PATIENT_ACTOR,
    );

    expect(second).toMatchObject({ alreadySettled: true, moneyAction: 'none' });
    expect(omise.createRefund).toHaveBeenCalledTimes(1);
    expect(db.paymentStatusHistory).toHaveLength(1);
    expect(db.bookingStatusHistory).toHaveLength(1);
  });

  it('held: cron กับผู้ใช้เรียกพร้อมกัน → void ครั้งเดียว อีกตัวได้ alreadySettled', async () => {
    const { db, omise, service } = build();
    seedBooking(db, 'confirmed');
    seedPayment(db, 'held');

    const results = await Promise.all([
      service.settle(
        BOOKING_ID,
        SettlementReason.PATIENT_CANCEL,
        PATIENT_ACTOR,
      ),
      service.settle(BOOKING_ID, SettlementReason.PATIENT_CANCEL, SYSTEM),
    ]);

    expect(omise.voidCharge).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.alreadySettled).sort()).toEqual([false, true]);
    expect(db.paymentStatusHistory).toHaveLength(1);
  });

  it('captured: เรียกพร้อมกัน → createRefund ครั้งเดียว', async () => {
    const { db, omise, service } = build();
    seedBooking(db, 'accepted');
    seedPayment(db, 'captured');

    await Promise.all([
      service.settle(BOOKING_ID, SettlementReason.EXPIRED_NO_PAYMENT, SYSTEM),
      service.settle(BOOKING_ID, SettlementReason.EXPIRED_NO_PAYMENT, SYSTEM),
    ]);

    expect(omise.createRefund).toHaveBeenCalledTimes(1);
    expect(db.payments.get(PAYMENT_ID)!.refundedAmount).toBe(1200);
  });
});

// ── payout ออกไปแล้ว ─────────────────────────────────────────────────────────

describe('payout ออกไปแล้ว → error ชัดเจน (ยังไม่แก้ให้ refund ผ่าน — product decision แยก)', () => {
  it.each(['paid', 'processing'])(
    'payout %s → 422 payout_already_released + payoutId/status ไม่แตะอะไร',
    async (status) => {
      const { db, omise, service } = build();
      seedBooking(db, 'confirmed');
      seedPayment(db, 'captured');
      db.payouts.set(BOOKING_ID, { id: 'po-1', bookingId: BOOKING_ID, status });
      const before = db.dump();

      const err = await blocked(
        service.settle(BOOKING_ID, SettlementReason.CAREGIVER_NO_SHOW, SYSTEM),
      );

      expect(err.code).toBe('payout_already_released');
      expect(err.retryable).toBe(false);
      expect(err.details).toMatchObject({
        payoutId: 'po-1',
        payoutStatus: status,
      });
      expect(db.dump()).toEqual(before);
      expect(omise.createRefund).not.toHaveBeenCalled();
    },
  );

  it('payout scheduled (ยังไม่โอน) → คืนเงินได้ (PayoutEligibility จะ deny payout เองเมื่อ refunded_amount > 0)', async () => {
    const { db, omise, service } = build();
    seedBooking(db, 'confirmed');
    seedPayment(db, 'captured');
    db.payouts.set(BOOKING_ID, {
      id: 'po-1',
      bookingId: BOOKING_ID,
      status: 'scheduled',
    });

    const res = await service.settle(
      BOOKING_ID,
      SettlementReason.CAREGIVER_NO_SHOW,
      SYSTEM,
    );

    expect(res.moneyAction).toBe('refunded');
    expect(omise.createRefund).toHaveBeenCalledTimes(1);
  });
});

// ── นโยบาย: ก่อน/หลัง cutoff ─────────────────────────────────────────────────

describe('นโยบาย cutoff (CANCELLATION_FULL_REFUND_CUTOFF_HOURS=24)', () => {
  it('refundPercentageFor: ขอบ 24 ชม. พอดี = คืนเต็ม, ต่ำกว่า = LATE %, reason อื่นไม่สน cutoff', () => {
    const policy = {
      ...CANCELLATION_POLICY,
      LATE_CANCELLATION_REFUND_PERCENTAGE: 50,
    };
    const at = (h: number) => new Date(START.getTime() - h * HOUR);
    expect(
      refundPercentageFor(
        SettlementReason.PATIENT_CANCEL,
        START,
        at(24),
        policy,
      ),
    ).toBe(100);
    expect(
      refundPercentageFor(
        SettlementReason.PATIENT_CANCEL,
        START,
        at(23.99),
        policy,
      ),
    ).toBe(50);
    expect(
      refundPercentageFor(
        SettlementReason.CAREGIVER_NO_SHOW,
        START,
        at(0),
        policy,
      ),
    ).toBe(100);
    expect(
      refundPercentageFor(
        SettlementReason.EXPIRED_NO_PAYMENT,
        START,
        at(0),
        policy,
      ),
    ).toBe(100);
  });

  it('ค่า default (LATE=100 รอทีมเคาะ) → ยกเลิกช้าก็ยังคืนเต็ม', async () => {
    const { db, omise, service } = build(new Date(START.getTime() - 2 * HOUR));
    seedBooking(db, 'confirmed');
    seedPayment(db, 'captured');

    const res = await service.settle(
      BOOKING_ID,
      SettlementReason.PATIENT_CANCEL,
      PATIENT_ACTOR,
    );

    expect(omise.createRefund).toHaveBeenCalledWith(
      CHARGE,
      undefined,
      `refund:${PAYMENT_ID}:0`,
    );
    expect(res.refundPercentage).toBe(100);
  });

  it('LATE=50: ก่อน cutoff (25 ชม.) คืนเต็ม / หลัง cutoff (23 ชม.) คืน 50% → ยอดต่างกันตาม config', async () => {
    jest.replaceProperty(
      CANCELLATION_POLICY,
      'LATE_CANCELLATION_REFUND_PERCENTAGE',
      50,
    );

    const early = build(new Date(START.getTime() - 25 * HOUR));
    seedBooking(early.db, 'confirmed');
    seedPayment(early.db, 'captured');
    const r1 = await early.service.settle(
      BOOKING_ID,
      SettlementReason.PATIENT_CANCEL,
      PATIENT_ACTOR,
    );

    const late = build(new Date(START.getTime() - 23 * HOUR));
    seedBooking(late.db, 'confirmed');
    seedPayment(late.db, 'captured');
    const r2 = await late.service.settle(
      BOOKING_ID,
      SettlementReason.PATIENT_CANCEL,
      PATIENT_ACTOR,
    );

    expect(early.omise.createRefund).toHaveBeenCalledWith(
      CHARGE,
      undefined,
      `refund:${PAYMENT_ID}:0`,
    );
    expect(r1).toMatchObject({
      refundAmount: 1200,
      refundPercentage: 100,
      paymentStatusAfter: 'refunded',
    });
    expect(late.omise.createRefund).toHaveBeenCalledWith(
      CHARGE,
      60000,
      `refund:${PAYMENT_ID}:0`,
    );
    expect(r2).toMatchObject({
      refundAmount: 600,
      refundPercentage: 50,
      paymentStatusAfter: 'partially_refunded',
    });
  });

  it('LATE=50 กับบัตร held → 422 policy_not_supported (void ได้ทั้งก้อนเท่านั้น) ไม่เรียก Omise', async () => {
    jest.replaceProperty(
      CANCELLATION_POLICY,
      'LATE_CANCELLATION_REFUND_PERCENTAGE',
      50,
    );
    const { db, omise, service } = build(new Date(START.getTime() - 2 * HOUR));
    seedBooking(db, 'confirmed');
    seedPayment(db, 'held');

    const err = await blocked(
      service.settle(
        BOOKING_ID,
        SettlementReason.PATIENT_CANCEL,
        PATIENT_ACTOR,
      ),
    );

    expect(err.code).toBe('policy_not_supported');
    expect(omise.voidCharge).not.toHaveBeenCalled();
  });

  it("OMISE_FEE_BORNE_BY='patient' (ยังไม่ implement) → 422 policy_not_supported ไม่เดาค่าธรรมเนียม", async () => {
    jest.replaceProperty(CANCELLATION_POLICY, 'OMISE_FEE_BORNE_BY', 'patient');
    const { db, omise, service } = build();
    seedBooking(db, 'confirmed');
    seedPayment(db, 'captured');

    const err = await blocked(
      service.settle(
        BOOKING_ID,
        SettlementReason.PATIENT_CANCEL,
        PATIENT_ACTOR,
      ),
    );

    expect(err.code).toBe('policy_not_supported');
    expect(omise.createRefund).not.toHaveBeenCalled();
  });
});

// ── booking / lock order ─────────────────────────────────────────────────────

describe('booking + lock', () => {
  it('ไม่พบ booking → NotFound', async () => {
    const { service } = build();
    await expect(
      service.settle('nope', SettlementReason.PATIENT_CANCEL, PATIENT_ACTOR),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([
    [SettlementReason.EXPIRED_NO_PAYMENT, 'pending'],
    [SettlementReason.EXPIRED_NO_ACCEPT, 'confirmed'],
    [SettlementReason.PATIENT_CANCEL, 'in_progress'],
    [SettlementReason.CAREGIVER_NO_SHOW, 'completed'],
  ])(
    'reason=%s กับ booking %s → 422 booking_not_settleable',
    async (reason, status) => {
      const { db, omise, service } = build();
      seedBooking(db, status);
      seedPayment(db, 'held');

      const err = await blocked(service.settle(BOOKING_ID, reason, SYSTEM));

      expect(err.code).toBe('booking_not_settleable');
      expect(omise.voidCharge).not.toHaveBeenCalled();
    },
  );

  it('booking อยู่ในสถานะปลายทางแล้ว (เช่น cron เฟส 1 ปิดไปก่อน) → alreadySettled ไม่ถาม Omise', async () => {
    const { db, omise, service } = build();
    seedBooking(db, 'expired');

    const res = await service.settle(
      BOOKING_ID,
      SettlementReason.EXPIRED_NO_ACCEPT,
      SYSTEM,
    );

    expect(res.alreadySettled).toBe(true);
    expect(omise.retrieveCharge).not.toHaveBeenCalled();
  });

  it('LOCK ORDER: bookings ก่อน payments เสมอ', async () => {
    const { db, service } = build();
    seedBooking(db, 'confirmed');
    seedPayment(db, 'captured');

    await service.settle(
      BOOKING_ID,
      SettlementReason.PATIENT_CANCEL,
      PATIENT_ACTOR,
    );

    expect(db.lockLog[0]).toBe(`bookings:${BOOKING_ID}`);
    expect(db.lockLog[1]).toBe(`payments:${BOOKING_ID}`);
  });

  it('in-flight (idempotency key ถูกจองแต่ยังไม่มีผล) → ConflictException ไม่ void ซ้ำ', async () => {
    const { db, omise, service } = build();
    seedBooking(db, 'confirmed');
    seedPayment(db, 'held');
    db.idempotencyKeys.set(`void:${CHARGE}`, {
      key: `void:${CHARGE}`,
      action: 'void',
      result: null,
    });

    await expect(
      service.settle(
        BOOKING_ID,
        SettlementReason.PATIENT_CANCEL,
        PATIENT_ACTOR,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(omise.voidCharge).not.toHaveBeenCalled();
    expect(db.bookings.get(BOOKING_ID)!.status).toBe('confirmed');
  });
});

// ── กิ่งที่เหลือ (ให้ทุกบรรทัดเงินมีเทสคุม) ─────────────────────────────────────

describe('กิ่งที่เหลือของ matrix', () => {
  it('held แต่ไม่มี omiseChargeId → 422 payment_not_settleable ไม่เรียก Omise ไม่เปลี่ยนอะไร', async () => {
    const { db, omise, service } = build();
    seedBooking(db, 'confirmed');
    seedPayment(db, 'held', { omiseChargeId: null });
    const before = db.dump();

    const err = await blocked(
      service.settle(
        BOOKING_ID,
        SettlementReason.PATIENT_CANCEL,
        PATIENT_ACTOR,
      ),
    );

    expect(err.code).toBe('payment_not_settleable');
    expect(omise.voidCharge).not.toHaveBeenCalled();
    expect(db.dump()).toEqual(before);
  });

  it('pending ที่ไม่ใช่ PromptPay (ตรวจกับ Omise ไม่ได้) → 422 payment_not_settleable ไม่ถาม Omise', async () => {
    const { db, omise, service } = build();
    seedBooking(db, 'accepted');
    seedPayment(db, 'pending', { paymentMethod: 'credit_card' });
    const before = db.dump();

    const err = await blocked(
      service.settle(BOOKING_ID, SettlementReason.EXPIRED_NO_PAYMENT, SYSTEM),
    );

    expect(err.code).toBe('payment_not_settleable');
    expect(omise.retrieveCharge).not.toHaveBeenCalled();
    expect(db.dump()).toEqual(before);
  });

  it('นโยบาย 0% กับ captured → ปิด booking แต่ไม่คืนเงิน (payment คง captured, ไม่เรียก Omise)', async () => {
    jest.replaceProperty(
      CANCELLATION_POLICY,
      'CAREGIVER_NO_SHOW_REFUND_PERCENTAGE',
      0,
    );
    const { db, omise, events, service } = build();
    seedBooking(db, 'confirmed');
    seedPayment(db, 'captured');

    const res = await service.settle(
      BOOKING_ID,
      SettlementReason.CAREGIVER_NO_SHOW,
      SYSTEM,
    );

    expect(res).toMatchObject({
      moneyAction: 'none',
      refundPercentage: 0,
      paymentStatusAfter: 'captured',
    });
    expect(omise.createRefund).not.toHaveBeenCalled();
    expect(db.payments.get(PAYMENT_ID)!.paymentStatus).toBe('captured');
    expect(db.bookings.get(BOOKING_ID)!.status).toBe('expired');
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('ค่า % ในคอนฟิกผิด (150) → 422 policy_not_supported ก่อนเงินขยับ', async () => {
    jest.replaceProperty(
      CANCELLATION_POLICY,
      'SYSTEM_CLOSED_REFUND_PERCENTAGE',
      150,
    );
    const { db, omise, service } = build();
    seedBooking(db, 'accepted');
    seedPayment(db, 'captured');
    const before = db.dump();

    const err = await blocked(
      service.settle(BOOKING_ID, SettlementReason.EXPIRED_NO_PAYMENT, SYSTEM),
    );

    expect(err.code).toBe('policy_not_supported');
    expect(omise.createRefund).not.toHaveBeenCalled();
    expect(db.dump()).toEqual(before);
  });
});

// ── DB เปลี่ยนระหว่าง ① pre-read (ไม่ล็อก) กับ ③ critical section (ล็อก) ────────

describe('สถานะใต้ lock ชนะผลของ pre-read เสมอ', () => {
  it('booking ถูกลบระหว่างทาง → NotFound ไม่แตะเงิน', async () => {
    const { db, omise, service } = build();
    seedBooking(db, 'confirmed');
    seedPayment(db, 'held');
    db.afterPreRead = () => db.bookings.delete(BOOKING_ID);

    await expect(
      service.settle(
        BOOKING_ID,
        SettlementReason.PATIENT_CANCEL,
        PATIENT_ACTOR,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(omise.voidCharge).not.toHaveBeenCalled();
    expect(db.payments.get(PAYMENT_ID)!.paymentStatus).toBe('held');
  });

  it('pre-read ไม่มีเงินค้าง แต่ก่อนได้ lock ผู้ป่วยสร้าง QR ใหม่ (pending) → state_changed_retry ไม่ปิด booking', async () => {
    const { db, omise, service } = build();
    seedBooking(db, 'accepted');
    seedPayment(db, 'failed');
    db.afterPreRead = () => {
      db.payments.get(PAYMENT_ID)!.paymentStatus = 'pending';
    };

    const err = await blocked(
      service.settle(BOOKING_ID, SettlementReason.EXPIRED_NO_PAYMENT, SYSTEM),
    );

    expect(err.code).toBe('state_changed_retry');
    expect(err.details).toMatchObject({ planKind: null });
    expect(omise.retrieveCharge).not.toHaveBeenCalled();
    expect(db.bookings.get(BOOKING_ID)!.status).toBe('accepted');
    expect(db.bookingStatusHistory).toHaveLength(0);
  });

  it('อีกตัว settle เสร็จไปก่อนเราได้ lock → alreadySettled ใต้ lock ไม่ void ซ้ำ ไม่เขียน history ซ้ำ', async () => {
    const { db, omise, service } = build();
    seedBooking(db, 'confirmed');
    seedPayment(db, 'held');
    db.afterPreRead = () => {
      db.bookings.get(BOOKING_ID)!.status = 'cancelled';
      db.payments.get(PAYMENT_ID)!.paymentStatus = 'voided';
    };

    const res = await service.settle(
      BOOKING_ID,
      SettlementReason.PATIENT_CANCEL,
      PATIENT_ACTOR,
    );

    expect(res).toMatchObject({
      alreadySettled: true,
      moneyAction: 'none',
      paymentStatusAfter: 'voided',
    });
    expect(omise.voidCharge).not.toHaveBeenCalled();
    expect(db.bookingStatusHistory).toHaveLength(0);
  });
});

describe('PromptPay pending — ผลจาก Omise ที่เหลือ', () => {
  it('Omise บอก failed → pending→failed (FSM) ไม่มีเงินขยับ', async () => {
    const { db, omise, service } = build();
    seedBooking(db, 'accepted');
    seedPayment(db, 'pending');
    omise.retrieveCharge.mockResolvedValue({
      id: CHARGE,
      status: 'failed',
      paid: false,
      expiresAt: null,
    });

    const res = await service.settle(
      BOOKING_ID,
      SettlementReason.EXPIRED_NO_PAYMENT,
      SYSTEM,
    );

    expect(res).toMatchObject({
      moneyAction: 'promptpay_expired',
      paymentStatusAfter: 'failed',
    });
    expect(db.paymentStatusHistory).toEqual([
      expect.objectContaining({ fromStatus: 'pending', toStatus: 'failed' }),
    ]);
  });

  it('ยัง pending และ Omise ไม่ส่ง expires_at → 422 still_scannable (ไม่เดา TTL เอง) ไม่มีอะไรเปลี่ยน', async () => {
    const { db, omise, service } = build();
    seedBooking(db, 'accepted');
    seedPayment(db, 'pending');
    omise.retrieveCharge.mockResolvedValue({
      id: CHARGE,
      status: 'pending',
      paid: false,
      expiresAt: null,
    });
    const before = db.dump();

    const err = await blocked(
      service.settle(BOOKING_ID, SettlementReason.EXPIRED_NO_PAYMENT, SYSTEM),
    );

    expect(err.code).toBe('promptpay_still_scannable');
    expect(err.details).toMatchObject({ expiresAt: null });
    expect(db.dump()).toEqual(before);
  });
});
