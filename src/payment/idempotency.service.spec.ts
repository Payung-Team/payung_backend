/**
 * IdempotencyService unit tests (PYG-375)
 *
 * DoD:
 * - two concurrent commands with the SAME key → the wrapped Omise fn runs exactly ONCE
 * - repeating a completed command → the stored result is returned, fn NOT called again
 * - in-flight (reserved, no result yet) → ConflictException
 * - pruneOlderThan deletes aged keys
 *
 * The prisma mock simulates the PK on `key`: a 2nd INSERT of the same key throws
 * a real Prisma P2002 (what the DB does), which is the once-only guarantee.
 */
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IdempotencyService } from './idempotency.service';

function makePrismaMock() {
  const store = new Map<string, { result: unknown }>();
  const p2002 = () =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });
  return {
    store,
    idempotencyKey: {
      create: jest.fn(async ({ data }: { data: { key: string } }) => {
        if (store.has(data.key)) throw p2002(); // PK collision — same as the DB
        store.set(data.key, { result: null });
        return {};
      }),
      findUnique: jest.fn(async ({ where }: { where: { key: string } }) => {
        const row = store.get(where.key);
        return row ? { key: where.key, result: row.result } : null;
      }),
      update: jest.fn(
        async ({ where, data }: { where: { key: string }; data: { result: unknown } }) => {
          store.get(where.key)!.result = data.result;
          return {};
        },
      ),
      deleteMany: jest.fn(async () => ({ count: 3 })),
    },
  };
}

describe('IdempotencyService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: IdempotencyService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new IdempotencyService(prisma as never);
  });

  it('first run: reserves key, calls fn once, stores result', async () => {
    const fn = jest.fn().mockResolvedValue({ id: 'chrg_1' });

    const out = await service.runOnce({ key: 'capture:bk1', action: 'capture', fn });

    expect(out).toEqual({ id: 'chrg_1' });
    expect(fn).toHaveBeenCalledTimes(1);
    // fn receives the SAME deterministic key to pass as the Omise header
    expect(fn).toHaveBeenCalledWith('capture:bk1');
    expect(prisma.store.get('capture:bk1')?.result).toEqual({ id: 'chrg_1' });
  });

  it('replay of a completed command → returns stored result, fn NOT called', async () => {
    prisma.store.set('refund:pay1:0', { result: { id: 'rfnd_1' } });
    const fn = jest.fn().mockResolvedValue({ id: 'SHOULD_NOT_RUN' });

    const out = await service.runOnce({ key: 'refund:pay1:0', action: 'refund', fn });

    expect(out).toEqual({ id: 'rfnd_1' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('🔴 two concurrent commands, same key → Omise fn runs exactly ONCE', async () => {
    const omiseFn = jest.fn(
      () => new Promise((r) => setTimeout(() => r({ id: 'chrg_once' }), 10)),
    );

    const results = await Promise.allSettled([
      service.runOnce({ key: 'capture:bkX', action: 'capture', fn: omiseFn }),
      service.runOnce({ key: 'capture:bkX', action: 'capture', fn: omiseFn }),
    ]);

    // the money call happened once, no matter that two requests raced
    expect(omiseFn).toHaveBeenCalledTimes(1);
    // one request wins; the other is told the command is already in progress
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ConflictException,
    );
  });

  it('reserved but no result yet (in-flight/crashed) → ConflictException', async () => {
    prisma.store.set('capture:bkY', { result: null }); // reserved, not finished
    const fn = jest.fn();

    await expect(
      service.runOnce({ key: 'capture:bkY', action: 'capture', fn }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(fn).not.toHaveBeenCalled();
  });

  it('pruneOlderThan deletes aged keys', async () => {
    const n = await service.pruneOlderThan(30);
    expect(n).toBe(3);
    expect(prisma.idempotencyKey.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: expect.any(Date) } },
    });
  });
});
