/**
 * PYG-540 — EmailService.sendMarketingEmail
 *
 * อีเมลข่าวสารต้องส่ง "เฉพาะคนที่ยินยอม marketing เวอร์ชันปัจจุบัน" เท่านั้น
 * สิ่งที่เทสนี้คุม:
 *   - ถอน / ไม่เคยตอบ / ปิดรับอีเมล / บัญชีถูกลบหรือปิด → ไม่ส่ง และไม่ throw
 *   - ยินยอมครบ → ส่งจริงผ่าน transporter
 *   - DB พัง → ไม่ throw (ผู้เรียกส่งเป็นชุด ฉบับเดียวพังต้องไม่หยุดทั้งชุด)
 *
 * ★ PYG-714: ส่งผ่าน Resend ด้วย fetch — mock global fetch ทุกเทส ห้ามยิง API จริงเด็ดขาด
 */
import type { ConfigService } from '@nestjs/config';
import { EmailService, resolveEmailLinkBaseUrl } from './email.service';
import type { PrismaService } from '../common/prisma.service';
import type { ConsentService } from '../consent/consent.service';
import { CONSENT_TYPE } from '../consent/consent.constants';
import type { EmailTemplate } from './templates/kyc.templates';

/** ค่าตั้งของ EmailService ในเทส — ครบทุกตัว (ส่งได้) เว้นแต่เทสจะลบออกเอง */
const CONFIG: Record<string, string | undefined> = {
  RESEND_API_KEY: 're_test_key',
  EMAIL_FROM: 'Payung <noreply@payung-care.com>',
  APP_PUBLIC_BASE_URL: 'https://payung-care.com',
  FRONTEND_URL: 'https://payung-care.com,https://www.payung-care.com',
};

function makeConfig(overrides: Record<string, string | undefined> = {}) {
  const values = { ...CONFIG, ...overrides };
  return {
    get: jest.fn((key: string, fallback?: unknown) => values[key] ?? fallback),
  } as unknown as ConfigService;
}

/**
 * แทน Resend ด้วย fetch ปลอม — คืน jest.fn ที่ถูกเรียกด้วย body (JSON) ของทุกฉบับที่ส่ง
 * ตอบ 200 { id } เหมือน Resend จริง
 */
function mockResend(): jest.Mock {
  const sendMail = jest.fn();
  jest.spyOn(global, 'fetch').mockImplementation((_url, init) => {
    sendMail(JSON.parse(init?.body as string));
    return Promise.resolve(
      new Response(JSON.stringify({ id: 'email-1' }), { status: 200 }),
    );
  });
  return sendMail;
}

afterEach(() => jest.restoreAllMocks());

const TPL: EmailTemplate = {
  subject: 'โปรโมชันเดือนนี้',
  html: '<p>hi</p>',
  text: 'hi',
};

/** ผู้ใช้ที่ผ่านทุกด่าน — แต่ละเทสแก้แค่ field ที่อยากทดสอบ */
const ACTIVE_USER = {
  email: 'somsri@example.com',
  emailPreferences: true,
  isActive: true,
  deleted_at: null as Date | null,
};

