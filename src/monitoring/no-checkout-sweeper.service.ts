/**
 * NoCheckoutSweeperService (PYG-359) — ปิดงานที่ผู้ดูแล "ลืมเช็คเอาท์" ให้เอง
 *
 * ⚠ อันตราย: cron นี้ "สร้างแถวหลักฐานปลอม" (system check_out) ให้กับงานที่ไม่มีใครกดปิด
 *   จึงต้องกันเงินหลุดด้วย 2 ชั้นอิสระ — ชั้นใดชั้นหนึ่งพังอีกชั้นต้องยังกันได้:
 *     Layer 1: source='system'  → computeVerdict ผ่านได้เฉพาะ source==='caregiver'
 *     Layer 2: review_reasons += 'no_checkout' → computeVerdict ผ่านได้เฉพาะ reasons ว่าง
 *   ผล: verdict = needs_review เสมอ → PayoutEligibility ไม่ปล่อยเงิน (ยังคง held)
 *
 * cron นี้ "ไม่แตะเงิน" เลย — แค่บันทึกว่า "ไม่มีการเช็คเอาท์" แล้วส่งเข้าคิว admin
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { ClockService } from '../common/clock.service';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/entities/notification-type.enum';
import { ROLE_ID } from '../common/constants/roles.constant';
import { BOOKING_EVENTS } from '../notification/events/booking-event';
import {
  BOOKING_STATUS,
  JOB_EVENT_TYPE,
  JOB_EVENT_SOURCE,
  REVIEW_REASON,
  CHECKOUT_SWEEP_HOURS,
} from './monitoring.constants';

/** เพดานต่อรอบ กัน backlog ทำให้ cron ค้าง */
const SWEEP_BATCH_CAP = 50;
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

@Injectable()
export class NoCheckoutSweeperService {
  private readonly logger = new Logger(NoCheckoutSweeperService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly notifications: NotificationService,
  ) {}

  // นาที 5 และ 35 — เลี่ยง EVERY_10_MINUTES ของ payout worker/reaper (ยิงที่ :00..:50)
  @Cron(process.env['CRON_CHECKOUT_SWEEP'] ?? '5,35 * * * *')
  async run(): Promise<void> {
    const now = this.clock.now();

    // งานที่ "เช็คอินแล้ว แต่ไม่มีเช็คเอาท์" และยัง in_progress
    const candidates = await this.prisma.booking.findMany({
      where: {
        status: BOOKING_STATUS.IN_PROGRESS,
        jobEvents: {
          some: { eventType: JOB_EVENT_TYPE.CHECK_IN },
          none: { eventType: JOB_EVENT_TYPE.CHECK_OUT },
        },
      },
      select: {
        id: true,
        caregiverId: true,
        bookingDate: true,
        startTime: true,
        durationHours: true,
        reviewReasons: true,
        caregiver: { select: { userId: true } },
      },
      orderBy: { bookingDate: 'asc' }, // เก่าสุดก่อน = มีโอกาสถึงกำหนดก่อน
      take: SWEEP_BATCH_CAP,
    });

    const cutoffMs = CHECKOUT_SWEEP_HOURS * 60 * 60 * 1000;
    let swept = 0;

    for (const b of candidates) {
      const endTs = this.endTsOf(b.bookingDate, b.startTime, b.durationHours);
      if (now.getTime() <= endTs.getTime() + cutoffMs) continue; // ยังไม่ถึงเวลากวาด

      try {
        await this.sweepOne(b, now);
        swept += 1;
        await this.notify(b);
      } catch (err) {
        // 1 งานพังต้องไม่ล้มทั้งรอบ
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`[no-checkout-sweep] failed booking=${b.id}: ${msg}`);
      }
    }

