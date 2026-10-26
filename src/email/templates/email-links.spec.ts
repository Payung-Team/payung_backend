/**
 * PYG-703 — กันอีเมลพาไปหน้าที่ไม่มีอยู่ / โลโก้แตก / ล้นจอมือถือ กลับมาอีก
 *
 * ทุกลิงก์ในอีเมลต้องเป็น route ที่มีจริงใน payung_frontend (src/App.tsx)
 * ถ้า FE เปลี่ยน path ต้องแก้ ROUTES_IN_FE และ template ไปพร้อมกัน
 */
import {
  BRAND,
  emailSubject,
  greetingHtml,
  greetingText,
  wrapHtml,
} from './layout';
import {
  kycSubmittedTemplate,
  kycVerifiedTemplate,
  kycRejectedTemplate,
  kycResubmittedTemplate,
} from './kyc.templates';
import {
  adminInviteTemplate,
  adminDeactivatedTemplate,
  adminScheduleDeleteTemplate,
  adminCancelDeleteTemplate,
  adminAutoDeletedTemplate,
  userAutoDeletedTemplate,
  adminActivatedTemplate,
} from './admin.templates';
import { bookingNotificationTemplate } from './booking.templates';
import { BOOKING_EMAIL_TEMPLATES } from './booking';
import { bookingDetailPath } from './booking/helpers';
import type { BookingEmailContext } from './booking';

const F = 'https://payung-care.com';

/** อีเมลที่ตั้งใจไม่มีลิงก์เข้าเว็บ (ไม่มีปุ่ม + ไม่มีลิงก์ตั้งค่าการรับอีเมล) */
const NO_LINK_EMAILS = new Set([
  'adminDeactivated',
  'adminScheduleDelete',
  'adminAutoDeleted',
  'userAutoDeleted',
]);

/** route ใน FE (App.tsx) ที่อีเมลลิงก์ไปได้ — `:id` = ส่วนที่เปลี่ยนได้ */
const ROUTES_IN_FE = [
  /^\/login$/,
  /^\/notifications$/,
  /^\/kyc$/,
  /^\/caregiver-home$/,
  /^\/caregiver\/settings\/job-reception$/,
  /^\/booking\/new$/,
  /^\/bookings\/[^/]+$/,
  /^\/caregiver\/bookings\/[^/]+$/,
  /^\/admin\/disputes$/,
];

const ctx: BookingEmailContext = {
  recipientName: 'สมศรี ใจดี',
  recipientRole: 'patient',
  caregiverName: 'เชอรี่ ใจงาม',
  caregiverPhone: '0891234567',
  caregiverRatingText: '4.9 ★ (รีวิว 32 ครั้ง)',
  patientName: 'สมศรี ใจดี',
  dateText: '30 ตุลาคม 2569',
  timeText: '09:00 – 13:00 (4 ชม.)',
  serviceText: 'ดูแลทั่วไป',
  locationAddress: 'บางกะปิ กรุงเทพมหานคร',
  totalText: '฿1,200',
  paymentAmountText: '฿1,200',
  refundAmountText: '฿1,200',
  chargeId: 'chrg_test_1',
  declineReason: 'ไม่ว่างวันนั้น',
  bookingId: 'bk-1',
  frontendUrl: F,
};

/** ทุกอีเมลที่ระบบส่งได้ (ผู้รับทุกบทบาทของแต่ละ event) */
function allEmails(): Array<{
  name: string;
  html: string;
  text: string;
  subject: string;
}> {
  const out: Array<{
    name: string;
    html: string;
    text: string;
    subject: string;
  }> = [];
  const push = (
    name: string,
    t: { html: string; text: string; subject: string },
  ) => out.push({ name, ...t });

  push('kycSubmitted', kycSubmittedTemplate('เชอรี่', F));
  push('kycVerified', kycVerifiedTemplate('เชอรี่', F));
  push('kycRejected', kycRejectedTemplate('เชอรี่', 'รูปไม่ชัด', F));
  push('kycResubmitted', kycResubmittedTemplate('เชอรี่', F));
  push(
    'adminInvite',
    adminInviteTemplate('แอดมิน', 'a@example.com', 'Temp#1234', F),
  );
  push('adminDeactivated', adminDeactivatedTemplate('แอดมิน', F));
  push(
    'adminScheduleDelete',
    adminScheduleDeleteTemplate(
      'แอดมิน',
      new Date('2026-11-30T00:00:00Z'),
      30,
      F,
    ),
  );
  push('adminCancelDelete', adminCancelDeleteTemplate('แอดมิน', F));
  push('adminAutoDeleted', adminAutoDeletedTemplate('แอดมิน', F));
  push('userAutoDeleted', userAutoDeletedTemplate('สมศรี', F));
  push('adminActivated', adminActivatedTemplate('แอดมิน', F));
  push(
    'bookingFallback',
    bookingNotificationTemplate({
      recipientName: 'สมศรี',
      heading: 'โอนเงินแล้ว',
      intro: 'ระบบโอนค่าตอบแทนให้คุณแล้ว',
      frontendUrl: F,
      ctaUrl: `${F}${bookingDetailPath('bk-1', 'caregiver')}`,
    }),
  );
  for (const [event, tpl] of Object.entries(BOOKING_EMAIL_TEMPLATES)) {
    for (const role of ['patient', 'caregiver', 'admin'] as const) {
      push(`${event}:${role}`, tpl({ ...ctx, recipientRole: role }));
    }
  }
  return out;
}

