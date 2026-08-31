/**
 * PayoutRetryPolicy tests (PYG-331 ก้อน B)
 * env: PAYOUT_MAX_RETRIES=5 · PAYOUT_BACKOFF_MINUTES=10,30,60,180,360
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PayoutRetryPolicy } from './payout-retry-policy';

function makeConfig(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    PAYOUT_MAX_RETRIES: '5',
    PAYOUT_BACKOFF_MINUTES: '10,30,60,180,360',
    ...overrides,
  };
  return {
    getOrThrow: jest.fn((key: string) => {
      const v = values[key];
      if (v === undefined) throw new Error(`missing ${key}`);
      return v;
    }),
  };
}

async function makePolicy(cfg: ReturnType<typeof makeConfig>) {
  const mod: TestingModule = await Test.createTestingModule({
    providers: [
      PayoutRetryPolicy,
      { provide: ConfigService, useValue: cfg },
    ],
  }).compile();
  return mod.get(PayoutRetryPolicy);
}

describe('PayoutRetryPolicy', () => {
  const now = new Date('2026-08-01T10:00:00Z');

  it('retryCountBefore=0 → retry, newRetryCount=1, backoff=10m', async () => {
    const p = await makePolicy(makeConfig());
    const d = p.decide(0, now);
    expect(d.kind).toBe('retry');
    if (d.kind !== 'retry') return;
    expect(d.newRetryCount).toBe(1);
    expect(d.backoffMinutes).toBe(10);
    expect(d.nextRetryAt.toISOString()).toBe('2026-08-01T10:10:00.000Z');
  });

  it('retryCountBefore=1 → retry, newRetryCount=2, backoff=30m', async () => {
    const p = await makePolicy(makeConfig());
    const d = p.decide(1, now);
    if (d.kind !== 'retry') fail('expected retry');
    expect(d.newRetryCount).toBe(2);
    expect(d.backoffMinutes).toBe(30);
    expect(d.nextRetryAt.toISOString()).toBe('2026-08-01T10:30:00.000Z');
  });

  it('retryCountBefore=3 → retry, newRetryCount=4, backoff=180m', async () => {
    const p = await makePolicy(makeConfig());
    const d = p.decide(3, now);
    if (d.kind !== 'retry') fail('expected retry');
    expect(d.newRetryCount).toBe(4);
    expect(d.backoffMinutes).toBe(180);
    expect(d.nextRetryAt.toISOString()).toBe('2026-08-01T13:00:00.000Z');
  });

  it('retryCountBefore=4 (attempt #5) with MAX=5 → terminate', async () => {
    const p = await makePolicy(makeConfig());
    const d = p.decide(4, now);
    expect(d.kind).toBe('terminate');
    if (d.kind !== 'terminate') return;
    expect(d.newRetryCount).toBe(5);
  });

  it('retryCountBefore=99 → terminate (over-max still terminates cleanly)', async () => {
    const p = await makePolicy(makeConfig());
    const d = p.decide(99, now);
    expect(d.kind).toBe('terminate');
  });

  // ── env validation ────────────────────────────────────────────────────────

  it('malformed PAYOUT_MAX_RETRIES → throws', async () => {
    const p = await makePolicy(makeConfig({ PAYOUT_MAX_RETRIES: 'abc' }));
    expect(() => p.decide(0)).toThrow(/PAYOUT_MAX_RETRIES/);
  });

  it('PAYOUT_MAX_RETRIES=0 → throws', async () => {
    const p = await makePolicy(makeConfig({ PAYOUT_MAX_RETRIES: '0' }));
    expect(() => p.decide(0)).toThrow(/PAYOUT_MAX_RETRIES/);
  });

  it('backoff list shorter than needed → throws with helpful message', async () => {
    const p = await makePolicy(
      makeConfig({ PAYOUT_MAX_RETRIES: '5', PAYOUT_BACKOFF_MINUTES: '10,30' }),
    );
    // retryCountBefore=2 → newRetryCount=3 → idx=2 → out of range
    expect(() => p.decide(2)).toThrow(/PAYOUT_BACKOFF_MINUTES/);
  });

  it('empty PAYOUT_BACKOFF_MINUTES → throws', async () => {
    const p = await makePolicy(makeConfig({ PAYOUT_BACKOFF_MINUTES: '' }));
    expect(() => p.decide(0)).toThrow(/PAYOUT_BACKOFF_MINUTES/);
  });

  it('negative backoff entry → throws', async () => {
    const p = await makePolicy(
      makeConfig({ PAYOUT_BACKOFF_MINUTES: '10,-5,60,180,360' }),
    );
    expect(() => p.decide(1)).toThrow(/PAYOUT_BACKOFF_MINUTES\[1\]/);
  });
});
