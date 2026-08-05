/**
 * IdempotencyService (PYG-375) — deterministic once-only execution for money commands.
 *
 * runOnce():
 *   1. INSERT the key FIRST (inside the caller's tx when given). A PK collision means
 *      the command is already done / in-flight:
 *        - stored result present → return it (no 2nd Omise call)
 *        - reserved but no result → in-flight (or crashed) → ConflictException
 *   2. call Omise via fn(key) — fn ALSO passes `key` as the Omise-Idempotency-Key header
 *      (two layers: our table + Omise's own dedup)
 *   3. store the result JSON on the row
 *
 * Keys are always deterministic (never random) — a repeat must produce the SAME key,
 * otherwise the whole mechanism is pointless:
 *   capture  : capture:{bookingId}
 *   refund   : refund:{paymentId}:{refunded_amount_before}
 *   payout   : payout:{payoutId}
 *   transfer : transfer:{payoutId}:{attempt}
 */
import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';

export interface RunOnceParams<T> {
  key: string;
  action: string;
  bookingId?: string | null;
  /** the real Omise call; receives the same deterministic key to pass as the Omise header */
  fn: (idempotencyKey: string) => Promise<T>;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * @param tx optional transaction client — pass it when the money command runs inside a
   *           SELECT … FOR UPDATE tx (capture/refund) so the key reservation shares that tx:
   *           if the tx rolls back on Omise failure, the key is released and a retry can run.
   */
  async runOnce<T>(params: RunOnceParams<T>, tx?: Prisma.TransactionClient): Promise<T> {
    const db = tx ?? this.prisma;

    // 1. reserve the key (INSERT first)
    try {
      await db.idempotencyKey.create({
        data: {
          key: params.key,
          action: params.action,
          bookingId: params.bookingId ?? null,
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // already ran / running — read the stored result (from the committed row)
        const existing = await this.prisma.idempotencyKey.findUnique({
          where: { key: params.key },
        });
        if (existing && existing.result != null) {
          this.logger.log(`[idempotency] ${params.key} replay → returning stored result`);
          return existing.result as T;
        }
        // reserved but no result → another worker holds it (or crashed mid-flight)
        this.logger.warn(`[idempotency] ${params.key} in-flight (no stored result yet)`);
        throw new ConflictException(
          'คำสั่งนี้กำลังดำเนินการอยู่ กรุณาลองใหม่อีกครั้งภายหลัง',
        );
      }
      throw err;
    }

    // 2. call Omise once, passing the SAME key as the Omise idempotency header
    const result = await params.fn(params.key);

    // 3. persist the result so a later replay short-circuits at step 1
    await db.idempotencyKey.update({
      where: { key: params.key },
      data: { result: result as Prisma.InputJsonValue },
    });

    return result;
  }

  /** cron cleanup — delete keys older than `days` (default 30). Returns rows removed. */
  async pruneOlderThan(days = 30): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const { count } = await this.prisma.idempotencyKey.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return count;
  }
}
