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

export function adminScheduleDeleteTemplate(
  displayName: string | null,
  scheduledDeleteAt: Date,
  gracePeriodDays: number,
  frontendUrl: string,
): EmailTemplate {
  const subject = `บัญชี Admin ของคุณถูกกำหนดให้ลบใน ${gracePeriodDays} วัน — Payung`;
  const deleteDate = scheduledDeleteAt.toLocaleDateString('th-TH', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const bodyHtml = `
    <p>${adminGreeting(displayName)},</p>
    <p>บัญชีผู้ดูแลระบบของคุณถูก<strong>กำหนดให้ลบถาวร</strong>ในอีก <strong>${gracePeriodDays} วัน</strong></p>
    <div style="background:#fff5f5; border-left:4px solid #e53935; padding:12px 16px; margin:16px 0;">
      <p style="margin:0; font-weight:600; color:#c62828;">วันที่จะถูกลบถาวร:</p>
      <p style="margin:8px 0 0; font-size:18px;">${deleteDate}</p>
    </div>
    <p>หากคุณต้องการยกเลิกการลบบัญชี กรุณาติดต่อ Super Admin ของทีมก่อนวันดังกล่าว</p>
    <p>หากไม่มีการดำเนินการใดๆ บัญชีของคุณจะถูกลบถาวรโดยอัตโนมัติ</p>
  `;

  const text = `${displayName ?? 'ผู้ดูแลระบบ'},

บัญชีผู้ดูแลระบบของคุณถูกกำหนดให้ลบถาวรในอีก ${gracePeriodDays} วัน
วันที่จะถูกลบถาวร: ${deleteDate}

หากต้องการยกเลิก กรุณาติดต่อ Super Admin ของทีม${plainTextFooter(frontendUrl)}`;

  return {
    subject,
    html: wrapHtml({ bodyHtml, frontendUrl }),
    text,
  };
}

export function adminCancelDeleteTemplate(
  displayName: string | null,
  frontendUrl: string,
): EmailTemplate {
  const subject = 'การลบบัญชี Admin ของคุณถูกยกเลิก — Payung';
  const loginUrl = `${frontendUrl}/admin/login`;

  const bodyHtml = `
    <p>${adminGreeting(displayName)},</p>
    <p>เราขอแจ้งให้ทราบว่า <strong>การกำหนดลบบัญชี</strong>ผู้ดูแลระบบของคุณ<strong>ถูกยกเลิกแล้ว</strong></p>
    <p>บัญชีของคุณได้รับการเปิดใช้งานอีกครั้ง สามารถเข้าสู่ระบบได้ตามปกติ</p>
  `;

  const text = `${displayName ?? 'ผู้ดูแลระบบ'},

การกำหนดลบบัญชีผู้ดูแลระบบของคุณถูกยกเลิกแล้ว
บัญชีของคุณได้รับการเปิดใช้งานอีกครั้ง สามารถเข้าสู่ระบบได้ตามปกติ

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

export function adminAutoDeletedTemplate(
  displayName: string | null,
  frontendUrl: string,
): EmailTemplate {
  const subject = 'บัญชี Admin ของคุณถูกลบเรียบร้อยแล้ว — Payung';

  const bodyHtml = `
    <p>${adminGreeting(displayName)},</p>
    <p>บัญชีผู้ดูแลระบบของคุณใน <strong>Payung</strong> ถูก<strong>ลบถาวร</strong>ตามกำหนดเรียบร้อยแล้ว</p>
    <p>ข้อมูลและสิทธิ์การเข้าถึงทั้งหมดของบัญชีนี้ถูกยกเลิกแล้ว</p>
    <p>หากคุณมีข้อสงสัย กรุณาติดต่อ Super Admin ของทีม</p>
  `;

  const text = `${displayName ?? 'ผู้ดูแลระบบ'},

บัญชีผู้ดูแลระบบของคุณในระบบ Payung ถูกลบถาวรตามกำหนดเรียบร้อยแล้ว
ข้อมูลและสิทธิ์การเข้าถึงทั้งหมดของบัญชีนี้ถูกยกเลิกแล้ว

หากมีข้อสงสัย กรุณาติดต่อ Super Admin ของทีม${plainTextFooter(frontendUrl)}`;

  return {
    subject,
    html: wrapHtml({ bodyHtml, frontendUrl }),
    text,
  };
}

export function userAutoDeletedTemplate(
  displayName: string | null,
  frontendUrl: string,
): EmailTemplate {
  const subject = 'บัญชีของคุณถูกลบเรียบร้อยแล้ว — Payung';
  const name = displayName ? `สวัสดีคุณ ${escapeHtml(displayName)}` : 'สวัสดี';

  const bodyHtml = `
    <p>${name},</p>
    <p>บัญชีของคุณใน <strong>Payung</strong> ถูก<strong>ลบถาวร</strong>ตามกำหนดเรียบร้อยแล้ว</p>
    <p>ข้อมูลและสิทธิ์การเข้าถึงทั้งหมดของบัญชีนี้ถูกยกเลิกแล้ว</p>
    <p>หากคุณมีข้อสงสัย กรุณาติดต่อทีมสนับสนุนของ Payung</p>
  `;

  const text = `${displayName ?? 'ผู้ใช้งาน'},

บัญชีของคุณในระบบ Payung ถูกลบถาวรตามกำหนดเรียบร้อยแล้ว
ข้อมูลและสิทธิ์การเข้าถึงทั้งหมดของบัญชีนี้ถูกยกเลิกแล้ว

หากมีข้อสงสัย กรุณาติดต่อทีมสนับสนุน${plainTextFooter(frontendUrl)}`;

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
