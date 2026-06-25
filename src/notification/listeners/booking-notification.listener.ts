/**
 * BookingNotificationListener (PYG-292)
 *
 * ฟัง booking/payment/dispute events → สร้าง in-app notification + ส่งอีเมล
 *
 * Flow ต่อ 1 event:
 *   1) หา config ของ event (recipient ใคร, title/body, ส่งอีเมลไหม)
 *   2) โหลด booking (+ caregiver.userId, payment.amount) มาสร้างเนื้อหา
 *   3) หา "ผู้รับ" เป็น USER id (patient / caregiver / both / admin)
 *   4) ต่อผู้รับ 1 คน → NotificationService.create() (in-app) + EmailService (อีเมล ถ้า config.email)
 *
 * Design choices:
 * - @OnEvent ชื่อเต็มแบบเป๊ะ (ไม่ใช้ wildcard) → ไม่ไปจับ 'payment.expired'/'payment.transferred'
 *   ที่ยิงจาก payment-cron โดยไม่ตั้งใจ
 * - try/catch ครอบทั้งหมด + ไม่ throw → notification/email ที่พังต้องไม่ทำ business flow ล่ม
 *   (ปรัชญาเดียวกับ EmailService)
 * - in-app insert ลงตาราง notifications → Supabase realtime (postgres_changes) ดันให้ FE เอง
 *   ฝั่ง BE ไม่ต้องมี GraphQL subscription
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Prisma, booking_service_type } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { NotificationService } from '../notification.service';
import { NotificationType } from '../entities/notification-type.enum';
import { EmailService } from '../../email/email.service';
import {
  BOOKING_EVENTS,
  type BookingEvent,
  type BookingEventType,
} from '../events/booking-event';

/** ใครเป็นผู้รับ notification ของ event นี้ */
type Recipient = 'patient' | 'caregiver' | 'both' | 'admin';

/** context ที่ใช้สร้างข้อความ (มาจาก booking ที่โหลด + metadata ของ event) */
interface NotifyContext {
  caregiverName: string;
  serviceText: string;
  dateText: string;
  amountText: string;
  reason?: string;
}

/** นิยามพฤติกรรมของแต่ละ event ในที่เดียว (recipient matrix + เนื้อหา) */
interface EventConfig {
  type: NotificationType;
  recipient: Recipient;
  /** หัวข้อ (ตรงกับ Figma "All 11 Notification Types") */
  title: string;
  /** สร้าง body จาก context */
  body: (ctx: NotifyContext) => string;
  /** ส่งอีเมลด้วยไหม (in-app สร้างเสมอ) */
  email: boolean;
  /** ข้อความปุ่ม CTA ในอีเมล (default: "ดูรายละเอียด") */
  ctaLabel?: string;
}

/** booking_service_type → ป้ายภาษาไทย (สำหรับแสดงในข้อความ/อีเมล) */
const SERVICE_LABEL: Record<booking_service_type, string> = {
  general_care: 'ดูแลทั่วไป',
  bedridden_care: 'ดูแลผู้ป่วยติดเตียง',
  physiotherapy: 'กายภาพบำบัด',
  medication: 'ดูแลเรื่องยา',
  companion: 'เพื่อนผู้สูงอายุ',
};

/**
 * Recipient matrix + เนื้อหา ของทุก event
 * (อ้างอิง Figma anatomy + ทิศทางการนำทางของ FE: booking_new/confirmed/cancelled → caregiver)
 */
