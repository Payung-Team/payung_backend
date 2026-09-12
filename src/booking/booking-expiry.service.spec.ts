/**
 * BookingExpiryService tests (PYG-461/462 เฟส 1)
 *
 * ครอบคลุม:
 *  - kill-switch: ไม่ตั้ง env = ไม่ทำงาน (default ปิด)
 *  - เลือกเฉพาะ booking ที่ไม่มีเงินค้าง — pending/held/captured/... ไม่ถูกแตะ (ทั้งที่ query และที่ UPDATE)
 *  - deadline นับตามเวลาไทย + buffer
 *  - conditional UPDATE ได้ 0 แถว → ไม่เขียน history ไม่แจ้งเตือน
 *  - ชนกับ acceptBooking → ไม่เกิด double transition (2 ลำดับเหตุการณ์)
 *
 * ⚠ ข้อจำกัดที่ต้องรู้: เทสทั้งหมดเป็น unit test กับ fake — ไม่มี Postgres จริง (repo ไม่มี CI/DB เทส)
 *   เทส race ยืนยันว่า "ทั้งสองฝั่งเขียนแบบมีเงื่อนไข" แต่ไม่ได้พิสูจน์พฤติกรรม row lock ของ Postgres เอง
 */
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  BookingExpiryService,
  EXPIRY_BATCH_CAP,
  NO_MONEY_PAYMENT_STATUSES,
} from './booking-expiry.service';
import { CaregiverBookingService } from './caregiver-booking.service';
import { BOOKING_EXPIRY_BUFFER_MINUTES } from './booking-deadline.config';
import { NotificationType } from '../notification/entities/notification-type.enum';
import { PaymentStatus } from '../payment/entities/payment-status.enum';

// booking 2026-07-01 09:00 เวลาไทย = 2026-07-01T02:00:00Z
const START_MS = Date.parse('2026-07-01T02:00:00.000Z');
const MIN = 60 * 1000;
const PAST_THRESHOLD = START_MS + BOOKING_EXPIRY_BUFFER_MINUTES * MIN + MIN;

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'b-1',
    status: 'pending',
    patientId: 'patient-1',
    bookingDate: new Date('2026-07-01'),
    startTime: new Date('1970-01-01T09:00:00.000Z'),
    caregiver: { userId: 'cg-user-1' },
    payment: null,
    ...overrides,
  };
}

/** แกะ tagged-template call ของ $queryRaw → ข้อความ SQL + ค่าที่ bind */
function sqlOf(call: unknown[]): { text: string; values: unknown[] } {
  const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
  return { text: strings.join('?'), values };
}

function makeService(opts: { enabled?: string; now: number }) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'b-1' }]),
    bookingStatusHistory: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    booking: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  const notifications = { create: jest.fn().mockResolvedValue({}) };
  const config = {
    get: jest.fn((k: string) =>
      k === 'BOOKING_EXPIRY_CRON_ENABLED' ? opts.enabled : undefined,
    ),
  };
  const clock = { now: () => new Date(opts.now) };
  const service = new BookingExpiryService(
    prisma as never,
    clock as never,
    notifications as never,
    config as never,
  );
  return { service, prisma, tx, notifications };
}

