/**
 * PYG-727 / PYG-726 — event listener ต้องรันจนจบบน Cloudflare Workers
 *
 * บน production (Workers) notification ของการจองไม่เคยขึ้น เพราะ `eventEmitter.emit` ไม่รอ
 * listener async แล้ว Workers ตัดงานที่ค้างทิ้งหลังส่ง response
 * keepEventListenersAlive ส่ง promise ของ listener ให้ waitUntil — test ชุดนี้ใช้ waitUntil ปลอม
 * แล้วเช็คว่า promise ที่ได้ "ยังไม่จบ" จนกว่า listener จะทำงานเสร็จจริง
 */
import { Injectable, Logger, Scope } from '@nestjs/common';
import {
  EventEmitter2,
  EventEmitterModule,
  OnEvent,
} from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import {
  keepEventListenersAlive,
  registerBackgroundWaitUntil,
  runInBackground,
} from './background-task';

/** promise ที่ test เป็นคนสั่งให้จบ — ใช้จำลอง listener ที่ยังทำงานไม่เสร็จ (รอ DB) */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** ปล่อยให้ microtask ที่ค้างอยู่ทำงานให้หมดก่อนเช็คผล */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** waitUntil ปลอม — เก็บ promise ที่ถูกส่งมาไว้ให้ test เช็ค */
function fakeWaitUntil() {
  return jest.fn<void, [Promise<unknown>]>();
}

/** ติดตามว่า promise จบแล้วหรือยัง โดยไม่ต้อง await */
function track(task: Promise<unknown>): { settled: () => boolean } {
  let settled = false;
  void task.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return { settled: () => settled };
}

