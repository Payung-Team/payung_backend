/**
 * PayoutReaperService — PYG-331 (ก้อน B) stale-processing reaper
 *
 * ปัญหาที่แก้:
 *   PR #11 (330 ก้อน B) มี known gap: worker crash หลัง claim → row ค้าง
 *   status='processing' ถาวร (worker query แค่ scheduled) ต้องมีตัวปลด
 *
 * วิธีทำ:
 *   @Cron แยกทุก 10 นาที (ต่างเวลาจาก worker เล็กน้อยจะดีกว่า
 *   — reaper รอบเดียวกับ worker อาจตะกละ row ที่ worker กำลังยิง Omise อยู่จริง ๆ)
 *   หา row ที่ status='processing' AND updated_at < now() - STALE_MINUTES
 *   → transition กลับ scheduled ผ่าน retry policy (นับเป็น fail 1 ครั้ง)
 *   ⚠️ idempotency key = `payout:${id}` คงที่ = ปลอดภัย
 *     ถ้า Omise สำเร็จจริงตอน crash รอบหน้ายิงซ้ำ Omise dedup ได้
 *
 * env:
 *   PAYOUT_STALE_PROCESSING_MINUTES=30
 *
 * ทำไม @Cron แยก ไม่รวมใน worker.run()?
 *   - แยก concern: worker = จ่ายเงิน, reaper = ทำความสะอาด
 *   - test ง่าย: mock กันได้แยก (state machine กับ retry policy ก็ต้องใช้ทั้งคู่)
 *   - ถ้ารวม log จะปนกัน ตอน admin อ่าน timeline จะสับสน
 *
 * ⚠️ ทำไมนับเป็น fail (retry_count++) ไม่ใช่คืน scheduled เฉย ๆ?
 *   crash-after-claim = อาการเหมือน Omise timeout แบบหนึ่ง เราไม่รู้ว่าจริง ๆ Omise
 *   ยิงสำเร็จหรือเปล่า — retry_count เพิ่ม + backoff จะพา payout ที่มีปัญหาซ้ำ ๆ ไป
 *   terminate เป็น 'failed' ได้ ไม่ค้างอยู่ตลอด
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma.service';
import { PayoutStateMachine } from './payout-state-machine';
import { PayoutStatus } from './entities/payout-status.enum';
import { PayoutRetryPolicy } from './payout-retry-policy';
import { PayoutKillswitch } from './payout-killswitch';

@Injectable()
export class PayoutReaperService {
  private readonly logger = new Logger(PayoutReaperService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly stateMachine: PayoutStateMachine,
    private readonly retryPolicy: PayoutRetryPolicy,
    private readonly killswitch: PayoutKillswitch,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async run(): Promise<void> {
    if (this.killswitch.gate('PayoutReaper')) return;

    const staleMinutes = this.readStaleMinutes();
    const threshold = new Date(Date.now() - staleMinutes * 60 * 1000);

    const stale = await this.prisma.payout.findMany({
      where: {
        status: PayoutStatus.processing,
        updatedAt: { lt: threshold },
      },
    });

    if (stale.length === 0) {
      this.logger.debug('[PayoutReaper] no stale processing rows');
      return;
    }

    this.logger.warn(
      `[PayoutReaper] found ${stale.length} stale processing payout(s) — reaping`,
    );

    for (const payout of stale) {
      try {
        await this.reapOne(payout.id, payout.retryCount);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `[PayoutReaper] uncaught error payout=${payout.id}: ${msg}`,
        );
      }
    }
  }

  /**
   * reapOne — คืน 1 stale row กลับ scheduled ผ่าน retry policy
   *
   * ⚠️ race check: อีก worker/reaper อาจ update ระหว่าง read → transition
   *    transition() ใช้ findUnique + validate current status — ถ้า status ไม่ใช่
   *    'processing' แล้ว จะ throw InvalidPayoutTransitionError → catch + log + move on
   */
  async reapOne(payoutId: string, retryCountBefore: number): Promise<void> {
    const decision = this.retryPolicy.decide(retryCountBefore);

    try {
      if (decision.kind === 'retry') {
        await this.stateMachine.transition(payoutId, PayoutStatus.scheduled, {
          reason: 'stale_processing_reaped',
          metadata: {
            newRetryCount: decision.newRetryCount,
            backoffMinutes: decision.backoffMinutes,
            nextRetryAt: decision.nextRetryAt.toISOString(),
          },
          nextRetryAt: decision.nextRetryAt,
          extraPayoutFields: { retryCount: { increment: 1 } },
        });
        this.logger.log(
          `[PayoutReaper] reaped payout=${payoutId} → scheduled (retry_count=${decision.newRetryCount}, next_retry_at=${decision.nextRetryAt.toISOString()})`,
        );
        return;
      }

      // terminate: processing → scheduled → failed ใน tx เดียว
      // (mirror worker.handleTransferFailure — กฎ processing → failed ห้ามตรง)
      await this.prisma.$transaction(async (tx) => {
        await this.stateMachine.transition(
          payoutId,
          PayoutStatus.scheduled,
          {
            reason: 'stale_processing_reaped_before_terminate',
            metadata: { newRetryCount: decision.newRetryCount },
            nextRetryAt: null,
            extraPayoutFields: { retryCount: { increment: 1 } },
          },
          tx,
        );
        await this.stateMachine.transition(
          payoutId,
          PayoutStatus.failed,
          {
            reason: 'max_retries_exceeded_from_reaper',
            metadata: { retryCount: decision.newRetryCount },
          },
          tx,
        );
      });
      this.logger.error(
        `[PayoutReaper] payout=${payoutId} exhausted retries via reaper → failed (retry_count=${decision.newRetryCount})`,
      );
    } catch (err) {
      // ถ้าเป็น race (status เปลี่ยนไปแล้วก่อน transition) — log แล้วผ่านไป
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[PayoutReaper] transition failed payout=${payoutId}: ${msg} (likely status changed mid-flight)`,
      );
    }
  }

  private readStaleMinutes(): number {
    const raw = this.config.getOrThrow<string>(
      'PAYOUT_STALE_PROCESSING_MINUTES',
    );
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(
        `PAYOUT_STALE_PROCESSING_MINUTES must be positive integer, got "${raw}"`,
      );
    }
    return n;
  }
}
