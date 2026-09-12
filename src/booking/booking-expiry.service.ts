/**
 * BookingExpiryService (PYG-461/462 เฟส 1) — ปิด booking ที่เลยเวลาแล้ว "และไม่มีเงินค้าง"
 *
 * ครอบเฉพาะ booking ที่ครบทั้ง 3 ข้อ:
 *   1. status = pending (ผู้ดูแลไม่รับ) หรือ accepted (ผู้ป่วยไม่จ่าย)
 *   2. ไม่มี payment row เลย หรือ payment อยู่ใน failed / expired / voided (ไม่มีเงินค้าง)
 *   3. เลย deadline + BOOKING_EXPIRY_BUFFER_MINUTES แล้ว (deadline ดู booking-deadline.config.ts)
 * → status = 'expired' + เขียน booking_status_history + แจ้งผู้ป่วยและผู้ดูแล
 *
 * ★ cron นี้ "ไม่แตะเงิน" และไม่เรียก Omise เลย — booking ที่มี payment pending / held / captured
 *   (หรือสถานะเงินอื่นที่ไม่ใช่ 3 ตัวข้างบน) ห้ามแตะเด็ดขาด เป็นงานของ BookingSettlementService (เฟส 2/3)
 *
 * ★ kill-switch: ปิดเป็น default — ต้องตั้ง BOOKING_EXPIRY_CRON_ENABLED=true เอง
 *   (ห้ามปล่อยค่า 'expired' ออกไปก่อน FE รองรับ)
 *
 * Concurrency: ห้าม read-then-write — การเปลี่ยนสถานะเป็น UPDATE เดียวที่มีเงื่อนไขครบ
 *   (status เดิม + NOT EXISTS เงินค้าง) ถ้า acceptBooking/createPayment ชนกันพอดี
 *   Postgres จะ re-check WHERE หลังรอ row lock → มีผู้ชนะฝั่งเดียว อีกฝั่งได้ 0 แถว
 *   (acceptBooking ใช้ updateMany WHERE status='pending' เหมือนกัน — ดู caregiver-booking.service.ts)
 *
 * ประมวลผลทีละใบ (sequential) + เพดานต่อรอบ — ไม่เปิด tx ขนานกินพูล (pg Pool default max = 10)
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { ClockService } from '../common/clock.service';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/entities/notification-type.enum';
import { PaymentStatus } from '../payment/entities/payment-status.enum';
import { BookingStatusEnum } from './dto/booking-summary.types';
import { recordBookingStatusChange } from './booking-status-history';
import {
  ACCEPT_GRACE_MINUTES,
  BOOKING_EXPIRY_BUFFER_MINUTES,
  BOOKING_EXPIRY_ENABLED_ENV,
  EXPIRY_REASON,
  PAYMENT_GRACE_MINUTES,
  acceptDeadlineOf,
  bangkokDateOf,
  paymentDeadlineOf,
  toBangkokText,
} from './booking-deadline.config';

/** สถานะ payment ที่ถือว่า "ไม่มีเงินค้าง" — นอกเหนือจากนี้ cron ห้ามแตะ */
export const NO_MONEY_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  PaymentStatus.failed,
  PaymentStatus.expired,
  PaymentStatus.voided,
];

/** booking สถานะที่ cron นี้ปิดได้ */
const EXPIRABLE_STATUSES = [
  BookingStatusEnum.PENDING,
  BookingStatusEnum.ACCEPTED,
] as const;

/** เพดานต่อรอบ กัน backlog ทำให้ cron ค้าง (แนวเดียวกับ NoCheckoutSweeperService) */
export const EXPIRY_BATCH_CAP = 50;

const MINUTE_MS = 60 * 1000;

type Candidate = {
  id: string;
  status: string;
  patientId: string;
  bookingDate: Date;
  startTime: Date | null;
  caregiver: { userId: string } | null;
  payment: { paymentStatus: string } | null;
};

@Injectable()
export class BookingExpiryService {
  private readonly logger = new Logger(BookingExpiryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly notifications: NotificationService,
    private readonly config: ConfigService,
  ) {}

  /** true เฉพาะเมื่อตั้ง BOOKING_EXPIRY_CRON_ENABLED เป็น true / 1 / yes (parse แบบ PayoutKillswitch) */
  isEnabled(): boolean {
    const raw = (this.config.get<string>(BOOKING_EXPIRY_ENABLED_ENV) ?? '')
      .trim()
      .toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'yes';
  }

