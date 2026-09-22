/**
 * PYG-540 — เทสของ setConsent (ให้ / ถอนความยินยอมทีละข้อจากหน้าตั้งค่า)
 *
 * แยกไฟล์จาก consent.service.spec.ts ของ PYG-474 เพื่อไม่ให้ setup ร่วมกันแล้วพังข้ามกัน
 *
 * ธีมที่คุม:
 *   - ถอน = เขียนแถวใหม่ granted = false ไม่แก้ของเดิม (ตาราง append-only)
 *   - ถอนข้อที่ไม่เคยให้ความยินยอม → ผ่าน ไม่ error
 *   - ให้ความยินยอมต้องผูกกับเวอร์ชันที่เพิ่งอ่าน · ถอนไม่ต้องส่งเวอร์ชัน
 *   - ชนิดที่ไม่รู้จัก → ปฏิเสธ ไม่เขียนค่ามั่วลงตารางที่แก้ย้อนหลังไม่ได้
 *   - บันทึกหลักฐานครบ (source / ip / user agent)
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConsentService } from './consent.service';
import { PrismaService } from '../common/prisma.service';
import {
  CONSENT_SOURCE,
  CONSENT_TYPE,
  POLICY_VERSION,
} from './consent.constants';
import { CONSENT_ERROR, ConsentError } from './consent.errors';

const USER_ID = 'user-consent-1';
const EVIDENCE = {
  source: CONSENT_SOURCE.SETTINGS,
  ipAddress: '203.0.113.7',
  userAgent: 'jest/1.0',
};

function callArg<T>(mock: jest.Mock, callIndex = 0, argIndex = 0): T {
  const calls = mock.mock.calls as unknown as T[][];
  return calls[callIndex][argIndex];
}

describe('ConsentService.setConsent (PYG-540)', () => {
  let service: ConsentService;
  let create: jest.Mock;

  beforeEach(async () => {
    create = jest.fn().mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve({
        consent_type: args.data.consent_type,
        granted: args.data.granted,
        policy_version: args.data.policy_version,
        granted_at: new Date('2026-09-22T14:00:00Z'),
        source: args.data.source,
      }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConsentService,
        {
          provide: PrismaService,
          useValue: { user_consents: { create, findFirst: jest.fn(), findMany: jest.fn() } },
        },
      ],
    }).compile();

    service = module.get(ConsentService);
  });

  // ── ถอน ────────────────────────────────────────────────────────────────
  it('★ ถอน = เขียนแถวใหม่ granted = false ไม่แก้ของเดิม', async () => {
    const result = await service.setConsent(
      USER_ID,
      CONSENT_TYPE.MARKETING,
      false,
      EVIDENCE,
    );

    // ★ ตาราง append-only (PYG-473) — ต้องเป็น create ไม่ใช่ update
    //   ประวัติต้องพิสูจน์ได้ว่าเคยยินยอมจริงและถอนเมื่อไหร่
    expect(create).toHaveBeenCalledTimes(1);
    const written = callArg<{ data: Record<string, unknown> }>(create);
    expect(written.data).toMatchObject({
      user_id: USER_ID,
      consent_type: CONSENT_TYPE.MARKETING,
      granted: false,
      policy_version: POLICY_VERSION,
    });
    expect(result.granted).toBe(false);
  });

  it('★ ถอนข้อที่ไม่เคยให้ความยินยอม → ผ่าน ไม่ error', async () => {
    // ★ ผลลัพธ์ที่ผู้ใช้ต้องการคือ "ไม่ยินยอม" ซึ่งเป็นจริงอยู่แล้ว
    //   ถ้าตอบ error ปุ่มบนหน้าตั้งค่าจะพังโดยไม่มีเหตุผลที่ผู้ใช้เข้าใจได้
    await expect(
      service.setConsent(USER_ID, CONSENT_TYPE.MARKETING, false, EVIDENCE),
    ).resolves.toMatchObject({ granted: false });
  });

  it('★ ถอนไม่ต้องส่ง policyVersion — ยินยอมไว้กับฉบับเก่าก็ต้องถอนได้', async () => {
    // ★ ถ้าบังคับส่งเวอร์ชันปัจจุบัน ผู้ใช้ที่ยินยอมไว้กับฉบับเก่าจะถอนไม่ได้
    //   ซึ่งกลับหัวกลับหางกับสิทธิ์ที่เราเขียนไว้ในประกาศ
    await expect(
      service.setConsent(USER_ID, CONSENT_TYPE.SENSITIVE_HEALTH_DATA, false, EVIDENCE),
    ).resolves.toMatchObject({ granted: false });
  });

  // ── ให้ความยินยอม ───────────────────────────────────────────────────────
  it('ให้ความยินยอมด้วยเวอร์ชันปัจจุบัน → เขียนแถว granted = true', async () => {
    const result = await service.setConsent(
      USER_ID,
      CONSENT_TYPE.MARKETING,
      true,
      EVIDENCE,
      POLICY_VERSION,
    );

    expect(result.granted).toBe(true);
    expect(result.policyVersion).toBe(POLICY_VERSION);
  });

  it('★ ให้ความยินยอมด้วยเวอร์ชันเก่า → ปฏิเสธ และไม่เขียนอะไร', async () => {
    // ★ ผู้ใช้อ่านข้อความคนละฉบับกับที่บังคับใช้อยู่ — บันทึกไปจะเป็นหลักฐานเท็จ
    const err = await service
      .setConsent(USER_ID, CONSENT_TYPE.MARKETING, true, EVIDENCE, '0.9')
      .catch((e: ConsentError) => e);

    expect(err).toBeInstanceOf(ConsentError);
    expect((err as ConsentError).code).toBe(CONSENT_ERROR.POLICY_VERSION_MISMATCH);
    expect(create).not.toHaveBeenCalled();
  });

  it('ให้ความยินยอมโดยไม่ส่งเวอร์ชันเลย → ปฏิเสธ', async () => {
    await expect(
      service.setConsent(USER_ID, CONSENT_TYPE.MARKETING, true, EVIDENCE),
    ).rejects.toBeInstanceOf(ConsentError);
    expect(create).not.toHaveBeenCalled();
  });

  // ── ชนิดที่ไม่รู้จัก ─────────────────────────────────────────────────────
  it('★ ชนิดที่ไม่รู้จัก → ปฏิเสธ ไม่เขียนค่ามั่วลงตาราง', async () => {
    // ★ ตารางแก้ย้อนหลังไม่ได้ ค่าที่สะกดผิดจะค้างถาวรและทำให้การตรวจ
    //   "คนนี้ยินยอมหรือยัง" ตอบผิดโดยไม่มี error ให้เห็น
    const err = await service
      .setConsent(USER_ID, 'not_a_real_consent', false, EVIDENCE)
      .catch((e: ConsentError) => e);

    expect((err as ConsentError).code).toBe(CONSENT_ERROR.TYPE_INVALID);
    expect(create).not.toHaveBeenCalled();
  });

  // ── หลักฐาน ─────────────────────────────────────────────────────────────
  it('บันทึกหลักฐานครบ: source, ip_address, user_agent', async () => {
    await service.setConsent(USER_ID, CONSENT_TYPE.MARKETING, false, EVIDENCE);

    const written = callArg<{ data: Record<string, unknown> }>(create);
    expect(written.data).toMatchObject({
      source: CONSENT_SOURCE.SETTINGS,
      ip_address: EVIDENCE.ipAddress,
      user_agent: EVIDENCE.userAgent,
    });
  });

  it('ไม่มี IP (อ่านไม่ได้) → เขียน null ไม่ทำให้คำขอล้ม', async () => {
    await service.setConsent(USER_ID, CONSENT_TYPE.MARKETING, false, {
      source: CONSENT_SOURCE.SETTINGS,
      ipAddress: null,
      userAgent: null,
    });

    const written = callArg<{ data: Record<string, unknown> }>(create);
    expect(written.data.ip_address).toBeNull();
    expect(written.data.user_agent).toBeNull();
  });
});
