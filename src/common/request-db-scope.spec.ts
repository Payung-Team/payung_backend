/**
 * request-db-scope — การเชื่อมต่อฐานข้อมูลต่อคำขอบน Worker โดยใช้ PrismaClient ตัวเดียว
 *
 * สิ่งที่คุม:
 *   - ในคำขอ: query/connect ไปที่ pool ของคำขอนั้น (สร้างเมื่อแตะฐานข้อมูลครั้งแรกเท่านั้น)
 *   - คนละคำขอ = คนละ pool (Workers ห้ามใช้ socket ข้ามคำขอ)
 *   - ปิด pool หลังคำขอจบ "และ" งานเบื้องหลังจบ — ไม่ใช่ก่อน
 *   - นอก scope (Node / jest) ใช้ pool ของตัวเองเหมือนเดิม
 */
const created: FakePool[] = [];

class FakePool {
  ended = false;
  calls: string[] = [];
  constructor(public readonly config: unknown) {
    created.push(this);
  }
  query(sql: string) {
    this.calls.push(`query:${sql}`);
    return Promise.resolve({ rows: [] });
  }
  connect() {
    this.calls.push('connect');
    return Promise.resolve({ release: () => undefined });
  }
  on() {
    return this;
  }
  end() {
    this.ended = true;
    return Promise.resolve();
  }
}

jest.mock('pg', () => ({ Pool: FakePool }));

import {
  RequestScopedPool,
  runInRequestDbScope,
  trackRequestTask,
} from './request-db-scope';

describe('request-db-scope', () => {
  beforeEach(() => {
    created.length = 0;
  });

  it('ในคำขอ → query ไป pool ของคำขอ · นอกคำขอ → pool ของตัวเอง', async () => {
    const shared = new RequestScopedPool({});
    const own = created[0];

    await shared.query('outside');
    expect(own.calls).toEqual(['query:outside']);

    const { result, disposed } = runInRequestDbScope(async () => {
      await shared.query('inside');
      await shared.connect();
    });
    await result;
    const perRequest = created[1];
    expect(perRequest).toBeDefined();
    expect(perRequest.calls).toEqual(['query:inside', 'connect']);
    expect(own.calls).toEqual(['query:outside']);

    await disposed;
    expect(perRequest.ended).toBe(true);
    expect(own.ended).toBe(false);
  });

  it('คำขอที่ไม่แตะฐานข้อมูล → ไม่สร้าง pool', async () => {
    new RequestScopedPool({});
    const { disposed } = runInRequestDbScope(() => Promise.resolve('ok'));
    await disposed;
    expect(created).toHaveLength(1); // มีแค่ pool ของ singleton
  });

  it('★ คนละคำขอ (พร้อมกัน) = คนละ pool', async () => {
    const shared = new RequestScopedPool({});
    const a = runInRequestDbScope(async () => {
      await shared.query('a');
    });
    const b = runInRequestDbScope(async () => {
      await shared.query('b');
    });
    await Promise.all([a.result, b.result, a.disposed, b.disposed]);

    const perRequest = created.slice(1);
    expect(perRequest).toHaveLength(2);
    expect(perRequest.map((p) => p.calls)).toEqual([['query:a'], ['query:b']]);
    expect(perRequest.every((p) => p.ended)).toBe(true);
  });

  it('★ ปิด pool หลังงานเบื้องหลังจบ (runInBackground) ไม่ใช่ตอนส่ง response', async () => {
    const shared = new RequestScopedPool({});
    let finishBackground!: () => void;

    const { result, disposed } = runInRequestDbScope(async () => {
      await shared.query('request');
      trackRequestTask(
        new Promise<void>((resolve) => (finishBackground = resolve)).then(
          async () => {
            await shared.query('background');
          },
        ),
      );
      return 'response';
    });

    await expect(result).resolves.toBe('response');
    await Promise.resolve();
    const perRequest = created[1];
    expect(perRequest.ended).toBe(false); // งานเบื้องหลังยังไม่จบ → ยังไม่ปิด

    finishBackground();
    await disposed;
    expect(perRequest.calls).toEqual(['query:request', 'query:background']);
    expect(perRequest.ended).toBe(true);
  });

  it('handler พัง → ยังปิด pool และ error ส่งต่อให้ผู้เรียก', async () => {
    const shared = new RequestScopedPool({});
    const { result, disposed } = runInRequestDbScope(async () => {
      await shared.query('x');
      throw new Error('boom');
    });
    await expect(result).rejects.toThrow('boom');
    await disposed;
    expect(created[1].ended).toBe(true);
  });
});