    if (swept > 0) {
      this.logger.log({ event: 'monitoring.no_checkout_sweep', swept, scanned: candidates.length });
    }
  }

  /**
   * เขียน system check_out + ปิดงานเป็น needs_review ใน transaction เดียว
   * - ไม่คำนวณ duration (ไม่รู้ว่าเลิกงานตอนไหน — เดา = ปลอมหลักฐาน)
   * - ไม่เดาพิกัด (lat/lng/distance = NULL)
   * - append 'no_checkout' ไม่ทับธงเดิม
   * idempotent: ถ้ามี check_out อยู่แล้ว UNIQUE(booking_id,event_type) จะชน P2002 → ข้าม
   */
  private async sweepOne(
    b: { id: string; caregiverId: string | null; reviewReasons: string[] },
    now: Date,
  ): Promise<void> {
    const mergedReasons = Array.from(
      new Set([...b.reviewReasons, REVIEW_REASON.NO_CHECKOUT]),
    );
    try {
      await this.prisma.$transaction([
        this.prisma.jobEvent.create({
          data: {
            bookingId: b.id,
            caregiverId: b.caregiverId as string,
            eventType: JOB_EVENT_TYPE.CHECK_OUT,
            source: JOB_EVENT_SOURCE.SYSTEM, // Layer 1
            lat: null,
            lng: null,
            distanceM: null, // ไม่มีการกดปุ่ม → ไม่เดาตำแหน่ง
            serverTs: now,
            note: 'system: no checkout',
          },
        }),
        this.prisma.booking.update({
          where: { id: b.id },
          data: {
            status: BOOKING_STATUS.NEEDS_REVIEW, // system row → เข้าคิว admin เสมอ (ไม่ใช่ awaiting_release)
            reviewReasons: { set: mergedReasons }, // Layer 2 (append)
          },
        }),
      ]);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        this.logger.log(`[no-checkout-sweep] already closed booking=${b.id} — skip`);
        return;
      }
      throw err;
    }
  }

  /** แจ้งผู้ดูแล (ลืมเช็คเอาท์) + admin ทุกคน (มีงานเข้าคิวรีวิว). ไม่แจ้ง patient. */
  private async notify(b: {
    id: string;
    bookingDate: Date;
    caregiver: { userId: string } | null;
  }): Promise<void> {
    const dateText = b.bookingDate.toISOString().slice(0, 10);
    const data = { bookingId: b.id, source: BOOKING_EVENTS.JOB_NO_CHECKOUT };

    // caregiver — reuse booking_completed type (แพตเทิร์นเดิม: ไม่เพิ่ม enum ใหม่)
    if (b.caregiver?.userId) {
      await this.notifications.create(
        b.caregiver.userId,
        NotificationType.booking_completed,
        'คุณลืมเช็คเอาท์งาน',
        `คุณลืมเช็คเอาท์งานวันที่ ${dateText} ระบบปิดงานให้แล้ว แอดมินกำลังตรวจสอบ`,
        data,
      );
    }

    // admins — งานเข้าคิวรีวิว
    const admins = await this.prisma.user.findMany({
      where: { role: ROLE_ID.ADMIN },
      select: { id: true },
    });
    for (const a of admins) {
      await this.notifications.create(
        a.id,
        NotificationType.booking_completed,
        'มีงานเข้าคิวตรวจสอบ (ไม่มีการเช็คเอาท์)',
        `งาน ${b.id} ถูกปิดโดยระบบเพราะผู้ดูแลไม่ได้เช็คเอาท์ — ต้องตรวจสอบก่อนปล่อยเงิน`,
        data,
      );
    }
  }

  /**
   * end_ts = (booking_date + start_time) + duration_hours ตีความเป็นเวลาไทย
   * start_time เก็บเป็น @db.Time โดย UTC-hours คือเวลานาฬิกาไทย (ตาม scheduledStartOf ของ PYG-352)
   * ประกอบเป็น instant UTC แบบชัดเจน ไม่พึ่ง tz ของ server (กัน sweep เพี้ยน ±7 ชม.)
   */
  private endTsOf(
    bookingDate: Date,
    startTime: Date | null,
    durationHours: Prisma.Decimal | number,
  ): Date {
    const startUtcAsBangkok = Date.UTC(
      bookingDate.getUTCFullYear(),
      bookingDate.getUTCMonth(),
      bookingDate.getUTCDate(),
      startTime ? startTime.getUTCHours() : 0,
      startTime ? startTime.getUTCMinutes() : 0,
      startTime ? startTime.getUTCSeconds() : 0,
    );
    const scheduledStartMs = startUtcAsBangkok - BANGKOK_OFFSET_MS;
    const durH =
      typeof durationHours === 'number' ? durationHours : Number(durationHours);
    return new Date(scheduledStartMs + durH * 60 * 60 * 1000);
  }
}