/** href ทุกตัวที่ชี้เข้าเว็บของเรา → path */
function internalPaths(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)]
    .map((m) => m[1].replace(/&amp;/g, '&'))
    .filter((href) => href.startsWith(F))
    .map((href) => new URL(href).pathname);
}

describe('PYG-703 email templates', () => {
  const emails = allEmails();

  it.each(emails.map((e) => [e.name, e] as const))(
    '%s: ทุกลิงก์เป็นหน้าที่มีจริงใน FE',
    (_name, e) => {
      const paths = internalPaths(e.html);
      // PYG-732: อีเมลถึงแอดมิน (ไม่มีลิงก์ตั้งค่าการรับอีเมล) และอีเมลแจ้งว่าบัญชีถูกลบแล้ว อาจไม่มีลิงก์เข้าเว็บเลย
      if (!NO_LINK_EMAILS.has(e.name)) expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) {
        expect(ROUTES_IN_FE.some((r) => r.test(path))).toBe(true);
      }
    },
  );

  it.each(emails.map((e) => [e.name, e] as const))(
    '%s: หัวเรื่อง "… — Payung" · ไม่มีคำทักทายลงท้ายจุลภาค',
    (_name, e) => {
      expect(e.subject).toMatch(/ — Payung$/);
      expect(e.subject).not.toContain('[Payung]');
      expect(e.html).not.toMatch(/<p>สวัสดี[^<]*,<\/p>/);
      expect(e.text.split('\n')[0]).not.toMatch(/,$/);
    },
  );

  it('ไม่มีลิงก์เก่าที่ 404 หลงเหลือ', () => {
    for (const e of emails) {
      for (const dead of [
        '/settings/email',
        '/admin/login',
        '/dashboard',
        '/review',
        `${F}/caregivers"`,
      ]) {
        expect(e.html).not.toContain(dead);
        expect(e.text).not.toContain(dead);
      }
      expect(e.html).not.toContain('payung.app');
      expect(e.text).not.toContain('payung.app');
    }
  });

  it('ผู้ดูแลได้ลิงก์หน้างานของผู้ดูแล · ผู้รับบริการได้หน้าการจองของตัวเอง', () => {
    expect(bookingDetailPath('bk-1', 'caregiver')).toBe(
      '/caregiver/bookings/bk-1',
    );
    expect(bookingDetailPath('bk-1', 'patient')).toBe('/bookings/bk-1');
    const created =
      BOOKING_EMAIL_TEMPLATES[
        'booking.created' as keyof typeof BOOKING_EMAIL_TEMPLATES
      ]!;
    expect(created({ ...ctx, recipientRole: 'caregiver' }).html).toContain(
      `${F}/caregiver/bookings/bk-1`,
    );
  });

  describe('layout', () => {
    const html = wrapHtml({
      bodyHtml: '<p>x</p>',
      frontendUrl: F,
      ctaUrl: `${F}/login`,
      ctaLabel: 'เข้าสู่ระบบ',
    });

    it('โลโก้เป็นไฟล์บนเว็บจริงของเรา (เดิม payung.app/logo.png = 404)', () => {
      expect(BRAND.logoUrl).toBe('https://payung-care.com/logo_4.jpg');
      expect(html).toContain(`src="${BRAND.logoUrl}"`);
    });

    it('กล่องเนื้อหาไม่กว้างตายตัว (มือถือไม่ต้องเลื่อนซ้าย-ขวา)', () => {
      expect(html).toContain('max-width:600px');
      // width="600" มีได้เฉพาะในตาราง Outlook (conditional comment)
      const outsideMso = html.replace(
        /<!--\[if mso\]>[\s\S]*?<!\[endif\]-->/g,
        '',
      );
      expect(outsideMso).not.toContain('width="600"');
    });

    it('สีแบรนด์ตามแอป + อีเมลติดต่อของทีม', () => {
      expect(html).toContain('#009265');
      expect(html).not.toContain('#2E8B57');
      expect(html).toContain('mailto:payung.care@gmail.com');
    });
  });

  describe('คำทักทาย/หัวเรื่อง', () => {
    it('"สวัสดีคุณ{ชื่อ}" ไม่มีจุลภาค · ไม่มีชื่อ → fallback', () => {
      expect(greetingText('สมศรี ใจดี')).toBe('สวัสดีคุณสมศรี ใจดี');
      expect(greetingText('  ')).toBe('สวัสดี');
      expect(greetingText(null, 'สวัสดีผู้ดูแลระบบ')).toBe('สวัสดีผู้ดูแลระบบ');
    });

    it('greetingHtml escape ชื่อ', () => {
      expect(greetingHtml('<b>x</b>')).toBe('สวัสดีคุณ&lt;b&gt;x&lt;/b&gt;');
    });

    it('emailSubject', () => {
      expect(emailSubject('การจองยืนยันแล้ว')).toBe(
        'การจองยืนยันแล้ว — Payung',
      );
    });
  });
});
