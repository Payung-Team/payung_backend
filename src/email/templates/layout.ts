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
  textColor: '#1F2A29',
  mutedColor: '#4B5857',
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

// ─── PYG-732: ระบบหน้าตาอีเมลตาม design (canvas "Payung Email Templates") ─────────
// โทนสีกลาง/พื้นผิวตาม design · สีหลัก (ปุ่ม/ลิงก์/โลโก้) ตามแอป #009265 · ฟอนต์ตามแอป
// ★ อีเมลใช้ flex/grid ไม่ได้ (Outlook/Gmail) — ทุก layout เป็น <table> + inline style
const UI = {
  pageBackground: '#E9EFEE',
  text: '#1F2A29',
  muted: '#4B5857',
  cardBorder: '#D5DEDD',
  divider: '#E2E8E7',
  surface: '#F3F7F6',
  warningBg: '#FFF7E6',
  warningText: '#6B3E06',
  dangerBorder: '#F3C6C6',
  dangerText: '#7A1F1F',
};

/** โทนของป้ายสถานะมุมขวาบน */
export type BadgeTone = 'success' | 'info' | 'warning' | 'danger' | 'neutral';
export type EmailBadge = { label: string; tone: BadgeTone };

const BADGE_COLORS: Record<BadgeTone, { bg: string; fg: string }> = {
  success: { bg: '#DCF2E6', fg: '#0F5132' },
  info: { bg: '#E0E9FB', fg: '#1E3A8A' },
  warning: { bg: '#FFF1D6', fg: '#7A4A00' },
  danger: { bg: '#FDECEC', fg: '#7A1F1F' },
  neutral: { bg: '#E6EAEA', fg: '#3F4A49' },
};

/** options สำหรับ wrapHtml */
export type LayoutOptions = {
  /** เนื้อหา body (HTML escaped แล้ว) — ประกอบจาก titleBlock / detailTable / … ด้านล่าง */
  bodyHtml: string;
  /** URL ที่ปุ่ม CTA จะพาไป — undefined = ไม่แสดงปุ่ม */
  ctaUrl?: string;
  /** ข้อความบนปุ่ม CTA (ไทย) */
  ctaLabel?: string;
  /** ลิงก์ข้อความใต้ปุ่มหลัก (เช่น "จองอีกครั้ง") */
  secondaryLinks?: { label: string; url: string }[];
  /** frontend base URL — ใช้สร้าง link สำหรับ unsubscribe */
  frontendUrl: string;
  /** ป้ายสถานะมุมขวาบน เช่น { label: 'ยืนยันแล้ว', tone: 'success' } */
  badge?: EmailBadge;
  /** 'admin' = อีเมลถึงทีมแอดมิน: ป้าย "Admin" ข้างโลโก้ · ไม่มีลิงก์ตั้งค่าการรับอีเมล */
  audience?: 'user' | 'admin';
  /** แถบล่างในการ์ด (HTML escaped แล้ว) — ไม่ส่ง = "มีคำถาม? ติดต่อ <อีเมลทีม>" */
  supportHtml?: string;
  /** ข้อความบรรทัดท้ายนอกการ์ด (ต่อท้าย "Payung · ") เช่น "อีเมลฉบับสุดท้าย" */
  footerNote?: string;
  /** ซ่อนลิงก์ตั้งค่าการรับอีเมล — เช่น อีเมลแจ้งว่าบัญชีถูกลบแล้ว (ผู้รับเข้าระบบไม่ได้อีก) */
  hideEmailSettings?: boolean;
};

const FONT = `font-family:${BRAND.fontFamily};`;

/** หัวข้อใหญ่ + ย่อหน้านำ (introHtml escaped แล้ว — ใส่คำทักทายไว้ในประโยคแรก) */
export function titleBlock(heading: string, introHtml?: string): string {
  return `
            <h1 style="margin:0 0 8px; font-size:26px; line-height:1.35; font-weight:700; color:${UI.text}; ${FONT}">${escapeHtml(heading)}</h1>
            ${introHtml ? `<p style="margin:0 0 24px; font-size:16px; line-height:1.6; color:${UI.muted};">${introHtml}</p>` : '<div style="height:16px;"></div>'}`;
}

