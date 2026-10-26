import {
  wrapHtml,
  plainTextFooter,
  emailSubject,
  greetingHtml,
  greetingText,
  BRAND,
  titleBlock,
  detailTable,
  warningBox,
  bulletBox,
  amountHero,
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
    ${titleBlock(
      'คุณได้รับเชิญเข้าทีมแอดมิน',
      `${greetingHtml(name)} บัญชีของคุณถูกเพิ่มเป็นผู้ดูแลระบบ (Admin) ของ Payung ใช้ข้อมูลด้านล่างเข้าสู่ระบบ แล้วตั้งรหัสผ่านใหม่`,
    )}
    ${detailTable([
      { label: 'อีเมล', value: email },
      { label: 'รหัสผ่านชั่วคราว', value: tempPassword, emphasis: 'strong' },
    ])}
    ${warningBox(`<strong>ต้องเปลี่ยนรหัสผ่านเมื่อเข้าสู่ระบบครั้งแรก</strong> · ไม่รู้จักผู้เชิญ? อย่าใช้รหัสนี้ และแจ้ง <a href="mailto:${BRAND.contactEmail}" style="color:#6B3E06;">${BRAND.contactEmail}</a> ทันที`)}
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
      ctaLabel: 'เข้าสู่ระบบและตั้งรหัสผ่านใหม่',
      frontendUrl,
      audience: 'admin',
      badge: { label: 'คำเชิญ', tone: 'info' },
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
    ${titleBlock(
      'บัญชีของคุณถูกระงับ',
      `${greetingHtml(displayName, ADMIN_FALLBACK_GREETING)} บัญชีผู้ดูแลระบบของคุณถูกระงับการใช้งานแล้ว`,
    )}
    ${bulletBox('ระหว่างถูกระงับ', [
      'เข้าสู่ระบบแอดมินไม่ได้ จนกว่าบัญชีจะถูกเปิดใช้งานอีกครั้ง',
      'ข้อมูลของคุณยังอยู่ครบ ไม่ถูกลบ',
    ])}
  `;

  const text = `${greetingText(displayName, ADMIN_FALLBACK_GREETING)}

บัญชีผู้ดูแลระบบของคุณถูกระงับการใช้งาน
คุณจะไม่สามารถเข้าสู่ระบบได้จนกว่าบัญชีจะได้รับการเปิดใช้งานอีกครั้ง

หากคุณเชื่อว่านี่เป็นข้อผิดพลาด กรุณาติดต่อ Super Admin ของทีม${plainTextFooter(frontendUrl)}`;

  return {
    subject,
    html: wrapHtml({
      bodyHtml,
      frontendUrl,
      audience: 'admin',
      badge: { label: 'ถูกระงับ', tone: 'danger' },
      supportHtml: `คิดว่าเป็นความผิดพลาด? ติดต่อ Super Admin ของทีม หรือ <a href="mailto:${BRAND.contactEmail}" style="color:${BRAND.primaryColor};">${BRAND.contactEmail}</a>`,
    }),
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
    ${titleBlock(
      'บัญชีของคุณถูกตั้งเวลาลบ',
      `${greetingHtml(displayName, ADMIN_FALLBACK_GREETING)} บัญชีผู้ดูแลระบบของคุณถูกกำหนดให้ลบถาวร และถูกระงับการใช้งานตั้งแต่ตอนนี้`,
    )}
    ${amountHero('ลบถาวรในอีก', `${gracePeriodDays} วัน`, deleteDate)}
    ${bulletBox('ต้องการยกเลิกการลบ?', [
      'ติดต่อ Super Admin ของทีมก่อนวันดังกล่าว',
      'หากไม่มีการดำเนินการใด ๆ บัญชีจะถูกลบถาวรโดยอัตโนมัติ',
    ])}
  `;

  const text = `${greetingText(displayName, ADMIN_FALLBACK_GREETING)}

บัญชีผู้ดูแลระบบของคุณถูกกำหนดให้ลบถาวรในอีก ${gracePeriodDays} วัน
วันที่จะถูกลบถาวร: ${deleteDate}

หากต้องการยกเลิก กรุณาติดต่อ Super Admin ของทีม${plainTextFooter(frontendUrl)}`;

  return {
    subject,
    html: wrapHtml({
      bodyHtml,
      frontendUrl,
      audience: 'admin',
      badge: { label: 'รอลบ', tone: 'warning' },
    }),
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
    ${titleBlock(
      'บัญชีของคุณจะไม่ถูกลบ',
      `${greetingHtml(displayName, ADMIN_FALLBACK_GREETING)} การลบบัญชีผู้ดูแลระบบของคุณถูกยกเลิกแล้ว บัญชีกลับมาใช้งานได้ตามปกติ และข้อมูลทั้งหมดยังอยู่ครบ`,
    )}
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
      ctaLabel: 'เข้าสู่ระบบ',
      frontendUrl,
      audience: 'admin',
      badge: { label: 'ยกเลิกการลบแล้ว', tone: 'success' },
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
    ${titleBlock(
      'บัญชีแอดมินของคุณถูกลบแล้ว',
      `${greetingHtml(displayName, ADMIN_FALLBACK_GREETING)} บัญชีผู้ดูแลระบบของคุณถูกลบถาวรตามกำหนดเวลา สิทธิ์เข้าถึงทั้งหมดถูกเพิกถอนแล้ว`,
    )}
  `;

  const text = `${greetingText(displayName, ADMIN_FALLBACK_GREETING)}

บัญชีผู้ดูแลระบบของคุณในระบบ Payung ถูกลบถาวรตามกำหนดเรียบร้อยแล้ว
ข้อมูลและสิทธิ์การเข้าถึงทั้งหมดของบัญชีนี้ถูกยกเลิกแล้ว

หากมีข้อสงสัย กรุณาติดต่อ Super Admin ของทีม${plainTextFooter(frontendUrl)}`;

  return {
    subject,
    html: wrapHtml({
      bodyHtml,
      frontendUrl,
      audience: 'admin',
      badge: { label: 'ลบแล้ว', tone: 'neutral' },
      supportHtml: `คิดว่าเป็นความผิดพลาด? ติดต่อ Super Admin ของทีม หรือ <a href="mailto:${BRAND.contactEmail}" style="color:${BRAND.primaryColor};">${BRAND.contactEmail}</a>`,
      footerNote: 'อีเมลแจ้งเตือนครั้งสุดท้าย',
    }),
    text,
  };
}

export function userAutoDeletedTemplate(
  displayName: string | null,
  frontendUrl: string,
): EmailTemplate {
  const subject = emailSubject('บัญชีของคุณถูกลบเรียบร้อยแล้ว');

  const bodyHtml = `
    ${titleBlock(
      'บัญชีของคุณถูกลบแล้ว',
      `${greetingHtml(displayName)} บัญชีของคุณใน Payung ถูกลบถาวรตามกำหนดเรียบร้อยแล้ว ขอบคุณที่ไว้วางใจ Payung`,
    )}
    ${bulletBox('สิ่งที่เกิดขึ้นกับบัญชี', [
      'ข้อมูลและสิทธิ์การเข้าถึงทั้งหมดของบัญชีนี้ถูกยกเลิกแล้ว',
      'อยากกลับมาใช้งาน? สมัครบัญชีใหม่ได้ทุกเมื่อ',
    ])}
  `;

  const text = `${greetingText(displayName)}

บัญชีของคุณในระบบ Payung ถูกลบถาวรตามกำหนดเรียบร้อยแล้ว
ข้อมูลและสิทธิ์การเข้าถึงทั้งหมดของบัญชีนี้ถูกยกเลิกแล้ว

หากมีข้อสงสัย กรุณาติดต่อทีมสนับสนุน${plainTextFooter(frontendUrl)}`;

  return {
    subject,
    html: wrapHtml({
      bodyHtml,
      frontendUrl,
      badge: { label: 'ลบแล้ว', tone: 'neutral' },
      hideEmailSettings: true,
      footerNote: 'อีเมลฉบับสุดท้าย',
    }),
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
    ${titleBlock(
      'บัญชีของคุณถูกเปิดใช้งานอีกครั้ง',
      `${greetingHtml(displayName, ADMIN_FALLBACK_GREETING)} บัญชีผู้ดูแลระบบของคุณกลับมาใช้งานได้แล้ว ข้อมูลและประวัติทั้งหมดยังอยู่ครบ`,
    )}
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
      ctaLabel: 'เข้าสู่ระบบ',
      frontendUrl,
      audience: 'admin',
      badge: { label: 'ใช้งานได้', tone: 'success' },
    }),
    text,
  };
}
