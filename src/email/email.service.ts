/**
 * EmailService — ส่ง email ผ่าน Resend HTTP API (PYG-714)
 *
 * ★ PYG-714: เดิมส่งผ่าน Gmail SMTP (nodemailer) ซึ่งบน Cloudflare Worker ส่งไม่ออก → ผู้ใช้ไม่ได้อีเมลเลย
 *   ตอนนี้ POST https://api.resend.com/emails ด้วย fetch ตรง ๆ (ไม่ใช้ SDK `resend` — SDK import
 *   React Email แบบ dynamic ซึ่งเสี่ยงต่อ bundle ของ Worker · API มีแค่ endpoint เดียวที่เราใช้)
 * ★ ทุกฉบับบันทึกลงตาราง email_logs (sent / failed / skipped + เหตุผล + id ของ Resend)
 *   ทีมตอบได้ว่า "ทำไมคนนี้ไม่ได้อีเมล" จาก DB โดยไม่ต้องค้น log ของ Worker
 *
 * Config (ไม่ตั้ง = แอปยังขึ้นได้ · ทุกฉบับบันทึกเป็น failed reason not_configured):
 *   RESEND_API_KEY   — secret ของ Worker
 *   EMAIL_FROM       — เช่น "Payung <noreply@payung-care.com>" (โดเมนต้องยืนยันใน Resend แล้ว)
 *   RESEND_BASE_URL  — ไม่ต้องตั้ง (ใช้ตอนเทสต์ชี้ไป server ปลอม)
 *   ลิงก์ในอีเมล: APP_PUBLIC_BASE_URL → ถ้าไม่มี ใช้ค่าแรกของ FRONTEND_URL (ดู resolveEmailLinkBaseUrl)
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
 * - sendMarketingEmail(userId, tpl)  — อีเมลข่าวสาร/โปรโมชัน (PYG-540 — ต้องยินยอม marketing)
 *
 * Behaviors:
 * - ถ้า user.emailPreferences = false → skip + log (ไม่ throw)
 * - ถ้าส่งไม่สำเร็จ → log + บันทึก failed + ไม่ throw (email failure ไม่ควรทำให้ business flow พัง)
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma.service';
import { ConsentService } from '../consent/consent.service';
import { CONSENT_TYPE } from '../consent/consent.constants';
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
import { maskEmail } from '../common/utils/mask-email';
import { escapeHtml } from './templates/layout';

/** ชื่อ template ที่บันทึกใน email_logs.template (booking ใช้ชื่อ event เช่น 'booking.confirmed') */
export const EMAIL_TEMPLATE_KEYS = {
  KYC_SUBMITTED: 'kyc_submitted',
  KYC_VERIFIED: 'kyc_verified',
  KYC_REJECTED: 'kyc_rejected',
  KYC_RESUBMITTED: 'kyc_resubmitted',
  ADMIN_INVITE: 'admin_invite',
  ADMIN_DEACTIVATED: 'admin_deactivated',
  ADMIN_ACTIVATED: 'admin_activated',
  ADMIN_SCHEDULE_DELETE: 'admin_schedule_delete',
  ADMIN_CANCEL_DELETE: 'admin_cancel_delete',
  ADMIN_AUTO_DELETED: 'admin_auto_deleted',
  USER_AUTO_DELETED: 'user_auto_deleted',
  ADMIN_ALERT: 'admin_alert',
  MARKETING: 'marketing',
} as const;

/** ผู้ให้บริการที่บันทึกใน email_logs.provider */
const PROVIDER = 'resend';
const RESEND_DEFAULT_BASE_URL = 'https://api.resend.com';
/** Resend ตอบช้ากว่านี้ = ถือว่าล้ม (ไม่ให้ request ของผู้ใช้ค้างเพราะอีเมล) */
const SEND_TIMEOUT_MS = 10_000;
const MAX_REASON_LENGTH = 1000;

type EmailLogStatus = 'sent' | 'failed' | 'skipped';

/** ใครเป็นผู้รับ / template อะไร — ใช้บันทึก email_logs */
type SendMeta = { template: string; userId?: string | null };

/**
 * base URL ของลิงก์ในอีเมล
 *
 * PYG-714: เดิมใช้ FRONTEND_URL ตรง ๆ แต่บน Worker ค่านั้นคือ
 *   "https://payung-care.com,https://www.payung-care.com" (รายการ origin สำหรับ CORS)
 *   → ทุกลิงก์ในอีเมลกลายเป็น "https://payung-care.com,https://www.payung-care.com/kyc" เปิดไม่ได้
 *   ตอนนี้ใช้ APP_PUBLIC_BASE_URL (URL สาธารณะของเว็บ — ลิงก์เชิญกลุ่มครอบครัวใช้ค่าเดียวกัน)
 *   ไม่มีค่อยใช้ origin แรกของ FRONTEND_URL
 */