describe('BookingExpiryService (PYG-461/462 เฟส 1)', () => {
  // ── kill-switch ────────────────────────────────────────────────────────
  describe('kill-switch (default = ปิด)', () => {
    it.each([undefined, '', 'false', '0', 'no'])(
      'BOOKING_EXPIRY_CRON_ENABLED=%p → ไม่ query ไม่เปิด tx',
      async (enabled) => {
        const { service, prisma } = makeService({
          enabled,
          now: PAST_THRESHOLD,
        });
        await service.run();
        expect(prisma.booking.findMany).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );

    it.each(['true', '1', 'yes', 'TRUE', ' true '])(
      'BOOKING_EXPIRY_CRON_ENABLED=%p → ทำงาน',
      async (enabled) => {
        const { service, prisma } = makeService({
          enabled,
          now: PAST_THRESHOLD,
        });
        await service.run();
        expect(prisma.booking.findMany).toHaveBeenCalledTimes(1);
      },
    );
  });

  // ── ขอบเขต: ไม่แตะเงินค้าง ─────────────────────────────────────────────
  describe('ไม่แตะ booking ที่มีเงินค้าง', () => {
    it('รายการสถานะ "ไม่มีเงินค้าง" = failed/expired/voided เท่านั้น', () => {
      expect([...NO_MONEY_PAYMENT_STATUSES].sort()).toEqual(
        [
          PaymentStatus.expired,
          PaymentStatus.failed,
          PaymentStatus.voided,
        ].sort(),
      );
      for (const withMoney of [
        PaymentStatus.pending,
        PaymentStatus.held,
        PaymentStatus.captured,
        PaymentStatus.transferred,
        PaymentStatus.refunded,
        PaymentStatus.partially_refunded,
      ]) {
        expect(NO_MONEY_PAYMENT_STATUSES).not.toContain(withMoney);
      }
    });

    it('query เลือกเฉพาะ pending/accepted ที่ไม่มี payment หรือ payment ไม่มีเงินค้าง', async () => {
      // 2026-06-30T20:00Z = 2026-07-01 03:00 เวลาไทย → กรองวันที่ <= 2026-07-01
      const { service, prisma } = makeService({
        enabled: 'true',
        now: Date.parse('2026-06-30T20:00:00.000Z'),
      });
      await service.run();

      const args = prisma.booking.findMany.mock.calls[0][0];
      expect(args.where.status).toEqual({ in: ['pending', 'accepted'] });
      expect(args.where.bookingDate).toEqual({
        lte: new Date('2026-07-01T00:00:00.000Z'),
      });
      expect(args.where.OR).toEqual([
        { payment: { is: null } },
        {
          payment: {
            is: { paymentStatus: { in: [...NO_MONEY_PAYMENT_STATUSES] } },
          },
        },
      ]);
      expect(args.take).toBe(EXPIRY_BATCH_CAP);
    });

    it('UPDATE มีเงื่อนไขซ้ำที่ DB: status เดิม + NOT EXISTS payment ที่มีเงินค้าง (กันเงินเข้ามาหลัง query)', async () => {
      const { service, prisma, tx } = makeService({
        enabled: 'true',
        now: PAST_THRESHOLD,
      });
      prisma.booking.findMany.mockResolvedValue([candidate()]);

      await service.run();

      const { text, values } = sqlOf(tx.$queryRaw.mock.calls[0]);
      expect(text).toContain('UPDATE "bookings"');
      expect(text).toContain('AND b."status" = ?');
      expect(text).toContain('NOT EXISTS');
      expect(text).toContain('"payment_status"::text NOT IN (?)');
      expect(values).toContain('expired');
      expect(values).toContain('pending'); // สถานะเดิมต้องตรง
      // Prisma.join() คืน Sql fragment (มี .values) — Prisma.Sql ไม่ได้ export เป็น class ตอน runtime จึงเช็คจากรูปทรง
      const joined = values.find(
        (v): v is Prisma.Sql =>
          typeof v === 'object' &&
          v !== null &&
          Array.isArray((v as { values?: unknown }).values),
      );
      expect(joined?.values).toEqual([...NO_MONEY_PAYMENT_STATUSES]);
    });

    it('UPDATE ได้ 0 แถว (เงินเข้ามา/สถานะเปลี่ยนหลัง query) → ไม่เขียน history ไม่แจ้งเตือน', async () => {
      const { service, prisma, tx, notifications } = makeService({
        enabled: 'true',
        now: PAST_THRESHOLD,
      });
      prisma.booking.findMany.mockResolvedValue([candidate()]);
      tx.$queryRaw.mockResolvedValue([]);

      await service.run();

      expect(tx.bookingStatusHistory.create).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });
  });

  // ── การหมดอายุ ─────────────────────────────────────────────────────────
  describe('หมดอายุ', () => {
    it('pending เลย deadline+buffer → expired + history (expired_no_accept, ระบบ) + แจ้งทั้งสองฝ่าย', async () => {
      const { service, prisma, tx, notifications } = makeService({
        enabled: 'true',
        now: PAST_THRESHOLD,
      });
      prisma.booking.findMany.mockResolvedValue([candidate()]);

      await service.run();

      expect(tx.bookingStatusHistory.create).toHaveBeenCalledTimes(1);
      const { data } = tx.bookingStatusHistory.create.mock.calls[0][0];
      expect(data).toMatchObject({
        bookingId: 'b-1',
        fromStatus: 'pending',
        toStatus: 'expired',
        changedBy: null,
        reason: 'expired_no_accept',
      });
      expect(data.metadata).toMatchObject({
        source: 'booking_expiry_cron',
        deadline: new Date(START_MS).toISOString(),
        paymentStatus: null,
      });

      const recipients = notifications.create.mock.calls.map((c) => c[0]);
      expect(recipients).toEqual(['patient-1', 'cg-user-1']);
      for (const c of notifications.create.mock.calls) {
        expect(c[1]).toBe(NotificationType.booking_cancelled);
        expect(c[4]).toEqual({ bookingId: 'b-1', source: 'booking.expired' });
      }
    });

    it('accepted + payment failed เลย deadline → expired_no_payment (บันทึกสถานะ payment ไว้ใน metadata)', async () => {
      const { service, prisma, tx } = makeService({
        enabled: 'true',
        now: PAST_THRESHOLD,
      });
      prisma.booking.findMany.mockResolvedValue([
        candidate({ status: 'accepted', payment: { paymentStatus: 'failed' } }),
      ]);

      await service.run();

      const { data } = tx.bookingStatusHistory.create.mock.calls[0][0];
      expect(data.reason).toBe('expired_no_payment');
      expect(data.fromStatus).toBe('accepted');
      expect(data.metadata.paymentStatus).toBe('failed');
    });

    it('ยังไม่พ้น deadline+buffer (ขอบพอดี) → ไม่แตะ', async () => {
      const { service, prisma } = makeService({
        enabled: 'true',
        now: START_MS + BOOKING_EXPIRY_BUFFER_MINUTES * MIN,
      });
      prisma.booking.findMany.mockResolvedValue([candidate()]);

      await service.run();

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('deadline ตีความ start_time เป็นเวลาไทย ไม่ใช่ UTC (09:20 ไทย = เลย 09:00 มา 20 นาที > buffer)', async () => {
      // ถ้าโค้ดตีความ 09:00 เป็น UTC จะคิดว่ายังไม่ถึงเวลาเริ่มงาน แล้วไม่ปิด
      const { service, prisma, tx } = makeService({
        enabled: 'true',
        now: Date.parse('2026-07-01T02:20:00.000Z'),
      });
      prisma.booking.findMany.mockResolvedValue([candidate()]);

      await service.run();

      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('booking ใบหนึ่งพัง → ใบถัดไปยังทำต่อ + ประมวลผลทีละใบ (ไม่เปิด tx ขนาน)', async () => {
      const { service, prisma, tx } = makeService({
        enabled: 'true',
        now: PAST_THRESHOLD,
      });
      prisma.booking.findMany.mockResolvedValue([
        candidate({ id: 'b-bad' }),
        candidate({ id: 'b-ok' }),
      ]);

      let inFlight = 0;
      let maxInFlight = 0;
      prisma.$transaction.mockImplementation(
        async (cb: (t: typeof tx) => unknown) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          try {
            return await cb(tx);
          } finally {
            inFlight -= 1;
          }
        },
      );
      tx.$queryRaw
        .mockRejectedValueOnce(new Error('db blip'))
        .mockResolvedValueOnce([{ id: 'b-ok' }]);

      await service.run();

      expect(tx.bookingStatusHistory.create).toHaveBeenCalledTimes(1);
      expect(
        tx.bookingStatusHistory.create.mock.calls[0][0].data.bookingId,
      ).toBe('b-ok');
      expect(maxInFlight).toBe(1);
    });

    it('ไม่มีผู้ดูแล (caregiver null) → แจ้งแค่ผู้ป่วย', async () => {
      const { service, prisma, notifications } = makeService({
        enabled: 'true',
        now: PAST_THRESHOLD,
      });
      prisma.booking.findMany.mockResolvedValue([
        candidate({ caregiver: null }),
      ]);

      await service.run();

      expect(notifications.create).toHaveBeenCalledTimes(1);
      expect(notifications.create.mock.calls[0][0]).toBe('patient-1');
    });
  });

  // ── race กับ acceptBooking ─────────────────────────────────────────────
  describe('ชนกับ acceptBooking → ไม่เกิด double transition', () => {
    /**
     * แถว booking ร่วมกันหนึ่งแถว + fake ที่ทำตัวเหมือน conditional UPDATE ของ Postgres:
     * เขียนได้ก็ต่อเมื่อ status ปัจจุบันตรงกับเงื่อนไข WHERE เท่านั้น
     */
    function setupRace(gate?: Promise<void>) {
      const row = { id: 'b-1', status: 'pending' };
      const history: unknown[] = [];

      const fullBooking = () => ({
        id: row.id,
        status: row.status,
        patientId: 'patient-1',
        serviceType: 'general_care',
        serviceLocations: ['home'],
        tasks: [],
        timeSlot: 'morning',
        bookingDate: new Date('2026-07-01'),
        startTime: new Date('1970-01-01T09:00:00.000Z'),
        durationHours: 3,
        locationAddress: '123 Main St',
        locationLat: null,
        locationLng: null,
        notes: null,
        dayOfContactName: null,
        dayOfContactPhone: null,
        dayOfContactRelationship: null,
        estimatedCost: null,
        acceptedAt: new Date(),
        confirmedAt: null,
        rejectionReason: null,
        createdAt: new Date('2026-06-01T08:00:00Z'),
        patient: { id: 'patient-1', displayName: null, avatarUrl: null },
        careRecipient: null,
        memberDetails: null,
      });

      const acceptPrisma = {
        caregiver: { findUnique: jest.fn().mockResolvedValue({ id: 'cg-1' }) },
        booking: {
          findUnique: jest.fn((args: { select?: Record<string, boolean> }) => {
            if (args.select?.caregiverId) {
              return Promise.resolve({
                id: row.id,
                caregiverId: 'cg-1',
                status: row.status,
              });
            }
            if (args.select?.bookingDate) {
              return Promise.resolve({
                bookingDate: new Date('2026-07-01'),
                startTime: new Date('1970-01-01T09:00:00.000Z'),
                durationHours: 3,
              });
            }
            return Promise.resolve(fullBooking());
          }),
          // จุดที่ accept ค้าง (หลังผ่าน guard แล้ว ก่อนเขียน) — ใช้แทรก cron เข้ามาตรงกลาง
          findMany: jest.fn(async () => {
            if (gate) await gate;
            return [];
          }),
          updateMany: jest.fn(
            (args: { where: { status: string }; data: { status: string } }) => {
              if (row.status !== args.where.status)
                return Promise.resolve({ count: 0 });
              row.status = args.data.status;
              return Promise.resolve({ count: 1 });
            },
          ),
        },
      };
      // ผู้ดูแลกดรับ "ก่อน" deadline (1 ชม. ก่อนเริ่มงาน) แล้ว request ค้าง
      const acceptClock = { now: () => new Date(START_MS - 60 * MIN) };
      const accept = new CaregiverBookingService(
        acceptPrisma as never,
        { emit: jest.fn() } as never,
        acceptClock as never,
      );

      const tx = {
        $queryRaw: jest.fn((...call: unknown[]) => {
          const { values } = sqlOf(call);
          const fromStatus = values[3];
          if (row.status !== fromStatus) return Promise.resolve([]);
          row.status = 'expired';
          return Promise.resolve([{ id: row.id }]);
        }),
        bookingStatusHistory: {
          create: jest.fn((args: unknown) => {
            history.push(args);
            return Promise.resolve({});
          }),
        },
      };
      const cronPrisma = {
        // cron อ่านรายการตอนที่ booking ยังเป็น pending (snapshot)
        booking: {
          findMany: jest
            .fn()
            .mockResolvedValue([candidate({ status: 'pending' })]),
        },
        $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
      };
      const cron = new BookingExpiryService(
        cronPrisma as never,
        { now: () => new Date(PAST_THRESHOLD) } as never,
        { create: jest.fn().mockResolvedValue({}) } as never,
        { get: () => 'true' } as never,
      );

      return { row, history, accept, cron };
    }

    const flush = () => new Promise((r) => setImmediate(r));

    it('accept เขียนก่อน → cron (ถือ snapshot เก่า) ได้ 0 แถว ไม่เขียน history', async () => {
      const { row, history, accept, cron } = setupRace();

      await accept.acceptBooking('cg-user-1', 'b-1');
      await cron.run();

      expect(row.status).toBe('accepted');
      expect(history).toHaveLength(0);
    });

    it('accept ผ่าน guard แล้วค้าง → cron ปิดก่อน → accept ได้ 0 แถว → ConflictException (ไม่เขียนทับ expired)', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const { row, history, accept, cron } = setupRace(gate);

      const acceptPromise = accept.acceptBooking('cg-user-1', 'b-1');
      await flush(); // accept อ่าน status=pending + ผ่าน guard เวลาแล้ว กำลังค้าง
      await cron.run();
      release();

      await expect(acceptPromise).rejects.toBeInstanceOf(ConflictException);
      expect(row.status).toBe('expired');
      expect(history).toHaveLength(1);
    });
  });
});
