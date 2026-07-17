/**
 * PayoutWorkerService — PYG-330 (ก้อน B) worker-side
 *
 * @Cron ทุก 10 นาที: หา payouts ที่ status='scheduled' และถึงกำหนด → โอนเงินผ่าน Omise
 *
 * ลำดับต่อ 1 payout (ตามที่ Sam ยืนยัน):
 *   1) READ CaregiverPayoutAccount ก่อน — ห้าม claim ก่อน
 *      ถ้า recipient null / recipient_status != 'verified' → log + skip (ไม่แตะ row)
 *      เหตุผล: ถ้า claim แล้ว revert ทุก 10 นาที × 7 วัน = row churn + audit log ยาว
 *   2) CLAIM ด้วย conditional UPDATE 1 statement:
 *        UPDATE payouts SET status='processing', recipient_id=$1
 *        WHERE id=$2 AND status='scheduled'
 *      updateMany().count === 0 = worker อื่นได้ไปแล้ว → ข้าม
 *   3) เรียก Omise createTransfer(satangs, recipientId, `payout:${payout.id}`)
 *      idempotency key คงที่ต่อ payout — ห้ามใส่ retry_count / timestamp
 *      (คุณสมบัติเดียวที่ทำให้ Omise dedup โอนซ้ำได้จริง)
 *   4) success → status='paid', omise_transfer_id, processed_at
 *              + NotificationService.create(caregiver.userId, payment_transferred, ...)
 *      failure → status กลับ 'scheduled', retry_count += 1
 *              ห้ามตั้ง 'failed' — PYG-331 เป็นเจ้าของ state machine + dead-letter
 *
 * ⚠️ Known gap (อยู่ใน PR description ด้วย):
 *   ถ้า worker crash "หลัง" claim(processing) แต่ "ก่อน" Omise ตอบ → row ค้าง processing
 *   ตลอดกาล (worker query แค่ status='scheduled') ต้องมี stale-processing reaper ใน PYG-331
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { OmiseService } from '../payment/omise/omise.service';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/entities/notification-type.enum';

@Injectable()
export class PayoutWorkerService {
  private readonly logger = new Logger(PayoutWorkerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly omise: OmiseService,
    private readonly notifications: NotificationService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async run(): Promise<void> {
    const now = new Date();
    const due = await this.prisma.payout.findMany({
      where: { status: 'scheduled', scheduledAt: { lte: now } },
      // ใช้ index (status, scheduled_at) — ไม่ต้อง orderBy
    });

    if (due.length === 0) {
      this.logger.debug('[PayoutWorker] no due payouts');
      return;
    }

    this.logger.log(`[PayoutWorker] processing ${due.length} due payout(s)`);

    for (const payout of due) {
      // isolate errors per payout — 1 ใบพัง ไม่กระทบใบอื่น
      try {
        await this.processOne(payout.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `[PayoutWorker] uncaught error payout=${payout.id}: ${msg}`,
        );
      }
    }
  }

  /**
   * processOne — ทำงาน 1 payout ตามลำดับ 4 ขั้นในหัวไฟล์
   *
   * แยก method เพื่อให้ test ยิงตรงเข้ามาได้ (ไม่ต้อง trigger @Cron)
   */
  async processOne(payoutId: string): Promise<void> {
    // ── Step 1: READ recipient ก่อน claim ──────────────────────────────────
    // โหลด payout + caregiver.userId + payoutAccount ครั้งเดียว
    const payout = await this.prisma.payout.findUnique({
      where: { id: payoutId },
      select: {
        id: true,
        status: true,
        bookingId: true,
        caregiverId: true,
        amount: true,
        retryCount: true,
        caregiver: {
          select: {
            userId: true,
            payoutAccount: {
              select: {
                omiseRecipientId: true,
                recipientStatus: true,
              },
            },
          },
        },
      },
    });

    if (!payout) {
      this.logger.warn(`[PayoutWorker] payout ${payoutId} not found`);
      return;
    }

    // sanity — payout ควรเป็น scheduled (query กรองแล้ว แต่ระหว่างที่ loop
    // worker อื่นอาจแซง)
    if (payout.status !== 'scheduled') {
      this.logger.debug(
        `[PayoutWorker] payout ${payoutId} no longer scheduled (${payout.status}) — skipping`,
      );
      return;
    }

    const account = payout.caregiver?.payoutAccount;
    const recipientId = account?.omiseRecipientId ?? null;
    const recipientStatus = account?.recipientStatus ?? null;

    if (!recipientId || recipientStatus !== 'verified') {
      // ห้าม claim / ห้ามแตะ row — จบตรงนี้ + log
      // caregiver จะมา verify ผ่าน PYG-307 flow แล้ว payout จะยัง scheduled รอ
      this.logger.warn(
        `[PayoutWorker] skip payout=${payoutId} — recipient not ready ` +
          `(recipient_id=${recipientId ?? 'null'}, recipient_status=${recipientStatus ?? 'null'})`,
      );
      return;
    }

    // ── Step 2: CLAIM ด้วย conditional UPDATE (atomic) ─────────────────────
    // WHERE id=? AND status='scheduled' — worker อื่นได้ไปแล้ว count จะ = 0
    const claimed = await this.prisma.payout.updateMany({
      where: { id: payoutId, status: 'scheduled' },
      data: { status: 'processing', recipientId },
    });

    if (claimed.count === 0) {
      this.logger.debug(
        `[PayoutWorker] payout ${payoutId} already claimed by another worker`,
      );
      return;
    }

    this.logger.log(
      `[PayoutWorker] claimed payout=${payoutId} recipient=${recipientId}`,
    );

    // ── Step 3: Omise createTransfer ───────────────────────────────────────
    // amount (Prisma.Decimal, THB) → satangs integer สำหรับ Omise
    const amountDecimal = payout.amount as unknown as Prisma.Decimal;
    const amountSatangs = amountDecimal
      .mul(100)
      .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
      .toNumber();

    // idempotency key คงที่ต่อ payout — ห้ามใส่ retry_count/timestamp
    // Omise dedup ที่ฝั่งเขา: key เดิม + params เดิม = คืน response เดิม
    const idempotencyKey = `payout:${payout.id}`;

    try {
      const transfer = await this.omise.createTransfer(
        amountSatangs,
        recipientId,
        idempotencyKey,
      );

      // ── Step 4a: success → 'paid' + notification ─────────────────────────
      await this.prisma.payout.update({
        where: { id: payoutId },
        data: {
          status: 'paid',
          omiseTransferId: transfer.id,
          processedAt: new Date(),
        },
      });

      this.logger.log(
        `[PayoutWorker] paid payout=${payoutId} transferId=${transfer.id} amountSth=${amountSatangs}`,
      );

      // ยิง in-app notification ตรง ๆ ผ่าน NotificationService (ไม่มี event/listener กลาง)
      const caregiverUserId = payout.caregiver?.userId;
      if (caregiverUserId) {
        try {
          await this.notifications.create(
            caregiverUserId,
            NotificationType.payment_transferred,
            'ค่าตอบแทนโอนแล้ว',
            `เราได้โอนค่าตอบแทน ${amountDecimal.toString()} บาท เข้าบัญชีของคุณแล้ว`,
            {
              payoutId: payout.id,
              bookingId: payout.bookingId,
              amount: amountDecimal.toString(),
              omiseTransferId: transfer.id,
            },
          );
        } catch (notifyErr) {
          // notification พังห้ามทำให้ payout ที่โอนสำเร็จแล้ว rollback
          const msg =
            notifyErr instanceof Error ? notifyErr.message : String(notifyErr);
          this.logger.error(
            `[PayoutWorker] notification failed payout=${payoutId}: ${msg}`,
          );
        }
      } else {
        this.logger.warn(
          `[PayoutWorker] payout=${payoutId} caregiver has no userId — cannot notify`,
        );
      }
    } catch (transferErr) {
      // ── Step 4b: failure → กลับ 'scheduled' + retry_count++ ──────────────
      // ห้ามตั้ง 'failed' — PYG-331 เป็นเจ้าของ retry policy / dead-letter
      const msg =
        transferErr instanceof Error ? transferErr.message : String(transferErr);
      this.logger.error(
        `[PayoutWorker] Omise transfer failed payout=${payoutId}: ${msg}`,
      );

      await this.prisma.payout.update({
        where: { id: payoutId },
        data: {
          status: 'scheduled',
          retryCount: { increment: 1 },
        },
      });

      // ไม่ throw — for-loop ใน run() ต้องทำ payout ใบถัดไปได้
    }
  }
}
