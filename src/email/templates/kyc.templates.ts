/**
 * KYC Email Templates (PYG-96)
 *
 * 4 templates สำหรับ KYC lifecycle:
 * - kyc_submitted    → ส่งเอกสารยืนยันตัวตนสำเร็จ
 * - kyc_verified     → KYC ผ่าน 🎉
 * - kyc_rejected     → ไม่ผ่าน + เหตุผล
 * - kyc_resubmitted  → รับเอกสารใหม่แล้ว
 *
 * ทุก template return { subject, html, text } เพื่อให้ EmailService ส่งเข้า SMTP (nodemailer) ได้ตรงๆ
 *
 * input: ชื่อ user (สำหรับ greeting) + frontendUrl (สำหรับสร้าง CTA link)
 *        kyc_rejected พิเศษ — รับ reason ด้วย
 */
import { wrapHtml, plainTextFooter, escapeHtml } from './layout';

/** ผลลัพธ์ของแต่ละ template — match nodemailer sendMail params (subject/html/text) */
export type EmailTemplate = {
  subject: string;
  html: string;
  text: string;
};

/** Default greeting — ถ้า displayName ไม่มี (null) ใช้ "คุณผู้ใช้" แทน */
function greeting(name: string | null): string {
  return name ? `สวัสดีคุณ ${escapeHtml(name)}` : 'สวัสดีคุณผู้ใช้';
}

// ─── 1. KYC Submitted ────────────────────────────────────────────────────
// ส่งเมื่อ caregiver submit KYC สำเร็จ
export function kycSubmittedTemplate(
  displayName: string | null,
  frontendUrl: string,
): EmailTemplate {
  const subject = 'รับเอกสารยืนยันตัวตนแล้ว — Payung';

  const bodyHtml = `
    <p>${greeting(displayName)},</p>
    <p>เราได้รับเอกสารยืนยันตัวตนของคุณเรียบร้อยแล้ว 🎯</p>
    <p>ทีมงานจะตรวจสอบและแจ้งผลภายใน <strong>1–2 วันทำการ</strong></p>
    <p>คุณสามารถติดตามสถานะได้ที่หน้าโปรไฟล์</p>
  `;

  const text = `${greeting(displayName).replace(/<[^>]+>/g, '')},

เราได้รับเอกสารยืนยันตัวตนของคุณเรียบร้อยแล้ว
ทีมงานจะตรวจสอบและแจ้งผลภายใน 1-2 วันทำการ

ติดตามสถานะ: ${frontendUrl}/kyc${plainTextFooter(frontendUrl)}`;

  return {
    subject,
    html: wrapHtml({
      bodyHtml,
      ctaUrl: `${frontendUrl}/kyc`,
      ctaLabel: 'ดูสถานะการตรวจสอบ',
      frontendUrl,
    }),
    text,
  };
}

// ─── 2. KYC Verified ─────────────────────────────────────────────────────
// ส่งเมื่อ admin approve KYC
export function kycVerifiedTemplate(
  displayName: string | null,
  frontendUrl: string,
): EmailTemplate {
  const subject = 'ยืนยันตัวตนสำเร็จ! 🎉 พร้อมรับงานได้เลย — Payung';

  const bodyHtml = `
    <p>${greeting(displayName)},</p>
    <p><strong>ยินดีด้วย! 🎉</strong> เอกสารของคุณผ่านการตรวจสอบเรียบร้อยแล้ว</p>
    <p>ตอนนี้คุณสามารถ:</p>
    <ul style="line-height:1.8;">
      <li>เปิดรับงานจากผู้ใช้บริการ</li>
      <li>แก้ไขโปรไฟล์ให้น่าสนใจขึ้น</li>
      <li>กำหนดอัตราค่าบริการของคุณเอง</li>
    </ul>
    <p>เริ่มต้นรับงานแรกของคุณได้เลย!</p>
  `;

  const text = `${greeting(displayName).replace(/<[^>]+>/g, '')},

ยินดีด้วย! เอกสารของคุณผ่านการตรวจสอบเรียบร้อยแล้ว
ตอนนี้คุณสามารถเปิดรับงานจากผู้ใช้บริการได้เลย

เปิดรับงาน: ${frontendUrl}/dashboard${plainTextFooter(frontendUrl)}`;

  return {
    subject,
    html: wrapHtml({
      bodyHtml,
      ctaUrl: `${frontendUrl}/dashboard`,
      ctaLabel: 'เปิดรับงาน',
      frontendUrl,
    }),
    text,
  };
}

