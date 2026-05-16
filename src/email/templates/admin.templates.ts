import { wrapHtml, plainTextFooter, escapeHtml } from './layout';
import { type EmailTemplate } from './kyc.templates';

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