/** แถวของ detailTable — value เป็นข้อความดิบ (escape ให้) */
export type DetailRow = {
  label: string;
  value: string;
  /** 'strong' = ตัวใหญ่หนา (ยอดเงิน) · 'strike' = ขีดฆ่า (นัดเดิมที่ยกเลิก) */
  emphasis?: 'strong' | 'strike';
};

/** ตารางรายละเอียด: ป้ายซ้าย (เทา) · ค่าขวา (หนา) · เส้นคั่นระหว่างแถว */
export function detailTable(rows: DetailRow[]): string {
  if (rows.length === 0) return '';
  const trs = rows
    .map((r, i) => {
      const border = i === 0 ? '' : `border-top:1px solid ${UI.divider};`;
      const valueStyle =
        r.emphasis === 'strong'
          ? `font-size:18px; font-weight:700; color:${UI.text};`
          : r.emphasis === 'strike'
            ? `font-size:15px; font-weight:600; color:${UI.muted}; text-decoration:line-through;`
            : `font-size:15px; font-weight:600; color:${UI.text};`;
      return `
              <tr>
                <td style="${border} padding:12px 12px 12px 0; width:112px; font-size:15px; color:${UI.muted}; vertical-align:top;">${escapeHtml(r.label)}</td>
                <td style="${border} padding:12px 0; ${valueStyle} vertical-align:top;">${escapeHtml(r.value)}</td>
              </tr>`;
    })
    .join('');
  return `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px; border:1px solid ${UI.cardBorder}; border-radius:10px; border-collapse:separate;">
              <tr><td style="padding:4px 20px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${trs}
                </table>
              </td></tr>
            </table>`;
}

/** กล่องพื้นเทาอ่อน — หมายเหตุ/ข้อความประกอบ (html escaped แล้ว) */
export function noteBox(html: string): string {
  return `
            <div style="margin:0 0 24px; background:${UI.surface}; border-radius:8px; padding:14px 16px; font-size:14px; line-height:1.6; color:${UI.text};">${html}</div>`;
}

/** กล่องเตือนสีเหลือง (html escaped แล้ว) */
export function warningBox(html: string): string {
  return `
            <div style="margin:0 0 24px; background:${UI.warningBg}; border-radius:8px; padding:14px 16px; font-size:14px; line-height:1.6; color:${UI.warningText};">${html}</div>`;
}

/** การ์ดขอบแดง — เรื่องที่ต้องแก้ (เช่น เหตุผลที่เอกสารไม่ผ่าน) · ข้อความดิบ (escape ให้) */
export function issueCard(title: string, detail: string): string {
  return `
            <div style="margin:0 0 24px; border:1px solid ${UI.dangerBorder}; border-radius:10px; padding:16px 20px;">
              <div style="font-size:16px; font-weight:700; color:${UI.text};">${escapeHtml(title)}</div>
              <div style="margin-top:4px; font-size:15px; line-height:1.6; color:${UI.dangerText}; white-space:pre-line;">${escapeHtml(detail)}</div>
            </div>`;
}

/** ยอดเงินตัวใหญ่ตรงกลาง (เช่น ยอดคืนเงิน) · ข้อความดิบ */
export function amountHero(
  label: string,
  amount: string,
  sub?: string,
): string {
  return `
            <div style="margin:0 0 24px; background:${UI.surface}; border-radius:10px; padding:24px; text-align:center;">
              <div style="font-size:14px; color:${UI.muted};">${escapeHtml(label)}</div>
              <div style="font-size:36px; line-height:1.3; font-weight:700; color:${UI.text};">${escapeHtml(amount)}</div>
              ${sub ? `<div style="font-size:14px; color:${UI.muted};">${escapeHtml(sub)}</div>` : ''}
            </div>`;
}