describe('background-task', () => {
  afterEach(() => {
    registerBackgroundWaitUntil(undefined);
    jest.restoreAllMocks();
  });

  describe('runInBackground', () => {
    it('hands the task to the registered waitUntil (Workers)', () => {
      const waitUntil = fakeWaitUntil();
      registerBackgroundWaitUntil(waitUntil);
      const task = Promise.resolve('done');

      runInBackground(task);

      expect(waitUntil).toHaveBeenCalledWith(task);
    });
  });

  describe('keepEventListenersAlive', () => {
    it('leaves emit untouched on Node (no waitUntil registered)', () => {
      const emitter = new EventEmitter2();

      keepEventListenersAlive(emitter);

      // ไม่มี emit ของตัวเอง = ยังใช้ emit เดิมจาก prototype
      expect(Object.prototype.hasOwnProperty.call(emitter, 'emit')).toBe(false);
    });

    it('still calls listeners right away, in order, with the same payload', () => {
      registerBackgroundWaitUntil(jest.fn());
      const emitter = new EventEmitter2();
      const calls: string[] = [];
      emitter.on('booking.created', (p: { id: string }) =>
        calls.push(`first:${p.id}`),
      );
      emitter.on('booking.created', (p: { id: string }) =>
        calls.push(`second:${p.id}`),
      );
      keepEventListenersAlive(emitter);

      emitter.emit('booking.created', { id: 'b1' });

      // ไม่ต้อง await — listener ถูกเรียกทันทีเหมือน emit เดิม
      expect(calls).toEqual(['first:b1', 'second:b1']);
    });

    it('returns whether the event has listeners, like emit', () => {
      registerBackgroundWaitUntil(jest.fn());
      const emitter = new EventEmitter2();
      emitter.on('booking.accepted', () => undefined);
      keepEventListenersAlive(emitter);

      expect(emitter.emit('booking.accepted', {})).toBe(true);
      expect(emitter.emit('payment.expired', {})).toBe(false);
    });

    it('gives waitUntil a promise that only settles after an async listener finishes', async () => {
      const waitUntil = fakeWaitUntil();
      registerBackgroundWaitUntil(waitUntil);
      const emitter = new EventEmitter2();
      const gate = deferred();
      const handled: string[] = [];
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- ตั้งใจคืน promise: listener async แบบที่ใช้จริง
      emitter.on('booking.accepted', async (p: { id: string }) => {
        await gate.promise; // จำลองการรอ DB insert notification
        handled.push(p.id);
      });
      keepEventListenersAlive(emitter);

      emitter.emit('booking.accepted', { id: 'b2' });

      expect(waitUntil).toHaveBeenCalledTimes(1);
      const task = waitUntil.mock.calls[0][0];
      const status = track(task);
      await flushMicrotasks();
      expect(status.settled()).toBe(false);
      expect(handled).toEqual([]);

      gate.resolve();
      await task;
      expect(handled).toEqual(['b2']);
    });

    it('hands one task per emit to waitUntil', () => {
      const waitUntil = fakeWaitUntil();
      registerBackgroundWaitUntil(waitUntil);
      const emitter = new EventEmitter2();
      emitter.on('payment.held', () => undefined);
      emitter.on('booking.confirmed', () => undefined);
      keepEventListenersAlive(emitter);

      emitter.emit('payment.held', {});
      emitter.emit('booking.confirmed', {});

      expect(waitUntil).toHaveBeenCalledTimes(2);
    });

    it('does not reject the waitUntil task when a listener fails, and logs it', async () => {
      const waitUntil = fakeWaitUntil();
      registerBackgroundWaitUntil(waitUntil);
      const logError = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const emitter = new EventEmitter2();
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- ตั้งใจคืน promise ที่ reject
      emitter.on('booking.created', async () => {
        await Promise.resolve();
        throw new Error('db down');
      });
      keepEventListenersAlive(emitter);

      emitter.emit('booking.created', { id: 'b3' });

      const task = waitUntil.mock.calls[0][0];
      await expect(task).resolves.toBeUndefined();
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('booking.created'),
      );
    });
  });

  /**
   * ทางเดินจริงบน production: @OnEvent listener ที่พึ่ง provider แบบ REQUEST scope
   * (BookingNotificationListener / PayoutCreationListener พึ่ง PrismaService)
   * @nestjs/event-emitter สร้าง instance ใหม่ต่อ event แบบ async แล้วค่อยเรียก handler
   */
  describe('with Nest request-scoped @OnEvent listeners', () => {
    const gate = { current: deferred() };
    const handled: string[] = [];

    @Injectable({ scope: Scope.REQUEST })
    class PerRequestDb {
      async insertNotification(id: string): Promise<void> {
        await gate.current.promise;
        handled.push(id);
      }
    }

    @Injectable()
    class FakeNotificationListener {
      constructor(private readonly db: PerRequestDb) {}

      @OnEvent('booking.created')
      async handle(event: { bookingId: string }): Promise<void> {
        await this.db.insertNotification(event.bookingId);
      }
    }

    async function bootEmitter(): Promise<EventEmitter2> {
      const moduleRef = await Test.createTestingModule({
        imports: [EventEmitterModule.forRoot()],
        providers: [PerRequestDb, FakeNotificationListener],
      }).compile();
      await moduleRef.init(); // ลงทะเบียน @OnEvent ตอน bootstrap เหมือน app.init()
      return moduleRef.get(EventEmitter2);
    }

    beforeEach(() => {
      gate.current = deferred();
      handled.length = 0;
    });

    it('before the fix: plain emit gives waitUntil nothing, so Workers would cut the listener off', async () => {
      const waitUntil = fakeWaitUntil();
      registerBackgroundWaitUntil(waitUntil);
      const emitter = await bootEmitter();

      emitter.emit('booking.created', { bookingId: 'b4' });
      await flushMicrotasks();

      expect(waitUntil).not.toHaveBeenCalled();
      expect(handled).toEqual([]); // ยังรอ DB อยู่ — ถ้า response ออกไปตอนนี้ งานนี้หายบน Workers
      gate.current.resolve();
    });

    it('after the fix: waitUntil waits until the request-scoped listener has finished', async () => {
      const waitUntil = fakeWaitUntil();
      registerBackgroundWaitUntil(waitUntil);
      const emitter = await bootEmitter();
      keepEventListenersAlive(emitter);

      emitter.emit('booking.created', { bookingId: 'b5' });

      expect(waitUntil).toHaveBeenCalledTimes(1);
      const task = waitUntil.mock.calls[0][0];
      const status = track(task);
      await flushMicrotasks();
      expect(status.settled()).toBe(false);
      expect(handled).toEqual([]);

      gate.current.resolve();
      await task;
      expect(handled).toEqual(['b5']);
    });
  });
});
