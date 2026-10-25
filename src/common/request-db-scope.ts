/**
 * PYG-716 — การเชื่อมต่อฐานข้อมูล "ต่อคำขอ" บน Cloudflare Workers — โดยไม่ต้องสร้าง PrismaClient/Nest service ใหม่ทุกคำขอ
 *
 * ปัญหาเดิม (Scope.REQUEST บน PrismaService):
 *   Workers ห้ามใช้ socket ที่เปิดในคำขอหนึ่งกับอีกคำขอ ("Cannot perform I/O on behalf of a different request")
 *   จึงเคยแก้ด้วย PrismaService แบบ request-scoped → Nest ประกอบ service ที่พึ่ง Prisma ใหม่ทั้งชุด
 *   + PrismaClient (WASM engine) ตัวใหม่ทุกคำขอ และไม่เคยปิด (Nest ไม่เรียก onModuleDestroy ให้ request-scoped)
 *   → CPU ต่อคำขอสูง (dashboard เฉลี่ย ~250 ms) เกินลิมิตแพ็กเกจ Free → error 1102/1101
 *
 * ตอนนี้:
 *   - PrismaClient ตัวเดียว (singleton) — adapter ได้ RequestScopedPool ซึ่งส่ง query()/connect()
 *     ต่อไปยัง pg Pool "ของคำขอปัจจุบัน" ที่เก็บใน AsyncLocalStorage
 *   - pool ของคำขอสร้างเมื่อคำขอนั้นแตะฐานข้อมูลครั้งแรก และปิดหลังส่ง response + งานเบื้องหลังเสร็จ
 *   - นอก scope (Node server ปกติ / jest) ใช้ pool ของตัวเองแบบเดิม — พฤติกรรมเหมือน dev ทุกประการ
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, type PoolConfig } from 'pg';

type RequestDbScope = {
  pool?: Pool;
  /** งาน fire-and-forget ของคำขอนี้ (runInBackground) — ต้องรอให้จบก่อนปิด pool */
  tasks: Promise<unknown>[];
};

const storage = new AsyncLocalStorage<RequestDbScope>();

/** ค่าตั้ง pool ต่อคำขอ — 1 การเชื่อมต่อพอ (Hyperdrive ทำ pooling ฝั่ง Cloudflare ให้แล้ว) */
export function requestPoolConfig(): PoolConfig {
  return {
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 5_000,
    allowExitOnIdle: true,
  };
}

function currentScopePool(): Pool | undefined {
  const scope = storage.getStore();
  if (!scope) return undefined;
  if (!scope.pool) {
    scope.pool = new Pool(requestPoolConfig());
    // pool ที่ idle แล้ว error (เช่น Hyperdrive ตัดการเชื่อมต่อ) ต้องไม่กลายเป็น unhandled error ที่ฆ่า isolate
    scope.pool.on('error', (err) =>
      console.warn('[request-db] idle client error', err.message),
    );
  }
  return scope.pool;
}

/**
 * pg Pool ที่ PrismaPg ถือไว้ตลอดอายุ isolate — แต่ query/connect ไปเกิดบน pool ของคำขอปัจจุบัน
 * (PrismaPg ตรวจ `instanceof pg.Pool` และเรียกแค่ query() / connect() / on() / removeListener())
 */
export class RequestScopedPool extends Pool {
  /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- ส่งต่อ overload ทุกแบบของ pg.Pool ตรง ๆ */
  override query(...args: any[]): any {
    const pool = currentScopePool();
    return pool ? (pool.query as any)(...args) : (super.query as any)(...args);
  }

  override connect(...args: any[]): any {
    const pool = currentScopePool();
    return pool
      ? (pool.connect as any)(...args)
      : (super.connect as any)(...args);
  }
  /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call */
}

/** ผูกงานเบื้องหลังเข้ากับ scope ของคำขอ — ปิด pool หลังงานนี้จบ */
export function trackRequestTask(task: Promise<unknown>): void {
  storage.getStore()?.tasks.push(task);
}

/**
 * รัน handler ของคำขอหนึ่งใน scope ของตัวเอง แล้วคืน promise ที่ resolve เมื่อปิดการเชื่อมต่อของคำขอนี้เสร็จ
 * (ส่งให้ ctx.waitUntil — response ถูกส่งไปก่อน ไม่ต้องรอปิด)
 */
export function runInRequestDbScope<T>(handler: () => Promise<T>): {
  result: Promise<T>;
  disposed: Promise<void>;
} {
  const scope: RequestDbScope = { tasks: [] };
  const result = storage.run(scope, handler);
  const disposed = result
    .catch(() => undefined)
    .then(async () => {
      // งานเบื้องหลังอาจเพิ่มงานต่อ — วนจนไม่มีงานใหม่
      let seen = 0;
      while (seen < scope.tasks.length) {
        const batch = scope.tasks.slice(seen);
        seen = scope.tasks.length;
        await Promise.allSettled(batch);
      }
      await scope.pool?.end().catch(() => undefined);
    });
  return { result, disposed };
}