/** สรุปยอดเงิน: รายการ + บรรทัดรวมตัวหนา · ข้อความดิบ */
export function moneySummary(opts: {
  title?: string;
  rows: [string, string][];
  total: [string, string];
  note?: string;
}): string {
  const line = (l: string, v: string, strong = false) => `
                <tr>
                  <td style="padding:${strong ? '10px 0 0' : '5px 0'}; ${strong ? `border-top:1px solid ${UI.cardBorder}; font-size:18px; font-weight:700; color:${UI.text};` : `font-size:15px; color:${UI.muted};`}">${escapeHtml(l)}</td>
                  <td align="right" style="padding:${strong ? '10px 0 0' : '5px 0'}; ${strong ? `border-top:1px solid ${UI.cardBorder}; font-size:18px; font-weight:700;` : 'font-size:15px;'} color:${UI.text};">${escapeHtml(v)}</td>
                </tr>`;
  return `
            <div style="margin:0 0 24px; background:${UI.surface}; border-radius:10px; padding:20px;">
              ${opts.title ? `<div style="margin:0 0 6px; font-size:17px; font-weight:700; color:${UI.text};">${escapeHtml(opts.title)}</div>` : ''}
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${opts.rows.map(([l, v]) => line(l, v)).join('')}${line(opts.total[0], opts.total[1], true)}
              </table>
              ${opts.note ? `<div style="margin-top:10px; font-size:14px; line-height:1.6; color:${UI.muted};">${escapeHtml(opts.note)}</div>` : ''}
            </div>`;
}

/** รายการหัวข้อ + จุด (เช่น "ระหว่างถูกระงับ") · ข้อความดิบ */
export function bulletBox(title: string, items: string[]): string {
  return `
            <div style="margin:0 0 24px; background:${UI.surface}; border-radius:10px; padding:16px 20px;">
              <div style="margin:0 0 6px; font-size:15px; font-weight:700; color:${UI.text};">${escapeHtml(title)}</div>
              ${items.map((i) => `<div style="font-size:14px; line-height:1.7; color:${UI.muted};">· ${escapeHtml(i)}</div>`).join('')}
            </div>`;
}

/** ขั้นตอนมีเลขกำกับ (เช่น สิ่งที่ต้องทำต่อ) · ข้อความดิบ [หัวข้อ, คำอธิบาย] */
export function stepList(steps: [string, string][]): string {
  const rows = steps
    .map(
      ([title, desc], i) => `
                <tr>
                  <td style="width:36px; padding:8px 0; vertical-align:top;">
                    <span style="display:inline-block; width:26px; height:26px; line-height:26px; text-align:center; border-radius:999px; background:#DCF2E6; color:#0F5132; font-size:13px; font-weight:700;">${i + 1}</span>
                  </td>
                  <td style="padding:8px 0; font-size:15px; line-height:1.6; color:${UI.muted};"><strong style="color:${UI.text};">${escapeHtml(title)}</strong> — ${escapeHtml(desc)}</td>
                </tr>`,
    )
    .join('');
  return `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">${rows}
            </table>`;
}

