/**
 * Email layout — shared header + footer สำหรับทุก template (PYG-96)
 *
 * รวม HTML structure ที่ทุก email ใช้ร่วมกัน:
 * - Header: Payung brand
 * - Body: เนื้อหาเฉพาะของแต่ละ template
 * - Footer: unsubscribe + contact
 *
 * แยก layout ออกจาก template เฉพาะ → แก้สี/logo ที่เดียว เปลี่ยนทั้งระบบ
 *
 * ทำไมเขียน HTML inline (ไม่ใช้ React Email / MJML)?
 * - MVP ทำ 4 template — overhead ของ template engine ไม่คุ้ม
 * - ถ้าจำนวน template โตขึ้น ค่อย refactor ไป React Email/Handlebars
 */

// ─── Brand constants ──────────────────────────────────────────────────────
// แก้ที่นี่ที่เดียว = เปลี่ยนทุก email
// PYG-703: สี/ฟอนต์ตามแอป (FE ใช้ #009265 + Bai Jamjuree) · เดิม #2E8B57 คนละเฉดกับแอป
export const BRAND = {
  name: 'Payung',
  primaryColor: '#009265',
  textColor: '#1A1A1A',
  mutedColor: '#6B7773',
  pageBackground: '#F6FAF9',
  borderColor: '#E3EFEA',
  // PYG-703: เดิม https://payung.app/logo.png ตอบ 404 → ทุกอีเมลเห็นรูปแตก
  //   ใช้ไฟล์เดียวกับ favicon ของเว็บจริง (payung_frontend/public/logo_4.jpg) — ย้าย/เปลี่ยนชื่อไฟล์นั้นต้องแก้ที่นี่ด้วย
  //   ต้องเป็น URL เต็มของ production เสมอ (ไม่ใช้ frontendUrl — ตอน dev เป็น localhost ซึ่ง mail client โหลดไม่ได้)
  logoUrl: 'https://payung-care.com/logo_4.jpg',
  // PYG-703: กล่องที่ทีมใช้จริง (เดิม support@payung.app ไม่ใช่โดเมนของเรา)
  contactEmail: 'payung.care@gmail.com',
  fontFamily:
    "'Bai Jamjuree','Sarabun','Noto Sans Thai',Tahoma,Arial,sans-serif",
};

/**
 * หน้าที่ปิด/เปิดรับอีเมลได้ (สวิตช์ emailPreferences อยู่บนหน้าการแจ้งเตือน)
 * PYG-703: เดิมลิงก์ไป /settings/email ซึ่งไม่มีหน้านี้ใน FE → 404 ท้ายทุกอีเมล
 */
export const EMAIL_SETTINGS_PATH = '/notifications';

/** หัวเรื่องมาตรฐาน: "<เรื่อง> — Payung" (PYG-703: เดิมปน "[Payung] …" กับ "… — Payung") */
export function emailSubject(topic: string): string {
  return `${topic} — ${BRAND.name}`;
}

/**
 * คำทักทายมาตรฐานทุกอีเมล: "สวัสดีคุณสมศรี" (ไม่มีจุลภาคท้าย ไม่มีลงท้ายค่ะ/ครับ)
 * PYG-703: เดิมมี 3 แบบ — "สวัสดีค่ะ คุณสมศรี," / "สวัสดีคุณ สมศรี," / "สวัสดีผู้ดูแลระบบ"
 * คืนข้อความดิบ (ไม่ escape) — ฝั่ง HTML ต้องห่อด้วย escapeHtml เอง หรือใช้ greetingHtml
 */
export function greetingText(
  name: string | null | undefined,
  fallback = 'สวัสดี',
): string {
  const trimmed = name?.trim();
  return trimmed ? `สวัสดีคุณ${trimmed}` : fallback;
}

/** greetingText ที่ escape แล้วสำหรับใส่ใน HTML */
export function greetingHtml(
  name: string | null | undefined,
  fallback?: string,
): string {
  return escapeHtml(greetingText(name, fallback));
}

/** Escape HTML เพื่อกัน injection จาก user-supplied data (เช่น reason) */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** options สำหรับ wrapHtml */
export type LayoutOptions = {
  /** เนื้อหา body (HTML escaped แล้ว) */
  bodyHtml: string;
  /** URL ที่ปุ่ม CTA จะพาไป — undefined = ไม่แสดงปุ่ม */
  ctaUrl?: string;
  /** ข้อความบนปุ่ม CTA (ไทย) */
  ctaLabel?: string;
  /** frontend base URL — ใช้สร้าง link สำหรับ unsubscribe */
  frontendUrl: string;
}

