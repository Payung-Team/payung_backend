/**
 * PYG-540 — EmailService.sendMarketingEmail
 *
 * อีเมลข่าวสารต้องส่ง "เฉพาะคนที่ยินยอม marketing เวอร์ชันปัจจุบัน" เท่านั้น
 * สิ่งที่เทสนี้คุม:
 *   - ถอน / ไม่เคยตอบ / ปิดรับอีเมล / บัญชีถูกลบหรือปิด → ไม่ส่ง และไม่ throw
 *   - ยินยอมครบ → ส่งจริงผ่าน transporter
 *   - DB พัง → ไม่ throw (ผู้เรียกส่งเป็นชุด ฉบับเดียวพังต้องไม่หยุดทั้งชุด)
 *
 * ★ mock nodemailer ทั้งโมดูล — เทสต้องไม่ต่อ SMTP จริงเด็ดขาด
 */
jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

import * as nodemailer from 'nodemailer';
import type { ConfigService } from '@nestjs/config';
import { EmailService } from './email.service';
import type { PrismaService } from '../common/prisma.service';
import type { ConsentService } from '../consent/consent.service';
import { CONSENT_TYPE } from '../consent/consent.constants';
import type { EmailTemplate } from './templates/kyc.templates';

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
    sendMail = jest.fn().mockResolvedValue({ messageId: 'm-1' });
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });

    findUnique = jest.fn().mockResolvedValue({ ...ACTIVE_USER });
    hasGrantedCurrent = jest.fn().mockResolvedValue(true);

    const config = {
      getOrThrow: jest.fn().mockReturnValue('x'),
      get: jest.fn((_key: string, fallback: unknown) => fallback),
    };

    service = new EmailService(
      config as unknown as ConfigService,
      { user: { findUnique } } as unknown as PrismaService,
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
        to: 'somsri@example.com',
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
