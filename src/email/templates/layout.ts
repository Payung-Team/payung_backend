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
const BRAND = {
  name: 'Payung',
  // primary color — ใช้สำหรับ header background + button
  // ทีมแก้ค่านี้ให้ตรง brand จริงได้
  primaryColor: '#2E8B57',
  // logo — ใช้ URL จริงตอน production (host ใน Supabase Storage หรือ CDN)
  logoUrl: 'https://payung.app/logo.png',
  contactEmail: 'support@payung.app',
};

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
 */
export function wrapHtml(opts: LayoutOptions): string {
  const ctaButton = opts.ctaUrl
    ? `
        <div style="text-align:center; margin: 24px 0;">
          <a href="${escapeHtml(opts.ctaUrl)}"
             style="display:inline-block; padding:12px 32px; background:${BRAND.primaryColor};
                    color:#ffffff; text-decoration:none; border-radius:6px;
                    font-weight:600; font-size:16px;">
            ${escapeHtml(opts.ctaLabel ?? 'เปิดแอป Payung')}
          </a>
        </div>`
    : '';

  return `
<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${BRAND.name}</title>
</head>
<body style="margin:0; padding:0; background:#f5f5f5; font-family:'Sarabun',-apple-system,BlinkMacSystemFont,sans-serif; color:#333;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5; padding:24px 0;">
    <tr><td align="center">

      <!-- ─── Container ───────────────────────────────────────────── -->
      <table role="presentation" width="600" cellpadding="0" cellspacing="0"
             style="background:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.1);">

        <!-- Header -->
        <tr>
          <td style="background:${BRAND.primaryColor}; padding:24px; text-align:center;">
            <img src="${BRAND.logoUrl}" alt="${BRAND.name}" height="40" style="height:40px; vertical-align:middle;">
            <h1 style="color:#fff; font-size:24px; margin:8px 0 0; font-weight:600;">${BRAND.name}</h1>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:32px 24px; line-height:1.6; font-size:16px;">
            ${opts.bodyHtml}
            ${ctaButton}
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#fafafa; padding:20px 24px; text-align:center; font-size:12px; color:#888; border-top:1px solid #eee;">
            <p style="margin:0 0 8px;">
              ติดต่อสอบถาม: <a href="mailto:${BRAND.contactEmail}" style="color:${BRAND.primaryColor};">${BRAND.contactEmail}</a>
            </p>
            <p style="margin:0;">
              ไม่ต้องการรับอีเมลจากเรา?
              <a href="${escapeHtml(opts.frontendUrl)}/settings/email" style="color:${BRAND.primaryColor};">ปิดการแจ้งเตือนทางอีเมล</a>
            </p>
          </td>
        </tr>

      </table>

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
ปิดการแจ้งเตือนทางอีเมล: ${frontendUrl}/settings/email`;
}
