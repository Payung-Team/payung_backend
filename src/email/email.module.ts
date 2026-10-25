/**
 * EmailModule — Module สำหรับส่ง email ผ่าน Resend HTTP API (PYG-96 · PYG-714 เลิกใช้ SMTP)
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
 * ENV (อ่านใน EmailService constructor — ไม่ตั้งแอปยังขึ้นได้ แต่ทุกฉบับถูกบันทึกเป็น failed not_configured):
 * - RESEND_API_KEY      = API key ของ Resend (secret)
 * - EMAIL_FROM          = ผู้ส่ง เช่น 'Payung <noreply@payung-care.com>' — โดเมนต้องยืนยันใน Resend แล้ว
 * - APP_PUBLIC_BASE_URL = base URL ของลิงก์ในอีเมล (ไม่ตั้ง = origin แรกของ FRONTEND_URL)
 * - SMTP_* ไม่ใช้แล้ว (PYG-714)
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