const EVENT_CONFIG: Record<BookingEventType, EventConfig> = {
  [BOOKING_EVENTS.CREATED]: {
    type: NotificationType.booking_new,
    recipient: 'caregiver',
    title: 'มีคำขอจองใหม่',
    body: (c) => `มีคำขอจองใหม่ บริการ${c.serviceText} วันที่ ${c.dateText} — แตะเพื่อดูรายละเอียดและตอบรับ`,
    email: true,
    ctaLabel: 'ดูคำขอจอง',
  },
  [BOOKING_EVENTS.ACCEPTED]: {
    type: NotificationType.booking_accepted,
    recipient: 'patient',
    title: 'ผู้ดูแลรับคำขอแล้ว',
    body: (c) => `${c.caregiverName} รับคำขอจองของคุณแล้ว กรุณาชำระเงินเพื่อยืนยันการจอง`,
    email: true,
    ctaLabel: 'ชำระเงินเพื่อยืนยัน',
  },
  [BOOKING_EVENTS.DECLINED]: {
    type: NotificationType.booking_declined,
    recipient: 'patient',
    title: 'ผู้ดูแลปฏิเสธคำขอ',
    body: (c) =>
      `${c.caregiverName} ไม่สามารถรับงานนี้ได้${c.reason ? ` (เหตุผล: ${c.reason})` : ''} — ลองค้นหาผู้ดูแลท่านอื่น`,
    email: true,
    ctaLabel: 'ค้นหาผู้ดูแล',
  },
  [BOOKING_EVENTS.CONFIRMED]: {
    type: NotificationType.booking_confirmed,
    recipient: 'caregiver',
    title: 'การจองยืนยันแล้ว',
    body: (c) => `การจองบริการ${c.serviceText} วันที่ ${c.dateText} ได้รับการยืนยันและชำระเงินแล้ว`,
    email: true,
    ctaLabel: 'ดูรายละเอียดงาน',
  },
  [BOOKING_EVENTS.COMPLETED]: {
    type: NotificationType.booking_completed,
    recipient: 'patient',
    title: 'บริการเสร็จสิ้น',
    body: (c) => `บริการ${c.serviceText} เสร็จสมบูรณ์แล้ว ขอบคุณที่ใช้บริการ — อย่าลืมให้คะแนนผู้ดูแล`,
    email: true,
    ctaLabel: 'ให้คะแนนผู้ดูแล',
  },
  [BOOKING_EVENTS.CANCELLED]: {
    type: NotificationType.booking_cancelled,
    recipient: 'caregiver',
    title: 'การจองถูกยกเลิก',
    body: (c) => `การจองบริการ${c.serviceText} วันที่ ${c.dateText} ถูกยกเลิกโดยผู้ใช้บริการ`,
    email: true,
    ctaLabel: 'ดูรายละเอียด',
  },
  [BOOKING_EVENTS.PAYMENT_HELD]: {
    type: NotificationType.payment_held,
    recipient: 'patient',
    title: 'ชำระเงินเรียบร้อย',
    body: (c) => `เรากันวงเงิน ${c.amountText} สำหรับการจองของคุณแล้ว จะเรียกเก็บเมื่อบริการเสร็จสิ้น`,
    email: true,
    ctaLabel: 'ดูใบเสร็จ',
  },
  [BOOKING_EVENTS.PAYMENT_CAPTURED]: {
    type: NotificationType.payment_captured,
    recipient: 'caregiver',
    title: 'เรียกเก็บเงินแล้ว',
    body: (c) => `เรียกเก็บเงิน ${c.amountText} สำหรับงานที่เสร็จสิ้นเรียบร้อยแล้ว`,
    // อีเมลฝั่ง payout ของ caregiver ค่อยทำใน payout ticket — in-app พอสำหรับตอนนี้
    email: false,
  },
  [BOOKING_EVENTS.REFUND_ISSUED]: {
    type: NotificationType.refund_issued,
    recipient: 'patient',
    title: 'คืนเงินเรียบร้อย',
    body: (c) => `เราได้คืนเงิน ${c.amountText} กลับไปยังบัตรของคุณแล้ว`,
    email: true,
    ctaLabel: 'ดูรายละเอียด',
  },
  [BOOKING_EVENTS.DISPUTE_CREATED]: {
    type: NotificationType.dispute_created,
    recipient: 'admin',
    title: 'แจ้งปัญหาใหม่',
    body: (c) => `มีการแจ้งปัญหาใหม่สำหรับการจองบริการ${c.serviceText} วันที่ ${c.dateText}`,
    // แจ้ง admin ผ่าน in-app/แดชบอร์ดพอ — ยังไม่ทำ email ฝั่ง admin
    email: false,
  },
  [BOOKING_EVENTS.DISPUTE_RESOLVED]: {
    type: NotificationType.dispute_resolved,
    recipient: 'both',
    title: 'ผลตรวจสอบปัญหา',
    body: () => 'ผลการตรวจสอบปัญหาสำหรับการจองของคุณพร้อมแล้ว — แตะเพื่อดูรายละเอียด',
    email: true,
    ctaLabel: 'ดูผลการตรวจสอบ',
  },
};

@Injectable()
export class BookingNotificationListener {
  private readonly logger = new Logger(BookingNotificationListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationService: NotificationService,
    private readonly emailService: EmailService,
  ) {}