describe('EmailService.sendMarketingEmail (PYG-540)', () => {
  let sendMail: jest.Mock;
  let findUnique: jest.Mock;
  let hasGrantedCurrent: jest.Mock;
  let service: EmailService;

  beforeEach(() => {
    sendMail = mockResend();

    findUnique = jest.fn().mockResolvedValue({ ...ACTIVE_USER });
    hasGrantedCurrent = jest.fn().mockResolvedValue(true);

    service = new EmailService(
      makeConfig(),
      {
        user: { findUnique },
        email_logs: { create: jest.fn().mockResolvedValue({}) },
      } as unknown as PrismaService,
      { hasGrantedCurrent } as unknown as ConsentService,
    );
  });

  it('ยินยอม marketing เวอร์ชันปัจจุบัน → ส่ง และคืน true', async () => {
    await expect(service.sendMarketingEmail('user-1', TPL)).resolves.toBe(true);

    expect(hasGrantedCurrent).toHaveBeenCalledWith(
      'user-1',
      CONSENT_TYPE.MARKETING,
    );
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ['somsri@example.com'],
        subject: TPL.subject,
      }),
    );
  });

  it('★ ถอน / ไม่เคยตอบ / ยินยอมนโยบายเก่า (hasGrantedCurrent = false) → ไม่ส่ง', async () => {
    hasGrantedCurrent.mockResolvedValue(false);

    await expect(service.sendMarketingEmail('user-1', TPL)).resolves.toBe(
      false,
    );
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('ปิดรับอีเมล (emailPreferences = false) → ไม่ส่ง และไม่ต้องไปอ่าน consent', async () => {
    findUnique.mockResolvedValue({ ...ACTIVE_USER, emailPreferences: false });

    await expect(service.sendMarketingEmail('user-1', TPL)).resolves.toBe(
      false,
    );
    expect(hasGrantedCurrent).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it.each([
    ['บัญชีถูกลบแล้ว', { deleted_at: new Date('2026-09-01T00:00:00Z') }],
    ['บัญชีถูกปิด', { isActive: false }],
  ])('%s → ไม่ส่ง', async (_label, patch) => {
    findUnique.mockResolvedValue({ ...ACTIVE_USER, ...patch });

    await expect(service.sendMarketingEmail('user-1', TPL)).resolves.toBe(
      false,
    );
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('ไม่มีผู้ใช้คนนี้ → ไม่ส่ง', async () => {
    findUnique.mockResolvedValue(null);

    await expect(service.sendMarketingEmail('ghost', TPL)).resolves.toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('★ ถอน marketing แล้ว อีเมลธุรกรรม (KYC / การจอง) ยังส่งตามปกติ', async () => {
    hasGrantedCurrent.mockResolvedValue(false);
    findUnique.mockResolvedValue({ ...ACTIVE_USER, displayName: 'สมศรี' });

    await service.sendKycVerified('user-1');

    // อีเมลธุรกรรมไม่ผ่านด่าน marketing เลย — ถอนข้อข่าวสารต้องไม่ทำให้พลาดอีเมลสำคัญ
    expect(hasGrantedCurrent).not.toHaveBeenCalled();
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('★ อ่าน DB พัง → ไม่ throw คืน false', async () => {
    hasGrantedCurrent.mockRejectedValue(new Error('db down'));

    await expect(service.sendMarketingEmail('user-1', TPL)).resolves.toBe(
      false,
    );
    expect(sendMail).not.toHaveBeenCalled();
  });
});

/**
 * PYG-603 (E13) — บัญชีที่สมัครด้วยเบอร์โทรไม่มีอีเมล
 * ทุกทางที่ส่งอีเมลหาผู้ใช้ต้อง "ข้าม" ไม่ใช่ throw และไม่ส่งไปที่อยู่ว่าง
 */
describe('EmailService — บัญชีที่ไม่มีอีเมล (PYG-603)', () => {
  let sendMail: jest.Mock;
  let findUnique: jest.Mock;
  let service: EmailService;

  beforeEach(() => {
    sendMail = mockResend();
    findUnique = jest.fn();
    service = new EmailService(
      makeConfig(),
      {
        user: { findUnique },
        email_logs: { create: jest.fn().mockResolvedValue({}) },
      } as unknown as PrismaService,
      {
        hasGrantedCurrent: jest.fn().mockResolvedValue(true),
      } as unknown as ConsentService,
    );
  });

  it('อีเมลแจ้งเตือน (ผ่าน fetchUser) → ข้าม ไม่ throw ไม่ส่ง', async () => {
    findUnique.mockResolvedValue({
      email: null,
      displayName: null,
      emailPreferences: true,
    });

    await expect(
      service.sendKycSubmitted('user-phone-only'),
    ).resolves.toBeUndefined();
    await expect(
      service.sendBookingEmail(
        'user-phone-only',
        () => TPL,
        'booking.confirmed',
      ),
    ).resolves.toBeUndefined();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('อีเมลข่าวสาร → คืน false ไม่ส่ง', async () => {
    findUnique.mockResolvedValue({ ...ACTIVE_USER, email: null });
    await expect(
      service.sendMarketingEmail('user-phone-only', TPL),
    ).resolves.toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('บัญชีที่มีอีเมลยังได้รับตามเดิม (S07-AC5)', async () => {
    findUnique.mockResolvedValue({
      email: 'somsri@example.com',
      displayName: 'สมศรี',
      emailPreferences: true,
    });
    await service.sendKycSubmitted('user-1');
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: ['somsri@example.com'] }),
    );
  });
});

/**
 * PYG-714 — ส่งผ่าน Resend + บันทึก email_logs + base URL ของลิงก์
 */
describe('EmailService — Resend + email_logs (PYG-714)', () => {
  let findUnique: jest.Mock;
  let createLog: jest.Mock;
  let fetchMock: jest.SpyInstance;

  const USER = {
    email: 'somsri@example.com',
    displayName: 'สมศรี ใจดี',
    emailPreferences: true,
  };

  function build(overrides: Record<string, string | undefined> = {}) {
    return new EmailService(
      makeConfig(overrides),
      {
        user: { findUnique },
        email_logs: { create: createLog },
      } as unknown as PrismaService,
      { hasGrantedCurrent: jest.fn() } as unknown as ConsentService,
    );
  }

  function respond(status: number, body: unknown) {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));
  }

  /** แถว email_logs ที่ถูกเขียน (data ของ create) */
  const logged = () =>
    createLog.mock.calls.map(
      ([arg]: [{ data: Record<string, unknown> }]) => arg.data,
    );

  beforeEach(() => {
    findUnique = jest.fn().mockResolvedValue({ ...USER });
    createLog = jest.fn().mockResolvedValue({});
    fetchMock = jest.spyOn(global, 'fetch');
    respond(200, { id: 're_msg_123' });
  });

  it('ยิง POST /emails ของ Resend พร้อม API key + from/to/subject/html/text', async () => {
    await build().sendKycVerified('user-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer re_test_key',
    );
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      from: 'Payung <noreply@payung-care.com>',
      to: ['somsri@example.com'],
      subject: expect.stringContaining('ยืนยันตัวตนสำเร็จ') as unknown,
    });
    expect(body.html).toEqual(expect.stringContaining('<!DOCTYPE html>'));
    expect(body.text).toEqual(expect.any(String));
  });

  it('ส่งสำเร็จ → email_logs: sent + id ของ Resend + อีเมลแบบปิดบางส่วน', async () => {
    await build().sendKycVerified('user-1');

    expect(logged()).toEqual([
      expect.objectContaining({
        user_id: 'user-1',
        template: 'kyc_verified',
        status: 'sent',
        provider: 'resend',
        provider_message_id: 're_msg_123',
        recipient_masked: 's***@example.com',
      }),
    ]);
    // ★ ไม่เก็บอีเมลเต็ม
    expect(JSON.stringify(logged())).not.toContain('somsri@example.com');
  });

  it('Resend ตอบ error (เช่น โดเมนยังไม่ยืนยัน) → failed + เหตุผลจาก Resend · ไม่ throw', async () => {
    respond(403, {
      statusCode: 403,
      name: 'validation_error',
      message: 'The payung-care.com domain is not verified.',
    });

    await expect(build().sendKycVerified('user-1')).resolves.toBeUndefined();

    expect(logged()).toEqual([
      expect.objectContaining({
        status: 'failed',
        reason:
          'resend 403 validation_error: The payung-care.com domain is not verified.',
        provider_message_id: null,
      }),
    ]);
  });

  it('เครือข่ายพัง / timeout → failed + ข้อความ error · ไม่ throw', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      }),
    );

    await expect(build().sendKycVerified('user-1')).resolves.toBeUndefined();
    expect(logged()[0]).toMatchObject({
      status: 'failed',
      reason: 'TimeoutError: The operation was aborted due to timeout',
    });
  });

  it.each([
    ['ไม่มี RESEND_API_KEY', { RESEND_API_KEY: undefined }, 'RESEND_API_KEY'],
    ['ไม่มี EMAIL_FROM', { EMAIL_FROM: undefined }, 'EMAIL_FROM'],
  ])(
    '%s → แอปยังขึ้นได้ · ไม่ยิง Resend · บันทึก failed not_configured',
    async (_label, overrides, missing) => {
      const service = build(overrides);
      await service.sendKycVerified('user-1');

      expect(fetchMock).not.toHaveBeenCalled();
      expect(logged()[0]).toMatchObject({
        status: 'failed',
        reason: `not_configured: ${missing}`,
      });
    },
  );

  it.each([
    [
      'บัญชีที่สมัครด้วยเบอร์ (ไม่มีอีเมล)',
      { ...USER, email: null },
      'no_email',
      'user-1',
    ],
    [
      'ปิดรับอีเมล',
      { ...USER, emailPreferences: false },
      'email_opt_out',
      'user-1',
    ],
    ['ไม่พบผู้ใช้', null, 'user_not_found', null],
  ])(
    '%s → skipped + เหตุผล (ทีมตอบได้ว่าทำไมไม่ได้อีเมล)',
    async (_l, user, reason, userId) => {
      findUnique.mockResolvedValue(user);

      await build().sendBookingEmail('user-1', () => TPL, 'booking.confirmed');

      expect(fetchMock).not.toHaveBeenCalled();
      expect(logged()).toEqual([
        expect.objectContaining({
          user_id: userId,
          template: 'booking.confirmed',
          status: 'skipped',
          reason,
          provider: null,
        }),
      ]);
    },
  );

  it('★ เขียน email_logs ไม่ได้ → อีเมลยังส่ง และไม่ throw', async () => {
    createLog.mockRejectedValue(
      new Error('relation "email_logs" does not exist'),
    );

    await expect(build().sendKycVerified('user-1')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('อีเมลเชิญแอดมิน: บันทึก template แต่ไม่เก็บรหัสผ่านชั่วคราวลง DB', async () => {
    await build().sendAdminInvite(
      'new.admin@example.com',
      'แอดมินใหม่',
      'Temp#9876',
    );

    const row = logged()[0];
    expect(row).toMatchObject({
      template: 'admin_invite',
      status: 'sent',
      user_id: null,
    });
    expect(JSON.stringify(row)).not.toContain('Temp#9876');
    expect(JSON.stringify(row)).not.toContain('new.admin@example.com');
  });

  it('alert แอดมินหลายคน → ส่งฉบับเดียวถึงทุกคน · escape เนื้อหาใน HTML', async () => {
    await build().sendAdminAlert(
      ['a@example.com', 'b@example.com'],
      'Mismatch',
      '<b>x</b>',
    );

    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { to: string[]; html: string };
    expect(body.to).toEqual(['a@example.com', 'b@example.com']);
    expect(body.html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(logged()[0]).toMatchObject({
      template: 'admin_alert',
      recipient_masked: 'a***@example.com, b***@example.com',
    });
  });

  describe('ลิงก์ในอีเมล (เดิมพังทุกลิงก์บน production)', () => {
    it('★ FRONTEND_URL หลาย origin (ค่าบน Worker) ไม่หลุดเข้าไปในลิงก์', async () => {
      await build({ APP_PUBLIC_BASE_URL: undefined }).sendKycVerified('user-1');

      const html = String(
        (
          JSON.parse(
            (fetchMock.mock.calls[0] as [string, RequestInit])[1]
              .body as string,
          ) as { html: string }
        ).html,
      );
      expect(html).toContain('href="https://payung-care.com/caregiver-home"');
      expect(html).not.toContain('payung-care.com,https');
    });

    it.each([
      [
        'https://payung-care.com',
        'https://a.example,https://b.example',
        'https://payung-care.com',
      ],
      [
        undefined,
        'https://payung-care.com, https://www.payung-care.com',
        'https://payung-care.com',
      ],
      ['https://payung-care.com/', undefined, 'https://payung-care.com'],
      [undefined, undefined, 'https://payung-care.com'],
      ['  ', 'http://localhost:5173', 'http://localhost:5173'],
    ])('APP_PUBLIC_BASE_URL=%p FRONTEND_URL=%p → %s', (app, fe, expected) => {
      expect(resolveEmailLinkBaseUrl(app, fe)).toBe(expected);
    });
  });
});