/** ข้อความเล็กสีเทาท้ายเนื้อหา · ข้อความดิบ */
export function smallPrint(text: string): string {
  return `
            <p style="margin:0 0 8px; font-size:13px; line-height:1.6; color:${UI.muted};">${escapeHtml(text)}</p>`;
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
 * PYG-732: โครงตาม design — ป้ายสถานะมุมขวาบน · ปุ่มเต็มความกว้าง + ลิงก์รอง · แถบติดต่อในการ์ด
 */
export function wrapHtml(opts: LayoutOptions): string {
  const isAdmin = opts.audience === 'admin';
  const badge = opts.badge ? BADGE_COLORS[opts.badge.tone] : undefined;

  const ctaButton = opts.ctaUrl
    ? `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 ${opts.secondaryLinks?.length ? '12px' : '8px'};">
              <tr>
                <td align="center" style="border-radius:8px; background:${BRAND.primaryColor};">
                  <a href="${escapeHtml(opts.ctaUrl)}"
                     style="display:block; padding:14px 20px; color:#ffffff; text-decoration:none; border-radius:8px; font-weight:600; font-size:16px; ${FONT}">
                    ${escapeHtml(opts.ctaLabel ?? 'เปิดแอป Payung')}
                  </a>
                </td>
              </tr>
            </table>`
    : '';

  const secondary = opts.secondaryLinks?.length
    ? `
            <p style="margin:0 0 8px; text-align:center; font-size:14px;">${opts.secondaryLinks
              .map(
                (l) =>
                  `<a href="${escapeHtml(l.url)}" style="color:${BRAND.primaryColor}; margin:0 12px;">${escapeHtml(l.label)}</a>`,
              )
              .join('')}</p>`
    : '';

  const settingsUrl = `${opts.frontendUrl}${EMAIL_SETTINGS_PATH}`;
  const support =
    opts.supportHtml ??
    `มีคำถาม? ติดต่อทีม Payung ที่ <a href="mailto:${BRAND.contactEmail}" style="color:${BRAND.primaryColor};">${BRAND.contactEmail}</a>`;
  const footerParts = [
    BRAND.name,
    ...(opts.footerNote ? [escapeHtml(opts.footerNote)] : []),
    ...(isAdmin || opts.hideEmailSettings
      ? []
      : [
          `<a href="${escapeHtml(settingsUrl)}" style="color:${UI.muted};">ตั้งค่าการรับอีเมล</a>`,
        ]),
  ];

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
<body style="margin:0; padding:0; background:${UI.pageBackground}; ${FONT} color:${UI.text}; -webkit-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${UI.pageBackground}; padding:24px 12px;">
    <tr><td align="center">

      <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
      <!-- ─── Card ───────────────────────────────────────────────── -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="width:100%; max-width:600px; background:#ffffff; border-radius:12px; overflow:hidden;">

        <!-- Header: โลโก้ + ป้ายสถานะ -->
        <tr>
          <td style="padding:20px 28px; border-bottom:1px solid ${UI.divider};">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="vertical-align:middle;">
                  <table role="presentation" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="vertical-align:middle;">
                        <img src="${BRAND.logoUrl}" alt="" width="28" height="28" style="display:block; width:28px; height:28px; border:0;">
                      </td>
                      <td style="vertical-align:middle; padding-left:10px; font-size:20px; font-weight:700; color:${UI.text}; ${FONT}">${BRAND.name}</td>
                      ${isAdmin ? `<td style="vertical-align:middle; padding-left:8px; font-size:13px; color:${UI.muted};">Admin</td>` : ''}
                    </tr>
                  </table>
                </td>
                ${
                  opts.badge && badge
                    ? `<td align="right" style="vertical-align:middle;">
                  <span style="display:inline-block; font-size:13px; font-weight:600; color:${badge.fg}; background:${badge.bg}; padding:4px 12px; border-radius:999px; white-space:nowrap;">${escapeHtml(opts.badge.label)}</span>
                </td>`
                    : ''
                }
              </tr>
            </table>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:28px; line-height:1.6; font-size:16px; color:${UI.text}; ${FONT}">
            ${opts.bodyHtml}
            ${ctaButton}
            ${secondary}
          </td>
        </tr>

        <!-- Support -->
        <tr>
          <td style="padding:18px 28px; border-top:1px solid ${UI.divider}; font-size:14px; line-height:1.6; color:${UI.muted}; ${FONT}">
            ${support}
          </td>
        </tr>

      </table>
      <!--[if mso]></td></tr></table><![endif]-->

      <!-- Footer นอกการ์ด -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%; max-width:600px;">
        <tr>
          <td align="center" style="padding:16px 12px 0; font-size:12px; line-height:1.7; color:${UI.muted}; ${FONT}">
            ${footerParts.join(' · ')}
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
ตั้งค่าการรับอีเมล: ${frontendUrl}${EMAIL_SETTINGS_PATH}`;
}

/** ขนาดตัวอักษร/สีของหัวข้อในเนื้อหา — ใช้ร่วมทุก template ให้หน้าตาเหมือนกัน */
export const HEADING_STYLE = `font-size:20px; line-height:1.5; color:${BRAND.textColor}; margin:4px 0 12px; font-weight:700;`;