  // ── 1 handler รับทุก event (ดู eventType ใน payload เพื่อแยกพฤติกรรม) ──────
  // ใช้ @OnEvent ชื่อเต็มแบบเป๊ะ ๆ — เพิ่ม event ใหม่ต้องเพิ่ม decorator ที่นี่ด้วย
  @OnEvent(BOOKING_EVENTS.CREATED)
  @OnEvent(BOOKING_EVENTS.ACCEPTED)
  @OnEvent(BOOKING_EVENTS.DECLINED)
  @OnEvent(BOOKING_EVENTS.CONFIRMED)
  @OnEvent(BOOKING_EVENTS.COMPLETED)
  @OnEvent(BOOKING_EVENTS.CANCELLED)
  @OnEvent(BOOKING_EVENTS.PAYMENT_HELD)
  @OnEvent(BOOKING_EVENTS.PAYMENT_CAPTURED)
  @OnEvent(BOOKING_EVENTS.REFUND_ISSUED)
  @OnEvent(BOOKING_EVENTS.DISPUTE_CREATED)
  @OnEvent(BOOKING_EVENTS.DISPUTE_RESOLVED)
  async handleBookingEvent(event: BookingEvent): Promise<void> {
    try {
      const config = EVENT_CONFIG[event.eventType];
      if (!config) {
        this.logger.warn(`No config for event "${event.eventType}" — skipping`);
        return;
      }

      // โหลดรายละเอียด booking (ผู้ดูแล/วันที่/บริการ/ยอดเงิน) แบบสด ๆ
      const booking = await this.prisma.booking.findUnique({
        where: { id: event.bookingId },
        select: {
          patientId: true,
          serviceType: true,
          bookingDate: true,
          estimatedCost: true,
          caregiver: { select: { userId: true, fullName: true } },
          payment: { select: { amount: true } },
        },
      });

      if (!booking) {
        this.logger.warn(
          `Booking ${event.bookingId} not found — skipping ${event.eventType}`,
        );
        return;
      }

      const ctx: NotifyContext = {
        caregiverName: booking.caregiver?.fullName ?? 'ผู้ดูแล',
        serviceText: SERVICE_LABEL[booking.serviceType] ?? booking.serviceType,
        dateText: this.formatThaiDate(booking.bookingDate),
        amountText: this.formatBaht(booking.payment?.amount ?? booking.estimatedCost),
        reason:
          typeof event.metadata?.reason === 'string'
            ? event.metadata.reason
            : undefined,
      };

      const recipientIds = await this.resolveRecipientIds(config.recipient, {
        patientId: booking.patientId,
        caregiverUserId: booking.caregiver?.userId ?? null,
      });

      if (recipientIds.length === 0) {
        this.logger.log(
          `No recipient for ${event.eventType} (booking ${event.bookingId}) — skipping`,
        );
        return;
      }

      const title = config.title;
      const body = config.body(ctx);
      // link/source เก็บใน data (jsonb) — FE อ่าน data ได้ (ดู GET_NOTIFICATIONS)
      const data: Record<string, unknown> = {
        bookingId: event.bookingId,
        link: `/bookings/${event.bookingId}`,
        source: 'booking',
      };

      for (const userId of recipientIds) {
        // in-app (insert → Supabase realtime ดันให้ FE)
        await this.notificationService.create(userId, config.type, title, body, data);

        // email (ถ้า config เปิด) — EmailService เช็ค emailPreferences ให้เอง
        if (config.email) {
          await this.emailService.sendBookingNotification(userId, {
            heading: title,
            intro: body,
            caregiverName: ctx.caregiverName,
            dateText: ctx.dateText,
            serviceText: ctx.serviceText,
            amountText: ctx.amountText,
            ctaPath: data.link as string,
            ctaLabel: config.ctaLabel ?? 'ดูรายละเอียด',
          });
        }
      }

      this.logger.log(
        `Handled ${event.eventType} for booking ${event.bookingId} → ${recipientIds.length} recipient(s)`,
      );
    } catch (err) {
      // ห้าม throw — notification/email พัง ต้องไม่ทำให้ mutation ที่ยิง event ล่ม
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed handling ${event?.eventType} for booking ${event?.bookingId}: ${msg}`,
      );
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /** map recipient → รายชื่อ USER id ที่ต้องแจ้ง */
  private async resolveRecipientIds(
    recipient: Recipient,
    ids: { patientId: string; caregiverUserId: string | null },
  ): Promise<string[]> {
    switch (recipient) {
      case 'patient':
        return [ids.patientId];
      case 'caregiver':
        return ids.caregiverUserId ? [ids.caregiverUserId] : [];
      case 'both':
        return [ids.patientId, ...(ids.caregiverUserId ? [ids.caregiverUserId] : [])];
      case 'admin': {
        // role=3 = admin (ดู project_admin_role) — แจ้งแอดมินทุกคน
        const admins = await this.prisma.user.findMany({
          where: { role: 3 },
          select: { id: true },
        });
        return admins.map((a) => a.id);
      }
    }
  }

  /** Decimal | number | null → "฿1,234" (ไม่มีค่า → "-") */
  private formatBaht(value: Prisma.Decimal | number | null | undefined): string {
    if (value === null || value === undefined) return '-';
    const n =
      typeof (value as Prisma.Decimal).toNumber === 'function'
        ? (value as Prisma.Decimal).toNumber()
        : Number(value);
    return `฿${n.toLocaleString('th-TH', { maximumFractionDigits: 2 })}`;
  }

  /** Date → "15 ก.ค. 2569" (พ.ศ. = ค.ศ. + 543) */
  private formatThaiDate(date: Date): string {
    const months = [
      'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
      'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.',
    ];
    // ใช้ UTC เพราะ bookingDate เก็บเป็น @db.Date (ไม่มี timezone)
    const d = date.getUTCDate();
    const m = months[date.getUTCMonth()];
    const year = date.getUTCFullYear() + 543;
    return `${d} ${m} ${year}`;
  }
}
