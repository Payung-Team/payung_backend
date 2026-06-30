/**
 * EmailModule — Module สำหรับส่ง email ผ่าน SMTP (nodemailer) (PYG-96)
 *
 * ทำไม export EmailService?
 * - service อื่น (เช่น KycService, future AdminService) ต้องเรียก
 *   sendKycSubmitted/Verified/Rejected/Resubmitted ได้
 * - export ทำให้ module อื่นที่ import EmailModule → inject EmailService ได้
 *
 * ENV ที่ต้องตั้ง:
 * - SMTP_HOST       = SMTP server host (e.g. smtp.gmail.com)
 * - SMTP_PORT       = SMTP port (default 587 — TLS)
 * - SMTP_USER       = SMTP auth username
 * - SMTP_PASS       = SMTP auth password (Gmail: app password)
 * - EMAIL_FROM      = sender address เช่น 'Payung <noreply@payung.app>'
 * - FRONTEND_URL    = (optional) base URL สำหรับสร้าง CTA link, default 'https://payung.app'
 */
import { Module } from '@nestjs/common';
import { EmailService } from './email.service';

@Module({
  providers: [EmailService],
  exports: [EmailService],  // ให้ module อื่น inject ได้
})
export class EmailModule {}