  // นาที 15 และ 45 — เลี่ยง no-checkout sweeper (:05/:35), PromptPay reaper (:00) และ payout worker (ทุก 10 นาที)
  @Cron(process.env['CRON_BOOKING_EXPIRY'] ?? '15,45 * * * *')
  async run(): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.debug(
        `[booking-expiry] ${BOOKING_EXPIRY_ENABLED_ENV} ไม่ได้เปิด — ข้ามรอบนี้`,
      );
      return;
    }

    const now = this.clock.now();

    const candidates: Candidate[] = await this.prisma.booking.findMany({
      where: {
        status: { in: [...EXPIRABLE_STATUSES] },
        // กรองหยาบด้วยวันที่ (ไทย) ก่อน — deadline จริงตัดสินรายใบข้างล่าง เพราะ start_time เป็น TIME
        bookingDate: { lte: bangkokDateOf(now) },
        OR: [
          { payment: { is: null } },
          {
            payment: {
              is: { paymentStatus: { in: [...NO_MONEY_PAYMENT_STATUSES] } },
            },
          },
        ],
      },
      select: {
        id: true,
        status: true,
        patientId: true,
        bookingDate: true,
        startTime: true,
        caregiver: { select: { userId: true } },
        payment: { select: { paymentStatus: true } },
      },
      orderBy: { bookingDate: 'asc' }, // เก่าสุดก่อน
      take: EXPIRY_BATCH_CAP,
    });

    let expired = 0;
    for (const b of candidates) {
      const deadline = this.deadlineOf(b);
      const threshold =
        deadline.getTime() + BOOKING_EXPIRY_BUFFER_MINUTES * MINUTE_MS;
      if (now.getTime() <= threshold) continue; // ยังไม่ถึงเวลาปิด

      try {
        const done = await this.expireOne(b, deadline, now);
        if (!done) continue; // มีคนเปลี่ยนสถานะไปก่อน (รับงาน/จ่ายเงิน) — ปล่อยไป
        expired += 1;
        await this.notify(b, deadline);
      } catch (err) {
        // 1 ใบพังต้องไม่ล้มทั้งรอบ
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`[booking-expiry] failed booking=${b.id}: ${msg}`);
      }
    }

    if (expired > 0) {
      this.logger.log({
        event: 'booking.expiry_sweep',
        expired,
        scanned: candidates.length,
      });
    }
  }

  /** pending → รอผู้ดูแลรับ (acceptDeadline) · accepted → รอผู้ป่วยจ่าย (paymentDeadline) */
  private deadlineOf(b: Candidate): Date {
    return b.status === (BookingStatusEnum.PENDING as string)
      ? acceptDeadlineOf(b.bookingDate, b.startTime)
      : paymentDeadlineOf(b.bookingDate, b.startTime);
  }

  /**
   * conditional UPDATE + history ใน tx เดียว
   * @returns false ถ้า UPDATE ได้ 0 แถว (สถานะเปลี่ยนไปแล้ว หรือมีเงินเข้ามา) — ไม่เขียนอะไรเลย
   */
  private async expireOne(
    b: Candidate,
    deadline: Date,
    now: Date,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "bookings" AS b
           SET "status" = ${BookingStatusEnum.EXPIRED}, "updated_at" = ${now}
         WHERE b."id" = ${b.id}::uuid
           AND b."status" = ${b.status}
           AND NOT EXISTS (
             SELECT 1 FROM "payments" p
              WHERE p."booking_id" = b."id"
                AND p."payment_status"::text NOT IN (${Prisma.join([...NO_MONEY_PAYMENT_STATUSES])})
           )
        RETURNING b."id"`;
      if (rows.length === 0) return false;

      const isNoAccept = b.status === (BookingStatusEnum.PENDING as string);
      await recordBookingStatusChange(tx, {
        bookingId: b.id,
        fromStatus: b.status,
        toStatus: BookingStatusEnum.EXPIRED,
        changedBy: null, // ระบบ
        reason: isNoAccept ? EXPIRY_REASON.NO_ACCEPT : EXPIRY_REASON.NO_PAYMENT,
        metadata: {
          source: 'booking_expiry_cron',
          deadline: deadline.toISOString(),
          expiredAt: now.toISOString(),
          graceMinutes: isNoAccept
            ? ACCEPT_GRACE_MINUTES
            : PAYMENT_GRACE_MINUTES,
          bufferMinutes: BOOKING_EXPIRY_BUFFER_MINUTES,
          paymentStatus: b.payment?.paymentStatus ?? null,
        },
      });
      return true;
    });
  }

  /**
   * แจ้งผู้ป่วย + ผู้ดูแล — reuse NotificationType.booking_cancelled (แพตเทิร์น sweeper: ไม่เพิ่ม enum ใหม่
   * เพื่อไม่ต้องมี migration) ข้อความแยกให้รู้ว่า "ระบบปิดเพราะเลยเวลา" ไม่ใช่มีคนกดยกเลิก
   */
  private async notify(b: Candidate, deadline: Date): Promise<void> {
    const dateText = b.bookingDate.toISOString().slice(0, 10);
    const data = { bookingId: b.id, source: 'booking.expired' };
    const isNoAccept = b.status === (BookingStatusEnum.PENDING as string);

    await this.notifications.create(
      b.patientId,
      NotificationType.booking_cancelled,
      'การจองหมดอายุ',
      isNoAccept
        ? `ผู้ดูแลไม่ได้ตอบรับการจองวันที่ ${dateText} ภายใน ${toBangkokText(deadline)} ระบบจึงปิดการจองนี้ให้ ไม่มีการเรียกเก็บเงิน`
        : `การจองวันที่ ${dateText} ไม่ได้ชำระเงินภายใน ${toBangkokText(deadline)} ระบบจึงปิดการจองนี้ให้ ไม่มีการเรียกเก็บเงิน`,
      data,
    );

    if (b.caregiver?.userId) {
      await this.notifications.create(
        b.caregiver.userId,
        NotificationType.booking_cancelled,
        'งานหมดอายุ',
        isNoAccept
          ? `คำของานวันที่ ${dateText} หมดอายุเพราะไม่ได้ตอบรับก่อนเวลาเริ่มงาน`
          : `งานวันที่ ${dateText} หมดอายุเพราะผู้ใช้บริการไม่ได้ชำระเงินก่อนเวลาเริ่มงาน`,
        data,
      );
    }
  }
}
