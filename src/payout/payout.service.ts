/**
 * PayoutService — PYG-330 (ก้อน B) create-side
 *
 * เรียกจาก PayoutCreationListener หลัง booking.completed:
 *   1) โหลด booking + payments (idempotent read)
 *   2) guard 3 ชั้น — skip เงียบ ๆ + log (ไม่ throw ให้ event bus)
 *      - booking.caregiverId = null
 *      - ไม่มี payments ของ booking นี้
 *      - booking.completedAt < PAYOUT_START_FROM (cutoff)
 *   3) คำนวณ fee snapshot (Prisma.Decimal end-to-end — ห้าม js number)
 *   4) INSERT payouts — booking_id UNIQUE เป็น idempotency guard ระดับ DB
 *      ยิง P2002 = มี payout อยู่แล้ว → log แล้วข้าม ห้าม upsert
 *
 * ⚠️ Money rules (ตาม CHECK constraint `payouts_amount_split_check`):
 *   - amount = grossAmount - platformFee (ต้อง "ลบ" ไม่ใช่ gross*(1-rate) แยก)
 *   - platformFee = grossAmount * feeRate (ROUND_HALF_UP 2 ทศนิยม)
 *   - feeRate = env ณ เวลานั้น (snapshot ลง row ตลอดชีวิต — นโยบายเปลี่ยนก็ไม่กระทบ row เก่า)
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';

@Injectable()
export class PayoutService {
  private readonly logger = new Logger(PayoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * createFromCompletedBooking — สร้าง payout row สำหรับ booking ที่เพิ่ง completed
   *
   * ไม่ throw ให้ event listener — ทุก error path จบด้วย log แล้ว return
   * เพื่อไม่ให้ notification/email flow ของ BookingNotificationListener พังตาม
   */
  async createFromCompletedBooking(bookingId: string): Promise<void> {
    // ── 1. Load booking + payment ในครั้งเดียว ────────────────────────────
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        caregiverId: true,
        completedAt: true,
        payment: {
          select: {
            id: true,
            amount: true,
          },
        },
      },
    });

    if (!booking) {
      this.logger.warn(
        `[PayoutService] booking ${bookingId} not found — skipping payout creation`,
      );
      return;
    }

    // ── 2. Guards ─────────────────────────────────────────────────────────

    if (!booking.caregiverId) {
      this.logger.log(
        `[PayoutService] skip booking=${bookingId} — caregiverId is null`,
      );
      return;
    }

    if (!booking.payment) {
      this.logger.log(
        `[PayoutService] skip booking=${bookingId} — no payment row (booking may have been completed without a paid charge)`,
      );
      return;
    }

    if (!booking.completedAt) {
      this.logger.warn(
        `[PayoutService] skip booking=${bookingId} — completedAt is null (should not happen if event fired correctly)`,
      );
      return;
    }

    const cutoff = this.parseCutoff();
    if (booking.completedAt.getTime() < cutoff.getTime()) {
      this.logger.log(
        `[PayoutService] skip booking=${bookingId} — completedAt=${booking.completedAt.toISOString()} is before PAYOUT_START_FROM=${cutoff.toISOString()}`,
      );
      return;
    }

    // ── 3. Calc — Prisma.Decimal end-to-end ───────────────────────────────
    // grossAmount = payments.amount (Decimal from Prisma)
    // feeRate     = env, snapshot ลง row (ห้าม default DB)
    // platformFee = round(gross * rate, 2, HALF_UP)
    // amount      = gross - platformFee  ← ห้าม gross * (1-rate) แยก
    const grossAmount = booking.payment.amount as unknown as Prisma.Decimal;
    const feeRate = new Prisma.Decimal(
      this.config.getOrThrow<string>('PAYOUT_PLATFORM_FEE_RATE'),
    );
    const platformFee = grossAmount
      .mul(feeRate)
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    const amount = grossAmount.sub(platformFee);

    const holdWindowDays = Number(
      this.config.getOrThrow<string>('PAYOUT_HOLD_WINDOW_DAYS'),
    );
    // completedAt เป็น Date (UTC absolute) — บวก ms ตรง ๆ timezone-agnostic
    const scheduledAt = new Date(
      booking.completedAt.getTime() + holdWindowDays * 24 * 60 * 60 * 1000,
    );

    // ── 4. INSERT — booking_id UNIQUE = DB-level idempotency ──────────────
    try {
      await this.prisma.payout.create({
        data: {
          bookingId,
          caregiverId: booking.caregiverId,
          grossAmount,
          feeRate,
          platformFee,
          amount,
          scheduledAt,
          // status='scheduled', retryCount=0 มาจาก @default() ใน schema
        },
      });

      this.logger.log(
        `[PayoutService] created payout for booking=${bookingId} caregiver=${booking.caregiverId} gross=${grossAmount.toString()} fee=${platformFee.toString()} net=${amount.toString()} scheduledAt=${scheduledAt.toISOString()}`,
      );
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        this.logger.log(
          `[PayoutService] payout already exists for booking=${bookingId} — skipping (idempotent)`,
        );
        return;
      }
      // อื่น ๆ — log + swallow (ไม่ทำให้ event ล่มทั้งชุด)
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[PayoutService] unexpected error creating payout for booking=${bookingId}: ${msg}`,
      );
    }
  }

  /**
   * parseCutoff — parse PAYOUT_START_FROM (ISO string with tz offset)
   * ตัวอย่าง: '2026-07-18T00:00:00+07:00'
   * new Date() รองรับ tz offset → เก็บเป็น UTC absolute เรียบร้อย
   */
  private parseCutoff(): Date {
    const raw = this.config.getOrThrow<string>('PAYOUT_START_FROM');
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
      throw new Error(
        `PAYOUT_START_FROM is not a valid ISO date: "${raw}"`,
      );
    }
    return d;
  }
}
