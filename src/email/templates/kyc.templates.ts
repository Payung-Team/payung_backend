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
  titleBlock,
  stepList,
  issueCard,
  BRAND,
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
    ${titleBlock(
      'เราได้รับเอกสารของคุณแล้ว',
      `${greetingHtml(displayName)} ทีมงานกำลังตรวจสอบเอกสารยืนยันตัวตนของคุณ โดยปกติใช้เวลา <strong>1–2 วันทำการ</strong> เราจะแจ้งผลทางอีเมล`,
    )}
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
      badge: { label: 'กำลังตรวจสอบ', tone: 'info' },
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
    ${titleBlock(
      'ยินดีด้วย คุณพร้อมรับงานแล้ว',
      `${greetingHtml(displayName)} เอกสารของคุณผ่านการตรวจสอบเรียบร้อยแล้ว ทำ 3 อย่างนี้เพื่อเริ่มรับงานแรก`,
    )}
    ${stepList([
      ['ตั้งวันและเวลาที่รับงาน', 'ลูกค้าจะเห็นคุณเฉพาะช่วงที่เปิดรับงาน'],
      ['เพิ่มบัญชีรับเงิน', 'เพื่อรับค่าตอบแทนหลังจบงาน'],
      ['เปิดการแจ้งเตือน', 'เพื่อไม่พลาดคำขอจองจากลูกค้า'],
    ])}
  `;

  const text = `${greetingText(displayName)}

ยินดีด้วย! เอกสารของคุณผ่านการตรวจสอบเรียบร้อยแล้ว
ตอนนี้คุณสามารถเปิดรับงานจากผู้ใช้บริการได้เลย

ตั้งวันและเวลาที่รับงาน: ${frontendUrl}/caregiver/settings/job-reception${plainTextFooter(frontendUrl)}`;

  return {
    subject,
    html: wrapHtml({
      bodyHtml,
      ctaUrl: `${frontendUrl}/caregiver/settings/job-reception`,
      ctaLabel: 'ตั้งวันและเวลาที่รับงาน',
      secondaryLinks: [
        { label: 'ไปหน้าหลักผู้ดูแล', url: `${frontendUrl}/caregiver-home` },
      ],
      frontendUrl,
      badge: { label: 'ยืนยันแล้ว', tone: 'success' },
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

  // reason มาจาก admin — issueCard escape ให้ (กัน XSS)
  const bodyHtml = `
    ${titleBlock(
      'เอกสารยืนยันตัวตนยังไม่ผ่าน',
      `${greetingHtml(displayName)} ไม่ต้องกังวล แก้ไขตามเหตุผลด้านล่าง แล้วส่งเอกสารกลับมาได้เลย`,
    )}
    ${issueCard('เหตุผลจากทีมตรวจสอบ', reason)}
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
      ctaLabel: 'แก้ไขและส่งเอกสารใหม่',
      frontendUrl,
      badge: { label: 'ต้องแก้ไข', tone: 'danger' },
      supportHtml: `ไม่แน่ใจว่าต้องแก้อย่างไร? ติดต่อทีม Payung ที่ <a href="mailto:${BRAND.contactEmail}" style="color:${BRAND.primaryColor};">${BRAND.contactEmail}</a>`,
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
    ${titleBlock(
      'ได้รับเอกสารที่แก้ไขแล้ว',
      `ขอบคุณ${escapeHtml(displayName ? `คุณ${displayName}` : '')} เราได้รับเอกสารชุดใหม่ของคุณแล้ว และจะแจ้งผลภายใน <strong>1–2 วันทำการ</strong>`,
    )}
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
      badge: { label: 'ตรวจสอบอีกครั้ง', tone: 'info' },
    }),
    text,
  };
}
