/**
 * EmailService — ส่ง email ผ่าน Gmail SMTP (nodemailer)
 *
 * Methods:
 * - sendKycSubmitted(userId)         — รับเอกสารแล้ว กำลังตรวจสอบ
 * - sendKycVerified(userId)          — KYC ผ่าน + CTA เปิดรับงาน
 * - sendKycRejected(userId, reason)  — KYC ไม่ผ่าน + เหตุผล
 * - sendKycResubmitted(userId)       — รับเอกสารใหม่แล้ว
 * - sendAdminInvite(...)             — เชิญ Admin ใหม่ + temp password
 * - sendAdminDeactivated(...)        — แจ้งบัญชีถูกระงับ
 * - sendAdminActivated(...)          — แจ้งบัญชีถูกเปิดใช้งานอีกครั้ง
 * - sendAdminScheduleDelete(...)     — แจ้งกำหนดลบบัญชีถาวร
 * - sendAdminCancelDelete(...)       — แจ้งยกเลิกการลบ
 * - sendAdminAutoDeleted(...)        — แจ้งลบบัญชีถาวรแล้ว (cron)
 *
 * Behaviors:
 * - ถ้า user.emailPreferences = false → skip + log (ไม่ throw)
 * - ถ้า SMTP error → log + ไม่ throw (email failure ไม่ควรทำให้ business flow พัง)
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { PrismaService } from '../common/prisma.service';
import {
  kycSubmittedTemplate,
  kycVerifiedTemplate,
  kycRejectedTemplate,
  kycResubmittedTemplate,
  type EmailTemplate,
} from './templates/kyc.templates';
import {
  adminInviteTemplate,
  adminDeactivatedTemplate,
  adminActivatedTemplate,
  adminAutoDeletedTemplate,
  adminScheduleDeleteTemplate,
  adminCancelDeleteTemplate,
  userAutoDeletedTemplate,
} from './templates/admin.templates';
import {
  bookingNotificationTemplate,
  type BookingEmailParams,
} from './templates/booking.templates';

/** ข้อมูล user ที่ EmailService ต้องการ — select เฉพาะที่ใช้ */
type EmailUser = {
  email: string;
  displayName: string | null;
  emailPreferences: boolean;
};

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly transporter: nodemailer.Transporter;
  private readonly fromAddress: string;
  private readonly frontendUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly prismaService: PrismaService,
  ) {
    this.fromAddress = this.configService.getOrThrow<string>('EMAIL_FROM');
    this.frontendUrl = this.configService.get<string>(
      'FRONTEND_URL',
      'https://payung.app',
    );

    this.transporter = nodemailer.createTransport({
      host: this.configService.getOrThrow<string>('SMTP_HOST'),
      port: this.configService.get<number>('SMTP_PORT', 587),
      secure: false, // TLS (port 587)
      auth: {
        user: this.configService.getOrThrow<string>('SMTP_USER'),
        pass: this.configService.getOrThrow<string>('SMTP_PASS'),
      },
    });
  }

  // ─── Public methods ───────────────────────────────────────────────────

  /** KYC submitted — รับเอกสารแล้ว กำลังตรวจสอบ */
  async sendKycSubmitted(userId: string): Promise<void> {
    const user = await this.fetchUser(userId);
    if (!user) return;
    const tpl = kycSubmittedTemplate(user.displayName, this.frontendUrl);
    await this.send(user.email, tpl);
  }

  /** KYC verified — ผ่านแล้ว เปิดรับงานได้ */
  async sendKycVerified(userId: string): Promise<void> {
    const user = await this.fetchUser(userId);
    if (!user) return;
    const tpl = kycVerifiedTemplate(user.displayName, this.frontendUrl);
    await this.send(user.email, tpl);
  }

  /** KYC rejected — ไม่ผ่าน + เหตุผลจาก admin */
  async sendKycRejected(userId: string, reason: string): Promise<void> {
    const user = await this.fetchUser(userId);
    if (!user) return;
    const tpl = kycRejectedTemplate(user.displayName, reason, this.frontendUrl);
    await this.send(user.email, tpl);
  }

  /** KYC resubmitted — รับเอกสารใหม่แล้ว */
  async sendKycResubmitted(userId: string): Promise<void> {
    const user = await this.fetchUser(userId);
    if (!user) return;
    const tpl = kycResubmittedTemplate(user.displayName, this.frontendUrl);
    await this.send(user.email, tpl);
  }

  /**
   * Admin invite — ส่ง email พร้อม temp password ให้ admin ใหม่
   * ไม่เช็ค emailPreferences — admin invite เป็น transactional email ที่ต้องส่งเสมอ
   */
  async sendAdminInvite(
    email: string,
    displayName: string | null,
    tempPassword: string,
  ): Promise<void> {
    const tpl = adminInviteTemplate(
      displayName,
      email,
      tempPassword,
      this.frontendUrl,
    );
    await this.send(email, tpl);
  }

  /** แจ้ง admin ว่าบัญชีถูกระงับ */
  async sendAdminDeactivated(
    email: string,
    displayName: string | null,
  ): Promise<void> {
    const tpl = adminDeactivatedTemplate(displayName, this.frontendUrl);
    await this.send(email, tpl);
  }

  /** แจ้ง admin ว่าบัญชีถูกเปิดใช้งานอีกครั้ง */
  async sendAdminActivated(
    email: string,
    displayName: string | null,
  ): Promise<void> {
    const tpl = adminActivatedTemplate(displayName, this.frontendUrl);
    await this.send(email, tpl);
  }

  /** แจ้ง admin ว่าบัญชีถูกกำหนดให้ลบถาวรพร้อมวันที่ */
  async sendAdminScheduleDelete(
    email: string,
    displayName: string | null,
    scheduledDeleteAt: Date,
    gracePeriodDays: number,
  ): Promise<void> {
    const tpl = adminScheduleDeleteTemplate(
      displayName,
      scheduledDeleteAt,
      gracePeriodDays,
      this.frontendUrl,
    );
    await this.send(email, tpl);
  }

  /** แจ้ง admin ว่าการกำหนดลบบัญชีถูกยกเลิก */
  async sendAdminCancelDelete(
    email: string,
    displayName: string | null,
  ): Promise<void> {
    const tpl = adminCancelDeleteTemplate(displayName, this.frontendUrl);
    await this.send(email, tpl);
  }

  /** แจ้ง admin ว่าบัญชีถูกลบถาวรแล้วโดย cron job (PYG-159) */
  async sendAdminAutoDeleted(
    email: string,
    displayName: string | null,
  ): Promise<void> {
    const tpl = adminAutoDeletedTemplate(displayName, this.frontendUrl);
    await this.send(email, tpl);
  }

  /** แจ้ง user/caregiver ว่าบัญชีถูกลบถาวรแล้วโดย cron job */
  async sendUserAutoDeleted(
    email: string,
    displayName: string | null,
  ): Promise<void> {
    const tpl = userAutoDeletedTemplate(displayName, this.frontendUrl);
    await this.send(email, tpl);
  }

  /**
   * Booking lifecycle email — generic template (fallback เท่านั้น)
   *
   * เรียกจาก BookingNotificationListener เมื่อ event ยังไม่มีใน BOOKING_EMAIL_TEMPLATES
   * - เช็ค emailPreferences ผ่าน fetchUser (ปิดรับ → ข้าม ไม่ throw)
   * - SMTP error ก็ไม่ throw (จัดการใน send) → ไม่ทำ business flow พัง
   *
   * @param userId  - ผู้รับ (USER id)
   * @param params  - เนื้อหา + รายละเอียด; ctaPath เป็น path ฝั่ง FE (service เติม frontendUrl ให้)
   */
  async sendBookingNotification(
    userId: string,
    params: Omit<BookingEmailParams, 'recipientName' | 'frontendUrl' | 'ctaUrl'> & {
      ctaPath?: string;
    },
  ): Promise<void> {
    const user = await this.fetchUser(userId);
    if (!user) return;

    const tpl = bookingNotificationTemplate({
      recipientName: user.displayName,
      frontendUrl: this.frontendUrl,
      heading: params.heading,
      intro: params.intro,
      caregiverName: params.caregiverName,
      dateText: params.dateText,
      serviceText: params.serviceText,
      amountText: params.amountText,
      ctaUrl: params.ctaPath ? `${this.frontendUrl}${params.ctaPath}` : undefined,
      ctaLabel: params.ctaLabel,
    });

    await this.send(user.email, tpl);
  }

  /**
   * Booking lifecycle email — รับ per-event template builder closure
   *
   * เปิดให้ listener เลือก template เอง (knows event/role) — EmailService
   * แค่จัดการ fetchUser + emailPreferences + SMTP เหมือนเดิม ไม่ bypass guardrail
   *
   * Build callback รับ {recipientName, frontendUrl} → return EmailTemplate
   * เพื่อให้ template render ภายใน scope ของ EmailService (FE base URL คุมที่นี่)
   */
  async sendBookingEmail(
    userId: string,
    build: (params: {
      recipientName: string | null;
      frontendUrl: string;
    }) => EmailTemplate,
  ): Promise<void> {
    const user = await this.fetchUser(userId);
    if (!user) return;
    const tpl = build({
      recipientName: user.displayName,
      frontendUrl: this.frontendUrl,
    });
    await this.send(user.email, tpl);
  }

  // ─── Private helpers ──────────────────────────────────────────────────

  private async fetchUser(userId: string): Promise<EmailUser | null> {
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
      select: { email: true, displayName: true, emailPreferences: true },
    });

    if (!user) {
      this.logger.warn(`User ${userId} not found — skipping email`);
      return null;
    }
    if (!user.emailPreferences) {
      this.logger.log(`User ${userId} opted out of email — skipping`);
      return null;
    }
    return user;
  }

  private async send(to: string, tpl: EmailTemplate): Promise<void> {
    try {
      const info = await this.transporter.sendMail({
        from: this.fromAddress,
        to,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
      });
      this.logger.log(
        `Email sent to ${to} (subject: "${tpl.subject}", messageId: ${info.messageId})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to send email to ${to}: ${msg}`);
    }
  }
}
