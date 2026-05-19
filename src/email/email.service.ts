/**
 * EmailService — ส่ง email ผ่าน Resend (PYG-96)
 *
 * Methods:
 * - sendKycSubmitted(userId)         — รับเอกสารแล้ว กำลังตรวจสอบ
 * - sendKycVerified(userId)          — KYC ผ่าน + CTA เปิดรับงาน
 * - sendKycRejected(userId, reason)  — KYC ไม่ผ่าน + เหตุผล
 * - sendKycResubmitted(userId)       — รับเอกสารใหม่แล้ว
 *
 * Behaviors:
 * - รับ userId เท่านั้น → service ดึง email + displayName + emailPreferences เอง
 *   (เหตุผล: caller ไม่ต้องห่วงเรื่อง preferences — service handle ให้)
 * - ถ้า user.emailPreferences = false → skip + log (ไม่ throw)
 * - ถ้า Resend error → log + ไม่ throw (email failure ไม่ควรทำให้ business flow พัง)
 *   หลัก: caller (เช่น KycService) ทำงานต่อได้แม้ email ส่งไม่ได้
 *
 * Future improvements (out of scope MVP):
 * - Queue + retry (BullMQ / Redis)
 * - Batch sending
 * - Template precompile + caching
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
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
} from './templates/admin.templates';

/** ข้อมูล user ที่ EmailService ต้องการ — select เฉพาะที่ใช้ */
type EmailUser = {
  email: string;
  displayName: string | null;
  emailPreferences: boolean;
};

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly resend: Resend;
  private readonly fromAddress: string;
  private readonly frontendUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly prismaService: PrismaService,
  ) {
    // getOrThrow → ถ้า env ไม่มีจะ throw ตอน app boot (fail fast — ดีกว่า silent)
    const apiKey = this.configService.getOrThrow<string>('RESEND_API_KEY');
    this.fromAddress = this.configService.getOrThrow<string>('EMAIL_FROM');

    // FRONTEND_URL ใช้สำหรับสร้าง CTA link + unsubscribe link ใน email
    // default = production domain (ทีมเปลี่ยนได้ใน .env)
    this.frontendUrl = this.configService.get<string>(
      'FRONTEND_URL',
      'https://payung.app',
    );

    this.resend = new Resend(apiKey);
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
   *
   * ต่างจาก KYC emails ตรงที่รับ email โดยตรง (ไม่ผ่าน userId)
   * เพราะต้องส่งก่อนที่ admin จะ login ครั้งแรก และไม่เช็ค emailPreferences
   * (admin invite เป็น transactional email ที่ต้องส่งเสมอ)
   */
  async sendAdminInvite(
    email: string,
    displayName: string | null,
    tempPassword: string,
  ): Promise<void> {
    const tpl = adminInviteTemplate(displayName, email, tempPassword, this.frontendUrl);
    await this.send(email, tpl);
  }

  /** แจ้ง admin ว่าบัญชีถูกระงับ */
  async sendAdminDeactivated(email: string, displayName: string | null): Promise<void> {
    const tpl = adminDeactivatedTemplate(displayName, this.frontendUrl);
    await this.send(email, tpl);
  }

  /** แจ้ง admin ว่าบัญชีถูกเปิดใช้งานอีกครั้ง */
  async sendAdminActivated(email: string, displayName: string | null): Promise<void> {
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
    const tpl = adminScheduleDeleteTemplate(displayName, scheduledDeleteAt, gracePeriodDays, this.frontendUrl);
    await this.send(email, tpl);
  }

  /** แจ้ง admin ว่าการกำหนดลบบัญชีถูกยกเลิก */
  async sendAdminCancelDelete(email: string, displayName: string | null): Promise<void> {
    const tpl = adminCancelDeleteTemplate(displayName, this.frontendUrl);
    await this.send(email, tpl);
  }

  /** แจ้ง admin ว่าบัญชีถูกลบถาวรแล้วโดย cron job (PYG-159) */
  async sendAdminAutoDeleted(email: string, displayName: string | null): Promise<void> {
    const tpl = adminAutoDeletedTemplate(displayName, this.frontendUrl);
    await this.send(email, tpl);
  }

  // ─── Private helpers ──────────────────────────────────────────────────

  /**
   * ดึงข้อมูล user ที่จำเป็นสำหรับส่ง email
   *
   * return null ถ้า:
   * - user ไม่พบ (อาจถูกลบ)
   * - user.emailPreferences = false (opt out)
   *
   * ทั้ง 2 case ไม่ throw — แค่ skip + log เพื่อให้ flow ปลายทางทำงานต่อได้
   */
  private async fetchUser(userId: string): Promise<EmailUser | null> {
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        displayName: true,
        emailPreferences: true,
      },
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

  /**
   * ส่ง email ผ่าน Resend
   *
   * ดักทุก error → log เท่านั้น ไม่ throw
   * เพราะ caller (เช่น KycService.submitKyc) ไม่ควรพังเพราะ email service ล่ม
   */
  private async send(to: string, tpl: EmailTemplate): Promise<void> {
    try {
      const { data, error } = await this.resend.emails.send({
        from: this.fromAddress,
        to,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
      });

      if (error) {
        // Resend SDK return { data, error } แทน throw — ต้อง check เอง
        this.logger.error(
          `Resend API error sending to ${to}: ${error.message}`,
        );
        return;
      }

      this.logger.log(
        `Email sent to ${to} (subject: "${tpl.subject}", id: ${data?.id ?? 'n/a'})`,
      );
    } catch (err) {
      // network error / SDK exception
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to send email to ${to}: ${msg}`);
    }
  }
}