export function resolveEmailLinkBaseUrl(
  appPublicBaseUrl: string | undefined,
  frontendUrl: string | undefined,
): string {
  const candidate =
    appPublicBaseUrl?.trim() ||
    frontendUrl
      ?.split(',')
      .map((origin) => origin.trim())
      .find(Boolean) ||
    'https://payung-care.com';
  return candidate.replace(/\/+$/, '');
}

/** ข้อมูล user ที่ EmailService ต้องการ — select เฉพาะที่ใช้ */
type EmailUser = {
  email: string;
  displayName: string | null;
  emailPreferences: boolean;
};

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly fromAddress: string | undefined;
  private readonly resendApiKey: string | undefined;
  private readonly resendBaseUrl: string;
  private readonly frontendUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly prismaService: PrismaService,
    // PYG-540: เช็คความยินยอม marketing ก่อนส่งอีเมลข่าวสารทุกฉบับ
    private readonly consentService: ConsentService,
  ) {
    this.fromAddress =
      this.configService.get<string>('EMAIL_FROM')?.trim() || undefined;
    this.resendApiKey =
      this.configService.get<string>('RESEND_API_KEY')?.trim() || undefined;
    this.resendBaseUrl = (
      this.configService.get<string>('RESEND_BASE_URL')?.trim() ||
      RESEND_DEFAULT_BASE_URL
    ).replace(/\/+$/, '');
    this.frontendUrl = resolveEmailLinkBaseUrl(
      this.configService.get<string>('APP_PUBLIC_BASE_URL'),
      this.configService.get<string>('FRONTEND_URL'),
    );

    // ไม่ throw ตอนขึ้นแอป — API ต้องทำงานได้แม้ยังไม่ได้ตั้ง Resend (ทุกฉบับจะถูกบันทึกเป็น failed)
    if (!this.isConfigured()) {
      this.logger.error({
        event: 'email.not_configured',
        missing: this.missingConfig(),
      });
    }
  }

  // ─── Public methods ───────────────────────────────────────────────────

  /** KYC submitted — รับเอกสารแล้ว กำลังตรวจสอบ */
  async sendKycSubmitted(userId: string): Promise<void> {
    const user = await this.fetchUser(
      userId,
      EMAIL_TEMPLATE_KEYS.KYC_SUBMITTED,
    );
    if (!user) return;
    const tpl = kycSubmittedTemplate(user.displayName, this.frontendUrl);
    await this.send(user.email, tpl, {
      template: EMAIL_TEMPLATE_KEYS.KYC_SUBMITTED,
      userId,
    });
  }

  /** KYC verified — ผ่านแล้ว เปิดรับงานได้ */
  async sendKycVerified(userId: string): Promise<void> {
    const user = await this.fetchUser(userId, EMAIL_TEMPLATE_KEYS.KYC_VERIFIED);
    if (!user) return;
    const tpl = kycVerifiedTemplate(user.displayName, this.frontendUrl);
    await this.send(user.email, tpl, {
      template: EMAIL_TEMPLATE_KEYS.KYC_VERIFIED,
      userId,
    });
  }

  /** KYC rejected — ไม่ผ่าน + เหตุผลจาก admin */
  async sendKycRejected(userId: string, reason: string): Promise<void> {
    const user = await this.fetchUser(userId, EMAIL_TEMPLATE_KEYS.KYC_REJECTED);
    if (!user) return;
    const tpl = kycRejectedTemplate(user.displayName, reason, this.frontendUrl);
    await this.send(user.email, tpl, {
      template: EMAIL_TEMPLATE_KEYS.KYC_REJECTED,
      userId,
    });
  }

  /** KYC resubmitted — รับเอกสารใหม่แล้ว */
  async sendKycResubmitted(userId: string): Promise<void> {
    const user = await this.fetchUser(
      userId,
      EMAIL_TEMPLATE_KEYS.KYC_RESUBMITTED,
    );
    if (!user) return;
    const tpl = kycResubmittedTemplate(user.displayName, this.frontendUrl);
    await this.send(user.email, tpl, {
      template: EMAIL_TEMPLATE_KEYS.KYC_RESUBMITTED,
      userId,
    });
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
    await this.send(email, tpl, { template: EMAIL_TEMPLATE_KEYS.ADMIN_INVITE });
  }

  /** แจ้ง admin ว่าบัญชีถูกระงับ */
  async sendAdminDeactivated(
    email: string,
    displayName: string | null,
  ): Promise<void> {
    const tpl = adminDeactivatedTemplate(displayName, this.frontendUrl);
    await this.send(email, tpl, {
      template: EMAIL_TEMPLATE_KEYS.ADMIN_DEACTIVATED,
    });
  }

  /** แจ้ง admin ว่าบัญชีถูกเปิดใช้งานอีกครั้ง */
  async sendAdminActivated(
    email: string,
    displayName: string | null,
  ): Promise<void> {
    const tpl = adminActivatedTemplate(displayName, this.frontendUrl);
    await this.send(email, tpl, {
      template: EMAIL_TEMPLATE_KEYS.ADMIN_ACTIVATED,
    });
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
    await this.send(email, tpl, {
      template: EMAIL_TEMPLATE_KEYS.ADMIN_SCHEDULE_DELETE,
    });
  }

  /** แจ้ง admin ว่าการกำหนดลบบัญชีถูกยกเลิก */
  async sendAdminCancelDelete(
    email: string,
    displayName: string | null,
  ): Promise<void> {
    const tpl = adminCancelDeleteTemplate(displayName, this.frontendUrl);
    await this.send(email, tpl, {
      template: EMAIL_TEMPLATE_KEYS.ADMIN_CANCEL_DELETE,
    });
  }

  /** แจ้ง admin ว่าบัญชีถูกลบถาวรแล้วโดย cron job (PYG-159) */
  async sendAdminAutoDeleted(
    email: string,
    displayName: string | null,
  ): Promise<void> {
    const tpl = adminAutoDeletedTemplate(displayName, this.frontendUrl);
    await this.send(email, tpl, {
      template: EMAIL_TEMPLATE_KEYS.ADMIN_AUTO_DELETED,
    });
  }

  /** แจ้ง user/caregiver ว่าบัญชีถูกลบถาวรแล้วโดย cron job */
  async sendUserAutoDeleted(
    email: string,
    displayName: string | null,
  ): Promise<void> {
    const tpl = userAutoDeletedTemplate(displayName, this.frontendUrl);
    await this.send(email, tpl, {
      template: EMAIL_TEMPLATE_KEYS.USER_AUTO_DELETED,
    });
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
    params: Omit<
      BookingEmailParams,
      'recipientName' | 'frontendUrl' | 'ctaUrl'
    > & {
      ctaPath?: string;
      /** ชื่อ event (เช่น 'payment.transferred') — บันทึกเป็น email_logs.template */
      template: string;
    },
  ): Promise<void> {
    const user = await this.fetchUser(userId, params.template);
    if (!user) return;

    const tpl = bookingNotificationTemplate({
      recipientName: user.displayName,
      frontendUrl: this.frontendUrl,
      heading: params.heading,
      intro: params.intro,
      caregiverName: params.caregiverName,
      dateText: params.dateText,
      timeText: params.timeText, // PYG-526: แถว "เวลา" แบบ "09:00 – 13:00 (4 ชม.)"
      serviceText: params.serviceText,
      amountText: params.amountText,
      ctaUrl: params.ctaPath
        ? `${this.frontendUrl}${params.ctaPath}`
        : undefined,
      ctaLabel: params.ctaLabel,
    });

    await this.send(user.email, tpl, { template: params.template, userId });
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
    /** ชื่อ event (เช่น 'booking.confirmed') — บันทึกเป็น email_logs.template */
    template: string,
  ): Promise<void> {
    const user = await this.fetchUser(userId, template);
    if (!user) return;
    const tpl = build({
      recipientName: user.displayName,
      frontendUrl: this.frontendUrl,
    });
    await this.send(user.email, tpl, { template, userId });
  }

  /**
   * อีเมลข่าวสาร / โปรโมชัน — ทางเดียวที่ใช้ส่งอีเมลการตลาด (PYG-540)
   *
   * ★ ทำไมต้องมีทางเดียว: ถ้าแต่ละฟีเจอร์ส่งเองผ่าน sendBookingEmail / send ตรง ๆ
   *   จะมีสักวันที่ลืมเช็คความยินยอม — รวมไว้ที่เดียวแล้วทุกฉบับผ่านด่านเดียวกันแน่นอน
   *
   * ด่านที่ต้องผ่านทั้งหมด (ไม่ผ่านข้อใด = ไม่ส่ง + log `email.marketing_skipped`):
   *   1. มีผู้ใช้จริง · ยังไม่ถูกลบ · บัญชียังใช้งานอยู่
   *   2. emailPreferences = true (สวิตช์รับอีเมลเดิมของระบบ)
   *   3. ความยินยอม marketing แถวล่าสุด = ยินยอม และเป็นนโยบายเวอร์ชันปัจจุบัน
   *
   * ★ ข้อ 3 เข้มกว่าด่านจอง (ที่ "ไม่เคยตอบ = ผ่าน"): marketing เป็นความยินยอมแบบ
   *   "เลือกเข้าร่วม" — ไม่เคยตอบ / ถอน / ยินยอมนโยบายเก่า = ห้ามส่ง
   *
   * ★ ไม่ throw เลย (รวมถึงตอนอ่าน DB พัง) — ผู้เรียกส่งเป็นชุด ฉบับหนึ่งพังต้องไม่ทำให้ทั้งชุดหยุด
   *
   * @returns true = ส่งแล้ว (ส่งเข้า SMTP สำเร็จหรือพังตอน SMTP ก็ตาม) · false = ข้ามเพราะไม่ผ่านด่าน
   */
  async sendMarketingEmail(
    userId: string,
    tpl: EmailTemplate,
  ): Promise<boolean> {
    // ★ log แค่ userId + เหตุผล — ไม่ log อีเมล (ข้อมูลส่วนบุคคล)
    const skip = async (reason: string): Promise<false> => {
      this.logger.log({ event: 'email.marketing_skipped', userId, reason });
      await this.record({
        template: EMAIL_TEMPLATE_KEYS.MARKETING,
        userId: reason === 'user_not_found' ? null : userId,
        status: 'skipped',
        reason,
        subject: tpl.subject,
      });
      return false;
    };

    try {
      const user = await this.prismaService.user.findUnique({
        where: { id: userId },
        select: {
          email: true,
          emailPreferences: true,
          isActive: true,
          deleted_at: true,
        },
      });

      if (!user) return skip('user_not_found');
      // PYG-603: บัญชีที่สมัครด้วยเบอร์โทรไม่มีอีเมล — ไม่มีที่ให้ส่ง ข้ามแบบเดียวกับไม่รับอีเมล
      if (!user.email) return skip('no_email');
      if (user.deleted_at || !user.isActive) return skip('inactive');
      if (!user.emailPreferences) return skip('email_opt_out');

      const consented = await this.consentService.hasGrantedCurrent(
        userId,
        CONSENT_TYPE.MARKETING,
      );
      if (!consented) return skip('no_marketing_consent');

      await this.send(user.email, tpl, {
        template: EMAIL_TEMPLATE_KEYS.MARKETING,
        userId,
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({
        event: 'email.marketing_failed',
        userId,
        error: msg,
      });
      return false;
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────

  private async fetchUser(
    userId: string,
    template: string,
  ): Promise<EmailUser | null> {
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
      select: { email: true, displayName: true, emailPreferences: true },
    });

    if (!user) {
      this.logger.warn(`User ${userId} not found — skipping email`);
      // user_id ไม่มีจริง → บันทึกเป็น NULL (ใส่ id ที่ไม่มีอยู่จะชน foreign key)
      await this.record({
        template,
        userId: null,
        status: 'skipped',
        reason: 'user_not_found',
      });
      return null;
    }
    // PYG-603 (E13): บัญชีที่สมัครด้วยเบอร์โทรไม่มีอีเมล → ข้าม ไม่ throw
    //   ผู้ใช้ยังได้แจ้งเตือนในแอป (in-app notification) ตามปกติ — ปิดเฉพาะช่องทางอีเมล
    //   การส่งทาง SMS แทนไม่อยู่ในขอบเขตของ PYG-603 (รอผลเคาะของ story PYG-562)
    if (!user.email) {
      this.logger.log({ event: 'email.skipped', userId, reason: 'no_email' });
      await this.record({
        template,
        userId,
        status: 'skipped',
        reason: 'no_email',
      });
      return null;
    }
    if (!user.emailPreferences) {
      this.logger.log(`User ${userId} opted out of email — skipping`);
      await this.record({
        template,
        userId,
        recipient: user.email,
        status: 'skipped',
        reason: 'email_opt_out',
      });
      return null;
    }
    // สร้าง object ใหม่ให้ TypeScript รู้ว่า email เป็น string แน่นอนหลังผ่านการตรวจข้างบน
    return { ...user, email: user.email };
  }

  private isConfigured(): boolean {
    return this.missingConfig().length === 0;
  }

  private missingConfig(): string[] {
    return [
      ...(this.resendApiKey ? [] : ['RESEND_API_KEY']),
      ...(this.fromAddress ? [] : ['EMAIL_FROM']),
    ];
  }

  /**
   * ส่งผ่าน Resend + บันทึก email_logs — ไม่ throw ทุกกรณี
   * (อีเมลพังต้องไม่ทำให้ mutation / cron ที่เรียกล่ม)
   */
  private async send(
    to: string | string[],
    tpl: EmailTemplate,
    meta: SendMeta,
  ): Promise<void> {
    const recipients = Array.isArray(to) ? to : [to];
    const masked = recipients.map((r) => maskEmail(r)).join(', ');
    const base = {
      template: meta.template,
      userId: meta.userId ?? null,
      recipient: recipients.join(', '),
      subject: tpl.subject,
    };

    if (!this.isConfigured()) {
      const reason = `not_configured: ${this.missingConfig().join(', ')}`;
      this.logger.error(
        `Email not sent to ${masked} (${meta.template}): ${reason}`,
      );
      await this.record({ ...base, status: 'failed', reason });
      return;
    }

    try {
      const res = await fetch(`${this.resendBaseUrl}/emails`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.fromAddress,
          to: recipients,
          subject: tpl.subject,
          html: tpl.html,
          text: tpl.text,
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      const body = (await res.json().catch(() => null)) as {
        id?: string;
        name?: string;
        message?: string;
      } | null;

      if (!res.ok || !body?.id) {
        // Resend ตอบ { statusCode, name, message } เช่น 403 validation_error "domain is not verified"
        const reason = `resend ${res.status}${body?.name ? ` ${body.name}` : ''}: ${body?.message ?? 'no message id in response'}`;
        this.logger.error(
          `Failed to send email to ${masked} (${meta.template}): ${reason}`,
        );
        await this.record({ ...base, status: 'failed', reason });
        return;
      }

      this.logger.log(
        `Email sent to ${masked} (${meta.template}, subject: "${tpl.subject}", id: ${body.id})`,
      );
      await this.record({
        ...base,
        status: 'sent',
        providerMessageId: body.id,
      });
    } catch (err) {
      // network / timeout (AbortSignal) / DNS
      const msg =
        err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      this.logger.error(
        `Failed to send email to ${masked} (${meta.template}): ${msg}`,
      );
      await this.record({ ...base, status: 'failed', reason: msg });
    }
  }

  /**
   * บันทึก email_logs — พังเองก็ไม่ throw (ประวัติหาย ดีกว่าอีเมลหรือ flow หลักพัง)
   * ★ เก็บแค่อีเมลแบบปิดบางส่วน ไม่เก็บเนื้อหา (อีเมลเชิญแอดมินมีรหัสผ่านชั่วคราว)
   */
  private async record(row: {
    template: string;
    userId: string | null;
    status: EmailLogStatus;
    recipient?: string;
    subject?: string;
    reason?: string;
    providerMessageId?: string;
  }): Promise<void> {
    try {
      await this.prismaService.email_logs.create({
        data: {
          user_id: row.userId,
          recipient_masked: row.recipient
            ? row.recipient
                .split(',')
                .map((r) => maskEmail(r.trim()))
                .join(', ')
                .slice(0, 320)
            : null,
          template: row.template.slice(0, 64),
          subject: row.subject ?? null,
          status: row.status,
          reason: row.reason?.slice(0, MAX_REASON_LENGTH) ?? null,
          provider: row.status === 'skipped' ? null : PROVIDER,
          provider_message_id: row.providerMessageId ?? null,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn({
        event: 'email.log_write_failed',
        template: row.template,
        error: msg,
      });
    }
  }

  /**
   * PYG-376 — plain operational alert to admins (reconciliation, etc.).
   * Reuses the same sender as every other mail; text-only is fine for internal alerts.
   */
  async sendAdminAlert(
    recipients: string[],
    subject: string,
    textBody: string,
  ): Promise<void> {
    if (recipients.length === 0) {
      this.logger.warn(
        `No admin recipients for alert "${subject}" — skipping send`,
      );
      return;
    }
    await this.send(
      recipients,
      {
        subject,
        text: textBody,
        // PYG-714: escape — เนื้อหา alert มาจากข้อมูลในระบบ (เดิมใส่ลง HTML ตรง ๆ)
        html: `<pre style="font-family:monospace;white-space:pre-wrap">${escapeHtml(textBody)}</pre>`,
      },
      { template: EMAIL_TEMPLATE_KEYS.ADMIN_ALERT },
    );
  }
}