// ─── 3. KYC Rejected ─────────────────────────────────────────────────────
// ส่งเมื่อ admin reject KYC พร้อมเหตุผล
export function kycRejectedTemplate(
  displayName: string | null,
  reason: string,
  frontendUrl: string,
): EmailTemplate {
  const subject = 'เอกสารยืนยันตัวตนไม่ผ่าน — Payung';

  // reason มาจาก admin → escape ก่อนใส่ HTML กัน XSS
  const escapedReason = escapeHtml(reason);

  const bodyHtml = `
    <p>${greeting(displayName)},</p>
    <p>เราต้องเสียใจที่จะแจ้งให้ทราบว่า เอกสารยืนยันตัวตนของคุณ <strong>ไม่ผ่านการตรวจสอบ</strong></p>

    <div style="background:#fff5f5; border-left:4px solid #e53935; padding:12px 16px; margin:16px 0;">
      <p style="margin:0; font-weight:600; color:#c62828;">เหตุผล:</p>
      <p style="margin:8px 0 0;">${escapedReason}</p>
    </div>

    <p>กรุณาแก้ไขและส่งเอกสารใหม่อีกครั้ง — ทีมงานจะตรวจสอบให้โดยเร็วที่สุด</p>
  `;

  const text = `${greeting(displayName).replace(/<[^>]+>/g, '')},

เอกสารยืนยันตัวตนของคุณไม่ผ่านการตรวจสอบ

เหตุผล: ${reason}

กรุณาแก้ไขและส่งใหม่: ${frontendUrl}/kyc${plainTextFooter(frontendUrl)}`;

  return {
    subject,
    html: wrapHtml({
      bodyHtml,
      ctaUrl: `${frontendUrl}/kyc`,
      ctaLabel: 'แก้ไขเอกสาร',
      frontendUrl,
    }),
    text,
  };
}

// ─── 4. KYC Resubmitted ──────────────────────────────────────────────────
// ส่งเมื่อ caregiver submit KYC อีกครั้ง (หลังโดน reject)
export function kycResubmittedTemplate(
  displayName: string | null,
  frontendUrl: string,
): EmailTemplate {
  const subject = 'รับเอกสารใหม่แล้ว — Payung';

  const bodyHtml = `
    <p>${greeting(displayName)},</p>
    <p>เราได้รับเอกสารยืนยันตัวตนชุดใหม่ของคุณแล้ว ✓</p>
    <p>ทีมงานจะตรวจสอบและแจ้งผลภายใน <strong>1–2 วันทำการ</strong></p>
    <p>ขอบคุณสำหรับความอดทนและความร่วมมือของคุณ</p>
  `;

  const text = `${greeting(displayName).replace(/<[^>]+>/g, '')},

เราได้รับเอกสารยืนยันตัวตนชุดใหม่ของคุณแล้ว
ทีมงานจะตรวจสอบและแจ้งผลภายใน 1-2 วันทำการ

ติดตามสถานะ: ${frontendUrl}/kyc${plainTextFooter(frontendUrl)}`;

  return {
    subject,
    html: wrapHtml({
      bodyHtml,
      ctaUrl: `${frontendUrl}/kyc`,
      ctaLabel: 'ดูสถานะการตรวจสอบ',
      frontendUrl,
    }),
    text,
  };
}
