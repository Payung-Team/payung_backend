/**
 * KYC Email Templates (PYG-96)
 *
 * 4 templates สำหรับ KYC lifecycle:
 * - kyc_submitted    → ส่งเอกสารยืนยันตัวตนสำเร็จ
 * - kyc_verified     → KYC ผ่าน 🎉
 * - kyc_rejected     → ไม่ผ่าน + เหตุผล
 * - kyc_resubmitted  → รับเอกสารใหม่แล้ว
 *
 * ทุก template return { subject, html, text } เพื่อให้ EmailService ส่งเข้า Resend ได้ตรงๆ
 *
 * input: ชื่อ user (สำหรับ greeting) + frontendUrl (สำหรับสร้าง CTA link)
 *        kyc_rejected พิเศษ — รับ reason ด้วย
 */
import {
  wrapHtml,
  plainTextFooter,
  escapeHtml,
  emailSubject,
  greetingHtml,
  greetingText,
} from './layout';

/** ผลลัพธ์ของแต่ละ template — match Resend API params (subject/html/text) */
export type EmailTemplate = {
  subject: string;
  html: string;
  text: string;
};

// ─── 1. KYC Submitted ────────────────────────────────────────────────────
// ส่งเมื่อ caregiver submit KYC สำเร็จ
export function kycSubmittedTemplate(
  displayName: string | null,
  frontendUrl: string,
): EmailTemplate {
  const subject = emailSubject('รับเอกสารยืนยันตัวตนแล้ว');

  const bodyHtml = `
    <p>${greetingHtml(displayName)}</p>
    <p>เราได้รับเอกสารยืนยันตัวตนของคุณเรียบร้อยแล้ว 🎯</p>
    <p>ทีมงานจะตรวจสอบและแจ้งผลภายใน <strong>1–2 วันทำการ</strong></p>
    <p>คุณสามารถติดตามสถานะได้ที่หน้าโปรไฟล์</p>
  `;

  const text = `${greetingText(displayName)}

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
  const subject = emailSubject('ยืนยันตัวตนสำเร็จ! 🎉 พร้อมรับงานได้เลย');

  const bodyHtml = `
    <p>${greetingHtml(displayName)}</p>
    <p><strong>ยินดีด้วย! 🎉</strong> เอกสารของคุณผ่านการตรวจสอบเรียบร้อยแล้ว</p>
    <p>ตอนนี้คุณสามารถ:</p>
    <ul style="line-height:1.8;">
      <li>เปิดรับงานจากผู้ใช้บริการ</li>
      <li>ตั้งวันและช่วงเวลาที่สะดวกรับงาน</li>
      <li>แก้ไขโปรไฟล์ให้ผู้ใช้บริการรู้จักคุณมากขึ้น</li>
    </ul>
    <p>เริ่มต้นรับงานแรกของคุณได้เลย!</p>
  `;

  const text = `${greetingText(displayName)}

ยินดีด้วย! เอกสารของคุณผ่านการตรวจสอบเรียบร้อยแล้ว
ตอนนี้คุณสามารถเปิดรับงานจากผู้ใช้บริการได้เลย

เปิดรับงาน: ${frontendUrl}/caregiver-home${plainTextFooter(frontendUrl)}`;

  return {
    subject,
    html: wrapHtml({
      bodyHtml,
      ctaUrl: `${frontendUrl}/caregiver-home`,
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
  const subject = emailSubject('เอกสารยืนยันตัวตนไม่ผ่าน');

  // reason มาจาก admin → escape ก่อนใส่ HTML กัน XSS
  const escapedReason = escapeHtml(reason);

  const bodyHtml = `
    <p>${greetingHtml(displayName)}</p>
    <p>เราต้องเสียใจที่จะแจ้งให้ทราบว่า เอกสารยืนยันตัวตนของคุณ <strong>ไม่ผ่านการตรวจสอบ</strong></p>

    <div style="background:#fff5f5; border-left:4px solid #e53935; padding:12px 16px; margin:16px 0;">
      <p style="margin:0; font-weight:600; color:#c62828;">เหตุผล:</p>
      <p style="margin:8px 0 0;">${escapedReason}</p>
    </div>

    <p>กรุณาแก้ไขและส่งเอกสารใหม่อีกครั้ง — ทีมงานจะตรวจสอบให้โดยเร็วที่สุด</p>
  `;

  const text = `${greetingText(displayName)}

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
  const subject = emailSubject('รับเอกสารใหม่แล้ว');

  const bodyHtml = `
    <p>${greetingHtml(displayName)}</p>
    <p>เราได้รับเอกสารยืนยันตัวตนชุดใหม่ของคุณแล้ว ✓</p>
    <p>ทีมงานจะตรวจสอบและแจ้งผลภายใน <strong>1–2 วันทำการ</strong></p>
    <p>ขอบคุณสำหรับความอดทนและความร่วมมือของคุณ</p>
  `;

  const text = `${greetingText(displayName)}

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
