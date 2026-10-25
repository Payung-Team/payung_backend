import {
  wrapHtml,
  plainTextFooter,
  escapeHtml,
  emailSubject,
  greetingHtml,
  greetingText,
  BRAND,
} from './layout';
import { type EmailTemplate } from './kyc.templates';

// PYG-703: คำทักทายกลางจาก layout · ไม่มีชื่อ → "สวัสดีผู้ดูแลระบบ"
const ADMIN_FALLBACK_GREETING = 'สวัสดีผู้ดูแลระบบ';

// PYG-703: เดิม /admin/login ซึ่งไม่มี route ใน FE (404) — แอดมินเข้าทางหน้าเข้าสู่ระบบเดียวกับทุกคน
//   แล้วระบบพาไปหน้าแอดมินตาม role เอง
const loginPath = '/login';

export function adminInviteTemplate(
  displayName: string | null,
  email: string,
  tempPassword: string,
  frontendUrl: string,
): EmailTemplate {
  const subject = emailSubject('คุณได้รับเชิญเป็น Admin');
  const name = displayName ?? email;
  const loginUrl = `${frontendUrl}${loginPath}`;

  const bodyHtml = `
    <p>${greetingHtml(name)}</p>
    <p>คุณได้รับเชิญให้เป็นผู้ดูแลระบบ (Admin) ของแพลตฟอร์ม <strong>Payung</strong></p>
    <p>ข้อมูลเข้าสู่ระบบของคุณ:</p>
    <div style="background:#F0FAF4; border-left:4px solid ${BRAND.primaryColor}; padding:12px 16px; margin:16px 0; font-family:monospace;">
      <p style="margin:0;"><strong>Email:</strong> ${escapeHtml(email)}</p>
      <p style="margin:8px 0 0;"><strong>รหัสผ่านชั่วคราว:</strong> ${escapeHtml(tempPassword)}</p>
    </div>
    <p style="color:#e53935; font-weight:600;">⚠️ กรุณาเปลี่ยนรหัสผ่านเมื่อเข้าสู่ระบบครั้งแรก</p>
    <p>หากคุณไม่ได้คาดหวังที่จะได้รับอีเมลนี้ กรุณาติดต่อทีมงาน</p>
  `;

  const text = `${greetingText(name)}

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
  const subject = emailSubject('บัญชี Admin ของคุณถูกระงับ');

  const bodyHtml = `
    <p>${greetingHtml(displayName, ADMIN_FALLBACK_GREETING)}</p>
    <p>เราขอแจ้งให้ทราบว่าบัญชีผู้ดูแลระบบของคุณ <strong>ถูกระงับการใช้งาน</strong> เรียบร้อยแล้ว</p>
    <p>คุณจะไม่สามารถเข้าสู่ระบบได้จนกว่าบัญชีจะได้รับการเปิดใช้งานอีกครั้ง</p>
    <p>หากคุณเชื่อว่านี่เป็นข้อผิดพลาด กรุณาติดต่อ Super Admin ของทีม</p>
  `;

  const text = `${greetingText(displayName, ADMIN_FALLBACK_GREETING)}

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
  const subject = emailSubject(
    `บัญชี Admin ของคุณถูกกำหนดให้ลบใน ${gracePeriodDays} วัน`,
  );
  const deleteDate = scheduledDeleteAt.toLocaleDateString('th-TH', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const bodyHtml = `
    <p>${greetingHtml(displayName, ADMIN_FALLBACK_GREETING)}</p>
    <p>บัญชีผู้ดูแลระบบของคุณถูก<strong>กำหนดให้ลบถาวร</strong>ในอีก <strong>${gracePeriodDays} วัน</strong></p>
    <div style="background:#fff5f5; border-left:4px solid #e53935; padding:12px 16px; margin:16px 0;">
      <p style="margin:0; font-weight:600; color:#c62828;">วันที่จะถูกลบถาวร:</p>
      <p style="margin:8px 0 0; font-size:18px;">${deleteDate}</p>
    </div>
    <p>หากคุณต้องการยกเลิกการลบบัญชี กรุณาติดต่อ Super Admin ของทีมก่อนวันดังกล่าว</p>
    <p>หากไม่มีการดำเนินการใดๆ บัญชีของคุณจะถูกลบถาวรโดยอัตโนมัติ</p>
  `;

  const text = `${greetingText(displayName, ADMIN_FALLBACK_GREETING)}

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
  const subject = emailSubject('การลบบัญชี Admin ของคุณถูกยกเลิก');
  const loginUrl = `${frontendUrl}${loginPath}`;

  const bodyHtml = `
    <p>${greetingHtml(displayName, ADMIN_FALLBACK_GREETING)}</p>
    <p>เราขอแจ้งให้ทราบว่า <strong>การกำหนดลบบัญชี</strong>ผู้ดูแลระบบของคุณ<strong>ถูกยกเลิกแล้ว</strong></p>
    <p>บัญชีของคุณได้รับการเปิดใช้งานอีกครั้ง สามารถเข้าสู่ระบบได้ตามปกติ</p>
  `;

  const text = `${greetingText(displayName, ADMIN_FALLBACK_GREETING)}

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
  const subject = emailSubject('บัญชี Admin ของคุณถูกลบเรียบร้อยแล้ว');

  const bodyHtml = `
    <p>${greetingHtml(displayName, ADMIN_FALLBACK_GREETING)}</p>
    <p>บัญชีผู้ดูแลระบบของคุณใน <strong>Payung</strong> ถูก<strong>ลบถาวร</strong>ตามกำหนดเรียบร้อยแล้ว</p>
    <p>ข้อมูลและสิทธิ์การเข้าถึงทั้งหมดของบัญชีนี้ถูกยกเลิกแล้ว</p>
    <p>หากคุณมีข้อสงสัย กรุณาติดต่อ Super Admin ของทีม</p>
  `;

  const text = `${greetingText(displayName, ADMIN_FALLBACK_GREETING)}

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
  const subject = emailSubject('บัญชีของคุณถูกลบเรียบร้อยแล้ว');

  const bodyHtml = `
    <p>${greetingHtml(displayName)}</p>
    <p>บัญชีของคุณใน <strong>Payung</strong> ถูก<strong>ลบถาวร</strong>ตามกำหนดเรียบร้อยแล้ว</p>
    <p>ข้อมูลและสิทธิ์การเข้าถึงทั้งหมดของบัญชีนี้ถูกยกเลิกแล้ว</p>
    <p>หากคุณมีข้อสงสัย กรุณาติดต่อทีมสนับสนุนของ Payung</p>
  `;

  const text = `${greetingText(displayName)}

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
  const subject = emailSubject('บัญชี Admin ของคุณถูกเปิดใช้งานอีกครั้ง');
  const loginUrl = `${frontendUrl}${loginPath}`;

  const bodyHtml = `
    <p>${greetingHtml(displayName, ADMIN_FALLBACK_GREETING)}</p>
    <p>บัญชีผู้ดูแลระบบของคุณ <strong>ได้รับการเปิดใช้งานอีกครั้ง</strong> เรียบร้อยแล้ว</p>
    <p>คุณสามารถเข้าสู่ระบบและดำเนินการต่างๆ ได้ตามปกติ</p>
  `;

  const text = `${greetingText(displayName, ADMIN_FALLBACK_GREETING)}

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
