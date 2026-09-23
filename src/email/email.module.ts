/**
 * EmailModule — Module สำหรับส่ง email ผ่าน SMTP (nodemailer) (PYG-96)
 *
 * ทำไม export EmailService?
 * - service อื่น (เช่น KycService, future AdminService) ต้องเรียก
 *   sendKycSubmitted/Verified/Rejected/Resubmitted ได้
 * - export ทำให้ module อื่นที่ import EmailModule → inject EmailService ได้
 *
 * PYG-540: import ConsentModule เพื่อให้ EmailService ใช้ ConsentService ได้
 * - sendMarketingEmail ต้องเช็คความยินยอม "marketing" ล่าสุดก่อนส่งทุกฉบับ
 * - ★ ไม่เกิด import วน: ConsentModule import แค่ CommonModule (@Global)
 *   และไม่ได้ import EmailModule กลับมา
 *
 * ENV ที่ต้องตั้ง (อ่านใน EmailService constructor):
 * - SMTP_HOST, SMTP_USER, SMTP_PASS = ค่าเชื่อมต่อ SMTP (SMTP_PORT ไม่ตั้ง = 587)
 * - EMAIL_FROM      = sender address เช่น 'Payung <noreply@payung.app>'
 * - FRONTEND_URL    = (optional) base URL สำหรับสร้าง CTA link, default 'https://payung.app'
 */
import { Module } from '@nestjs/common';
import { ConsentModule } from '../consent/consent.module';
import { EmailService } from './email.service';

@Module({
  imports: [ConsentModule], // PYG-540: ให้ inject ConsentService ได้
  providers: [EmailService],
  exports: [EmailService], // ให้ module อื่น inject ได้
})
export class EmailModule {}