/**
 * Wrap body content ด้วย header + footer + ปุ่ม CTA
 *
 * Inline CSS เพราะ email client หลายเจ้า strip <style> tag ออก
 * (Gmail, Outlook ฯลฯ — ใช้ inline style เท่านั้นถึงจะแน่ใจว่า render ตรง)
 *
 * PYG-703: กล่องเนื้อหาเดิม width="600" ตายตัว → บนมือถือ (375px) ต้องเลื่อนซ้าย-ขวา
 *   ตอนนี้ width 100% + max-width 600px · Outlook บน Windows ไม่รู้จัก max-width จึงมี
 *   ตารางครอบ 600px ใน conditional comment ให้เฉพาะ Outlook
 */
export function wrapHtml(opts: LayoutOptions): string {
  const ctaButton = opts.ctaUrl
    ? `
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px auto 4px;">
          <tr>
            <td style="border-radius:12px; background:${BRAND.primaryColor};">
              <a href="${escapeHtml(opts.ctaUrl)}"
                 style="display:inline-block; padding:14px 32px; color:#ffffff; text-decoration:none;
                        border-radius:12px; font-weight:600; font-size:16px; font-family:${BRAND.fontFamily};">
                ${escapeHtml(opts.ctaLabel ?? 'เปิดแอป Payung')}
              </a>
            </td>
          </tr>
        </table>`
    : '';

  const settingsUrl = `${opts.frontendUrl}${EMAIL_SETTINGS_PATH}`;

  return `
<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <title>${BRAND.name}</title>
  <!-- ฟอนต์เดียวกับแอป — Apple Mail/iOS โหลดได้ · Gmail/Outlook ข้ามแล้วใช้ฟอนต์สำรองใน fontFamily -->
  <link href="https://fonts.googleapis.com/css2?family=Bai+Jamjuree:wght@400;600;700&display=swap" rel="stylesheet">
</head>
<body style="margin:0; padding:0; background:${BRAND.pageBackground}; font-family:${BRAND.fontFamily}; color:${BRAND.textColor}; -webkit-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.pageBackground}; padding:24px 12px;">
    <tr><td align="center">

      <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
      <!-- ─── Container ───────────────────────────────────────────── -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="width:100%; max-width:600px; background:#ffffff; border-radius:16px; overflow:hidden;
                    border:1px solid ${BRAND.borderColor};">

        <!-- Header: แถบสีแบรนด์ + โลโก้บนพื้นขาว (โลโก้เป็น JPG พื้นขาว วางบนสีเขียวจะเห็นกรอบสี่เหลี่ยม) -->
        <tr><td style="height:4px; background:${BRAND.primaryColor}; font-size:0; line-height:0;">&nbsp;</td></tr>
        <tr>
          <td style="padding:20px 28px; border-bottom:1px solid ${BRAND.borderColor};">
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr>
                <td style="vertical-align:middle;">
                  <img src="${BRAND.logoUrl}" alt="" width="36" height="36" style="display:block; width:36px; height:36px; border:0;">
                </td>
                <td style="vertical-align:middle; padding-left:10px; font-size:22px; font-weight:700; color:${BRAND.primaryColor}; font-family:${BRAND.fontFamily};">
                  ${BRAND.name}
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:28px; line-height:1.7; font-size:16px; color:${BRAND.textColor}; font-family:${BRAND.fontFamily};">
            ${opts.bodyHtml}
            ${ctaButton}
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:${BRAND.pageBackground}; padding:20px 28px; text-align:center; font-size:13px; line-height:1.7; color:${BRAND.mutedColor}; border-top:1px solid ${BRAND.borderColor}; font-family:${BRAND.fontFamily};">
            <p style="margin:0 0 6px;">
              ติดต่อสอบถาม: <a href="mailto:${BRAND.contactEmail}" style="color:${BRAND.primaryColor};">${BRAND.contactEmail}</a>
            </p>
            <p style="margin:0;">
              ไม่ต้องการรับอีเมลแจ้งเตือน?
              <a href="${escapeHtml(settingsUrl)}" style="color:${BRAND.primaryColor};">ตั้งค่าการรับอีเมล</a>
            </p>
          </td>
        </tr>

      </table>
      <!--[if mso]></td></tr></table><![endif]-->

    </td></tr>
  </table>
</body>
</html>`.trim();
}

/**
 * สร้าง plain text version ของ footer — ใช้กับทุก template
 * email client ที่ block HTML จะแสดง plain text แทน
 */
export function plainTextFooter(frontendUrl: string): string {
  return `

---
${BRAND.name}
ติดต่อ: ${BRAND.contactEmail}
ตั้งค่าการรับอีเมล: ${frontendUrl}${EMAIL_SETTINGS_PATH}`;
}

/** ขนาดตัวอักษร/สีของหัวข้อในเนื้อหา — ใช้ร่วมทุก template ให้หน้าตาเหมือนกัน */
export const HEADING_STYLE = `font-size:20px; line-height:1.5; color:${BRAND.textColor}; margin:4px 0 12px; font-weight:700;`;
