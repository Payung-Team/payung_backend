import { wrapHtml, plainTextFooter, escapeHtml } from './layout';
import { type EmailTemplate } from './kyc.templates';

function adminGreeting(displayName: string | null): string {
  return displayName ? `สวัสดีคุณ ${escapeHtml(displayName)}` : 'สวัสดีผู้ดูแลระบบ';
}

export function adminInviteTemplate(
  displayName: string | null,
  email: string,
  tempPassword: string,
  frontendUrl: string,
): EmailTemplate {
  const subject = 'คุณได้รับเชิญเป็น Admin ของ Payung';
  const name = displayName ?? email;
  const loginUrl = `${frontendUrl}/admin/login`;

  const bodyHtml = `
    <p>สวัสดีคุณ ${escapeHtml(name)},</p>
    <p>คุณได้รับเชิญให้เป็นผู้ดูแลระบบ (Admin) ของแพลตฟอร์ม <strong>Payung</strong></p>
    <p>ข้อมูลเข้าสู่ระบบของคุณ:</p>
    <div style="background:#f0f7f0; border-left:4px solid #2E8B57; padding:12px 16px; margin:16px 0; font-family:monospace;">
      <p style="margin:0;"><strong>Email:</strong> ${escapeHtml(email)}</p>
      <p style="margin:8px 0 0;"><strong>รหัสผ่านชั่วคราว:</strong> ${escapeHtml(tempPassword)}</p>
    </div>
    <p style="color:#e53935; font-weight:600;">⚠️ กรุณาเปลี่ยนรหัสผ่านเมื่อเข้าสู่ระบบครั้งแรก</p>
    <p>หากคุณไม่ได้คาดหวังที่จะได้รับอีเมลนี้ กรุณาติดต่อทีมงาน</p>
  `;

  const text = `สวัสดีคุณ ${name},

คุณได้รับเชิญให้เป็นผู้ดูแลระบบ (Admin) ของ Payung

ข้อมูลเข้าสู่ระบบ:
Email: ${email}
รหัสผ่านชั่วคราว: ${tempPassword}

กรุณาเปลี่ยนรหัสผ่านเมื่อเข้าสู่ระบบครั้งแรก

เข้าสู่ระบบ: ${loginUrl}${plainTextFooter(frontendUrl)}`;

  return {
    subject,
    html: wrapHtml({
      bodyHtml,
      ctaUrl: loginUrl,
      ctaLabel: 'เข้าสู่ระบบ Admin',
      frontendUrl,
    }),
    text,
  };
}

export function adminDeactivatedTemplate(
  displayName: string | null,
  frontendUrl: string,
): EmailTemplate {
  const subject = 'บัญชี Admin ของคุณถูกระงับ — Payung';

  const bodyHtml = `
    <p>${adminGreeting(displayName)},</p>
    <p>เราขอแจ้งให้ทราบว่าบัญชีผู้ดูแลระบบของคุณ <strong>ถูกระงับการใช้งาน</strong> เรียบร้อยแล้ว</p>
    <p>คุณจะไม่สามารถเข้าสู่ระบบได้จนกว่าบัญชีจะได้รับการเปิดใช้งานอีกครั้ง</p>
    <p>หากคุณเชื่อว่านี่เป็นข้อผิดพลาด กรุณาติดต่อ Super Admin ของทีม</p>
  `;

  const text = `${displayName ?? 'ผู้ดูแลระบบ'},

บัญชีผู้ดูแลระบบของคุณถูกระงับการใช้งาน
คุณจะไม่สามารถเข้าสู่ระบบได้จนกว่าบัญชีจะได้รับการเปิดใช้งานอีกครั้ง

หากคุณเชื่อว่านี่เป็นข้อผิดพลาด กรุณาติดต่อ Super Admin ของทีม${plainTextFooter(frontendUrl)}`;

  return {
    subject,
    html: wrapHtml({ bodyHtml, frontendUrl }),
    text,
  };
}

export function adminActivatedTemplate(
  displayName: string | null,
  frontendUrl: string,
): EmailTemplate {
  const subject = 'บัญชี Admin ของคุณถูกเปิดใช้งานอีกครั้ง — Payung';
  const loginUrl = `${frontendUrl}/admin/login`;

  const bodyHtml = `
    <p>${adminGreeting(displayName)},</p>
    <p>บัญชีผู้ดูแลระบบของคุณ <strong>ได้รับการเปิดใช้งานอีกครั้ง</strong> เรียบร้อยแล้ว</p>
    <p>คุณสามารถเข้าสู่ระบบและดำเนินการต่างๆ ได้ตามปกติ</p>
  `;

  const text = `${displayName ?? 'ผู้ดูแลระบบ'},

บัญชีผู้ดูแลระบบของคุณได้รับการเปิดใช้งานอีกครั้งเรียบร้อยแล้ว
คุณสามารถเข้าสู่ระบบได้ตามปกติ

เข้าสู่ระบบ: ${loginUrl}${plainTextFooter(frontendUrl)}`;

  return {
    subject,
    html: wrapHtml({
      bodyHtml,
      ctaUrl: loginUrl,
      ctaLabel: 'เข้าสู่ระบบ Admin',
      frontendUrl,
    }),
    text,
  };
}
