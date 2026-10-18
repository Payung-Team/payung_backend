/**
 * PYG-603 — เทสสมัคร / ล็อกอิน / ผูกเบอร์ด้วยเบอร์โทร (AC1–AC7 + E1, E4, E5, E7–E12 ของ PYG-562)
 *
 * ── ของปลอม / ของจริง ─────────────────────────────────────────────────────
 *   ปลอม: FakeSupabase (แทน Supabase Auth — ไม่ส่ง SMS จริง ตามที่การ์ดกำหนด) และ Prisma ในหน่วยความจำ
 *   จริง: PhoneOtpTracker, PhoneVerificationTokenService, ConsentService, UserService.mapToEntity
 *         → กฎของเรา (จังหวะ / ครั้งที่ผิด / ตั๋ว / ความยินยอม) ถูกทดสอบด้วยโค้ดจริงทั้งหมด
 *
 * FakeSupabase จำลองพฤติกรรมของ Supabase ที่ระบบพึ่ง:
 *   - signInWithOtp(createUser) สร้างผู้ใช้ที่ยังไม่ยืนยันให้ / ปฏิเสธถ้าไม่มีผู้ใช้และห้ามสร้าง
 *   - เก็บรหัสล่าสุดตัวเดียวต่อเบอร์ (ขอใหม่ = รหัสเก่าใช้ไม่ได้ · E8)
 *   - ตอบ otp_rejected เหมือนกันทั้งรหัสผิดและรหัสหมดอายุ (พฤติกรรมจริงของ Supabase)
 *   - refresh token ใช้ได้ครั้งเดียว
 */
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { GraphQLError } from 'graphql';
import type { PrismaService } from '../../../common/prisma.service';
import type { AuthUser } from '../../../common/decorators/current-user.decorator';
import { ConsentService } from '../../../consent/consent.service';
import {
  CONSENT_SOURCE,
  CONSENT_TYPE,
  POLICY_VERSION,
} from '../../../consent/consent.constants';
import { CONSENT_ERROR } from '../../../consent/consent.errors';
import type { CaregiverService } from '../../kyc/caregiver.service';
import { UserService } from '../user.service';
import { PhoneOtpPurpose } from './dto/phone-auth.dto';
import { PHONE_AUTH_DEFAULTS, type PhoneAuthConfig } from './phone-auth.config';
import { PHONE_AUTH_ERROR } from './phone-auth.errors';
import {
  type LoginPhoneStatus,
  type PhoneAccount,
  PhoneAuthGateway,
  PhoneGatewayError,
  type PhoneGatewayFailure,
  type PhoneSession,
} from './phone-auth.gateway';
import { PhoneAuthService } from './phone-auth.service';
import { PhoneOtpTracker } from './phone-otp-tracker';
import {
  PHONE_VERIFICATION_TOKEN_SECRET_ENV,
  PhoneVerificationTokenService,
} from './phone-verification-token.service';

// ─── ค่าคงที่ ─────────────────────────────────────────────────────────────────

const PHONE = '+66812345678'; // FE ส่ง E.164 เสมอ
const NATIONAL = '0812345678';
const CODE = '123456';
const WRONG = '000000';
const IP = '203.0.113.9';
const EVIDENCE = { ipAddress: IP, userAgent: 'jest/1.0' };
const T0 = Date.UTC(2026, 9, 16, 3, 0, 0);

const VALID_CONSENTS = [
  {
    type: CONSENT_TYPE.TERMS_OF_SERVICE,
    granted: true,
    policyVersion: POLICY_VERSION,
  },
  {
    type: CONSENT_TYPE.PRIVACY_POLICY,
    granted: true,
    policyVersion: POLICY_VERSION,
  },
  {
    type: CONSENT_TYPE.MARKETING,
    granted: false,
    policyVersion: POLICY_VERSION,
  },
];

// ─── Supabase ปลอม ────────────────────────────────────────────────────────────

interface FakeAuthUser {
  uid: string;
  phone: string | null; // รูปที่ Supabase เก็บ "66812345678"
  confirmed: boolean;
  /** เบอร์ที่ขอผูกไว้แต่ยังไม่ยืนยัน (phone_change) */
  pendingPhone?: string;
}

class FakeSupabase extends PhoneAuthGateway {
  users: FakeAuthUser[] = [];
  /** รหัสล่าสุดของแต่ละ `${type}:${e164}` */
  codes = new Map<string, string>();
  /** access token → uid (ผู้ใช้ที่ล็อกอินอยู่) */
  accessTokens = new Map<string, string>();
  /** refresh token ที่ยังใช้ได้ → uid */
  refreshTokens = new Map<string, string>();
  smsSent: Array<{ type: 'sms' | 'phone_change'; e164: string }> = [];
  /** รหัสที่ SMS ถัดไปจะใช้ */
  nextCode = CODE;
  /** ทำให้การเรียกครั้งถัดไปของเมธอดนั้นล้ม */
  failNext: Partial<
    Record<'send' | 'verify' | 'refresh', PhoneGatewayFailure>
  > = {};
  /** ใช้หา userId ของแถว public.users จาก uid */
  constructor(private readonly db: FakeDb) {
    super();
  }
  private seq = 0;

  private toStored(e164: string) {
    return e164.replace('+', '');
  }
  private session(uid: string): PhoneSession {
    this.seq += 1;
    const refreshToken = `refresh-${this.seq}`;
    this.refreshTokens.set(refreshToken, uid);
    return {
      supabaseUid: uid,
      accessToken: `access-${this.seq}`,
      refreshToken,
    };
  }
  private maybeFail(op: 'send' | 'verify' | 'refresh') {
    const kind = this.failNext[op];
    if (kind) {
      delete this.failNext[op];
      throw new PhoneGatewayError(
        kind,
        kind === 'rate_limited' ? 30 : undefined,
        `fake ${kind}`,
      );
    }
  }

  findAccountByPhone(supabasePhone: string): Promise<PhoneAccount | null> {
    const u = this.users.find((x) => x.phone === supabasePhone);
    if (!u) return Promise.resolve(null);
    const row = this.db.users.find((r) => r.supabaseUid === u.uid);
    return Promise.resolve({
      supabaseUid: u.uid,
      phoneConfirmed: u.confirmed,
      userId: row?.id ?? null,
    });
  }

  loginPhoneStatus(userId: string): Promise<LoginPhoneStatus | null> {
    const row = this.db.users.find((r) => r.id === userId);
    if (!row) return Promise.resolve(null);
    const u = this.users.find((x) => x.uid === row.supabaseUid);
    return Promise.resolve({
      phone: u?.phone ?? null,
      confirmed: u?.confirmed ?? false,
    });
  }

  sendSmsOtp(e164: string, createUser: boolean): Promise<void> {
    this.maybeFail('send');
    let u = this.users.find((x) => x.phone === this.toStored(e164));
    if (!u) {
      if (!createUser) throw new PhoneGatewayError('no_account');
      u = {
        uid: `sb-${this.users.length + 1}`,
        phone: this.toStored(e164),
        confirmed: false,
      };
      this.users.push(u);
    }
    this.codes.set(`sms:${e164}`, this.nextCode);
    this.smsSent.push({ type: 'sms', e164 });
    return Promise.resolve();
  }

  verifySmsOtp(e164: string, code: string): Promise<PhoneSession> {
    this.maybeFail('verify');
    if (this.codes.get(`sms:${e164}`) !== code)
      throw new PhoneGatewayError('otp_rejected');
    this.codes.delete(`sms:${e164}`); // ใช้ได้ครั้งเดียว
    const u = this.users.find((x) => x.phone === this.toStored(e164))!;
    u.confirmed = true;
    return Promise.resolve(this.session(u.uid));
  }

  sendPhoneChangeOtp(accessToken: string, e164: string): Promise<void> {
    this.maybeFail('send');
    const uid = this.accessTokens.get(accessToken);
    if (!uid) throw new PhoneGatewayError('session_invalid');
    if (
      this.users.some((x) => x.phone === this.toStored(e164) && x.uid !== uid)
    ) {
      throw new PhoneGatewayError('phone_taken');
    }
    this.users.find((x) => x.uid === uid)!.pendingPhone = this.toStored(e164);
    this.codes.set(`phone_change:${e164}`, this.nextCode);
    this.smsSent.push({ type: 'phone_change', e164 });
    return Promise.resolve();
  }

  verifyPhoneChangeOtp(
    e164: string,
    code: string,
  ): Promise<{ supabaseUid: string }> {
    this.maybeFail('verify');
    if (this.codes.get(`phone_change:${e164}`) !== code)
      throw new PhoneGatewayError('otp_rejected');
    this.codes.delete(`phone_change:${e164}`);
    const u = this.users.find((x) => x.pendingPhone === this.toStored(e164))!;
    u.phone = u.pendingPhone!;
    u.confirmed = true;
    delete u.pendingPhone;
    return Promise.resolve({ supabaseUid: u.uid });
  }

  refreshSession(refreshToken: string): Promise<PhoneSession> {
    this.maybeFail('refresh');
    const uid = this.refreshTokens.get(refreshToken);
    if (!uid) throw new PhoneGatewayError('session_invalid');
    this.refreshTokens.delete(refreshToken); // ใช้ได้ครั้งเดียว
    return Promise.resolve(this.session(uid));
  }
}

// ─── Prisma ปลอม (เฉพาะที่ PhoneAuthService ใช้) ────────────────────────────

interface UserRow {
  id: string;
  supabaseUid: string;
  email: string | null;
  phone: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  address: string | null;
  subDistrict: string | null;
  district: string | null;
  province: string | null;
  postalCode: string | null;
  bio: string | null;
  role: number;
  isActive: boolean;
  is_deleted: boolean;
  must_change_password: boolean;
  emailPreferences: boolean;
  createdAt: Date;
  updatedAt: Date;
  firstName: string | null;
  lastName: string | null;
  last_login_at?: Date;
  caregiver?: { caregiverNumber?: string; kycStatus: string };
}

class FakeDb {
  users: UserRow[] = [];
  consents: Array<Record<string, unknown>> = [];

  row(over: Partial<UserRow>): UserRow {
    const now = new Date(T0);
    return {
      id: `user-${this.users.length + 1}`,
      supabaseUid: 'sb-x',
      email: null,
      phone: null,
      displayName: null,
      avatarUrl: null,
      address: null,
      subDistrict: null,
      district: null,
      province: null,
      postalCode: null,
      bio: null,
      role: 1,
      isActive: true,
      is_deleted: false,
      must_change_password: false,
      emailPreferences: true,
      createdAt: now,
      updatedAt: now,
      firstName: null,
      lastName: null,
      ...over,
    };
  }

  private userApi = {
    findUnique: jest.fn(
      ({ where }: { where: { id?: string; supabaseUid?: string } }) =>
        Promise.resolve(
          this.users.find((u) =>
            where.id !== undefined
              ? u.id === where.id
              : u.supabaseUid === where.supabaseUid,
          ) ?? null,
        ),
    ),
    findFirst: jest.fn(
      ({
        where,
      }: {
        where: { phone: { in: string[] }; is_deleted: boolean };
      }) =>
        Promise.resolve(
          this.users.find(
            (u) =>
              u.phone !== null &&
              where.phone.in.includes(u.phone) &&
              !u.is_deleted,
          ) ?? null,
        ),
    ),
    update: jest.fn(
      ({ where, data }: { where: { id: string }; data: Partial<UserRow> }) => {
        const u = this.users.find((x) => x.id === where.id)!;
        Object.assign(u, data);
        return Promise.resolve(u);
      },
    ),
    create: jest.fn(
      ({
        data,
      }: {
        data: Partial<UserRow> & {
          caregiver?: { create: UserRow['caregiver'] };
        };
      }) => {
        if (this.users.some((u) => u.supabaseUid === data.supabaseUid)) {
          // รูปเดียวกับ PrismaClientKnownRequestError ของ unique ชน
          return Promise.reject(
            Object.assign(new Error('Unique constraint failed'), {
              code: 'P2002',
              meta: { target: ['supabaseUid'] },
            }),
          );
        }
        const { caregiver, ...rest } = data;
        const row = this.row({ ...rest, caregiver: caregiver?.create });
        this.users.push(row);
        return Promise.resolve(row);
      },
    ),
  };

  prisma = {
    user: this.userApi,
    user_consents: {
      createMany: jest.fn(
        ({ data }: { data: Array<Record<string, unknown>> }) => {
          this.consents.push(...data);
          return Promise.resolve({ count: data.length });
        },
      ),
    },
    $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      // ทรานแซคชันจำลอง: ล้มกลางทาง = ลบเฉพาะแถวที่ทรานแซคชัน "นี้" เขียน
      // (ไม่ใช้ snapshot ทั้งตาราง — ทรานแซคชันที่รันพร้อมกันจะลบข้อมูลของกันและกัน)
      const addedUsers: UserRow[] = [];
      const addedConsents: Array<Record<string, unknown>> = [];
      const tx = {
        user: {
          ...this.userApi,
          create: async (args: Parameters<typeof this.userApi.create>[0]) => {
            const row = await this.userApi.create(args);
            addedUsers.push(row);
            return row;
          },
        },
        user_consents: {
          createMany: async ({
            data,
          }: {
            data: Array<Record<string, unknown>>;
          }) => {
            addedConsents.push(...data);
            return this.prisma.user_consents.createMany({ data });
          },
        },
      };
      try {
        return await cb(tx);
      } catch (err) {
        this.users = this.users.filter((u) => !addedUsers.includes(u));
        this.consents = this.consents.filter((c) => !addedConsents.includes(c));
        throw err;
      }
    }),
  };
}

// ─── ตัวช่วย ─────────────────────────────────────────────────────────────────

/** รันแล้วต้อง throw error ที่มี extensions.code นี้ — คืน error ไว้ตรวจต่อ */
async function expectCode(
  promise: Promise<unknown>,
  code: string,
): Promise<GraphQLError> {
  const err = await promise.then(
    () => {
      throw new Error(`คาดว่าจะได้ ${code} แต่สำเร็จ`);
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(GraphQLError);
  expect((err as GraphQLError).extensions.code).toBe(code);
  return err as GraphQLError;
}

describe('PhoneAuthService (PYG-603)', () => {
  let now: number;
  let db: FakeDb;
  let supabase: FakeSupabase;
  let service: PhoneAuthService;
  let config: PhoneAuthConfig;
  let generateCaregiverNumber: jest.Mock;
  let logLines: string[];

  function build(overrides: Partial<PhoneAuthConfig> = {}) {
    config = { ...PHONE_AUTH_DEFAULTS, ...overrides };
    const tokens = new PhoneVerificationTokenService({
      get: (k: string) =>
        k === PHONE_VERIFICATION_TOKEN_SECRET_ENV
          ? 'unit-test-secret-at-least-32-characters'
          : undefined,
    } as unknown as ConfigService);
    const prisma = db.prisma as unknown as PrismaService;
    service = new PhoneAuthService(
      prisma,
      supabase,
      new PhoneOtpTracker(config),
      tokens,
      new ConsentService(prisma),
      { generateCaregiverNumber } as unknown as CaregiverService,
      new UserService(prisma, new ConsentService(prisma)),
      config,
    );
  }

  const advance = (seconds: number) => {
    now += seconds * 1000;
  };
  const request = (
    purpose: PhoneOtpPurpose,
    phone = PHONE,
    ip: string | null = IP,
  ) => service.requestOtp({ phone, purpose }, { ip, caller: null });

  /** ผู้ใช้เดิมที่ล็อกอินด้วยอีเมล (มีบัญชี Supabase ที่ไม่มีเบอร์) */
  function existingEmailUser(over: Partial<UserRow> = {}): {
    row: UserRow;
    caller: AuthUser;
    token: string;
  } {
    const uid = `sb-email-${db.users.length + 1}`;
    supabase.users.push({ uid, phone: null, confirmed: false });
    const row = db.row({
      supabaseUid: uid,
      email: `user${db.users.length + 1}@example.com`,
      ...over,
    });
    db.users.push(row);
    const token = `access-of-${uid}`;
    supabase.accessTokens.set(token, uid);
    return {
      row,
      token,
      caller: {
        id: row.id,
        supabaseUid: uid,
        email: row.email,
        role: row.role,
        isSuspended: false,
      },
    };
  }

  /** สมัครด้วยเบอร์ครบ flow → คืนผลของ signUpWithPhone */
  async function signUpFlow(phone = PHONE, role = 1) {
    await request(PhoneOtpPurpose.SIGNUP, phone);
    const { verificationToken } = await service.verifySignupOtp({
      phone,
      code: CODE,
      purpose: PhoneOtpPurpose.SIGNUP,
    });
    return service.signUp(
      { verificationToken, role, consents: VALID_CONSENTS },
      EVIDENCE,
    );
  }

  beforeEach(() => {
    now = T0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    // เก็บทุกบรรทัดที่ service log ไว้ตรวจ R10 (ห้ามมีรหัส / เบอร์เต็ม)
    logLines = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          logLines.push(JSON.stringify(args));
        });
    }
    db = new FakeDb();
    supabase = new FakeSupabase(db);
    generateCaregiverNumber = jest.fn().mockResolvedValue('CG-20261016-001');
    build();
  });

  afterEach(() => jest.restoreAllMocks());

  // ═══ AC1 / AC2 — สมัครด้วยเบอร์โดยไม่มีอีเมล และต้องยืนยันก่อน ═══════════════

  describe('S07-AC1 สมัครด้วยเบอร์ได้โดยไม่ต้องมีอีเมล', () => {
    it('ครบ flow: ขอรหัส → ยืนยัน → ยอมรับเงื่อนไข → ได้บัญชีที่ไม่มีอีเมล + session', async () => {
      const otp = await request(PhoneOtpPurpose.SIGNUP);
      expect(otp).toEqual({
        resendAfterSeconds: config.resendCooldownSeconds,
        expiresInSeconds: config.otpExpiresSeconds,
      });
      expect(otp).not.toHaveProperty('code'); // R10: ไม่มีรหัสใน response

      const verified = await service.verifySignupOtp({
        phone: PHONE,
        code: CODE,
        purpose: PhoneOtpPurpose.SIGNUP,
      });
      expect(verified.expiresInSeconds).toBe(
        config.verificationTokenTtlSeconds,
      );

      advance(10 * 60); // อ่านเงื่อนไข 10 นาที — รหัส OTP หมดอายุไปนานแล้ว แต่ตั๋วยังใช้ได้
      const result = await service.signUp(
        {
          verificationToken: verified.verificationToken,
          role: 1,
          consents: VALID_CONSENTS,
        },
        EVIDENCE,
      );

      expect(result.accessToken).toMatch(/^access-/);
      expect(result.refreshToken).toMatch(/^refresh-/);
      expect(result.user).toMatchObject({
        email: null,
        phone: NATIONAL,
        role: 1,
        isActive: true,
      });
      expect(db.users).toHaveLength(1);
      expect(db.users[0]).toMatchObject({
        email: null,
        phone: NATIONAL,
        displayName: null,
      });
    });

    it('บันทึกความยินยอมครบทุกข้อพร้อมหลักฐาน (source = register) ในทรานแซคชันเดียวกับ users', async () => {
      await signUpFlow();
      expect(db.prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(db.consents).toHaveLength(3);
      expect(db.consents[0]).toMatchObject({
        user_id: db.users[0].id,
        source: CONSENT_SOURCE.REGISTER,
        ip_address: IP,
        user_agent: 'jest/1.0',
      });
    });

    it('สมัครเป็นผู้ดูแล (role 2) ได้แถว caregivers พร้อมเลขผู้ดูแล', async () => {
      await signUpFlow(PHONE, 2);
      expect(db.users[0].caregiver).toEqual({
        caregiverNumber: 'CG-20261016-001',
        kycStatus: 'none',
      });
    });

    it('ขาดความยินยอมข้อบังคับ → CONSENT_REQUIRED · ไม่สร้างบัญชี และไม่แตะ refresh token', async () => {
      await request(PhoneOtpPurpose.SIGNUP);
      const { verificationToken } = await service.verifySignupOtp({
        phone: PHONE,
        code: CODE,
        purpose: PhoneOtpPurpose.SIGNUP,
      });
      const refresh = jest.spyOn(supabase, 'refreshSession');
      await expectCode(
        service.signUp(
          { verificationToken, role: 1, consents: [VALID_CONSENTS[0]] },
          EVIDENCE,
        ),
        CONSENT_ERROR.REQUIRED,
      );
      expect(db.users).toHaveLength(0);
      expect(refresh).not.toHaveBeenCalled();
    });
  });

  describe('S07-AC2 / E12 เบอร์ต้องผ่านการยืนยันก่อนใช้งานบัญชี', () => {
    it('E12: ขอรหัสแล้วไม่ยืนยัน หรือยืนยันแล้วไม่ยอมรับเงื่อนไข → ไม่มีแถวใน users · สมัครใหม่ได้', async () => {
      await request(PhoneOtpPurpose.SIGNUP);
      expect(db.users).toHaveLength(0);

      await service.verifySignupOtp({
        phone: PHONE,
        code: CODE,
        purpose: PhoneOtpPurpose.SIGNUP,
      });
      expect(db.users).toHaveLength(0); // ยืนยันแล้วแต่ยังไม่สร้างบัญชี

      advance(config.resendCooldownSeconds);
      await expect(request(PhoneOtpPurpose.SIGNUP)).resolves.toBeDefined(); // เบอร์นี้สมัครใหม่ได้
      const result = await service.signUp(
        {
          verificationToken: (
            await service.verifySignupOtp({
              phone: PHONE,
              code: CODE,
              purpose: PhoneOtpPurpose.SIGNUP,
            })
          ).verificationToken,
          role: 1,
          consents: VALID_CONSENTS,
        },
        EVIDENCE,
      );
      expect(result.user.phone).toBe(NATIONAL);
      expect(db.users).toHaveLength(1);
    });

    it('ตั๋วปลอม / หมดอายุ → PHONE_VERIFICATION_EXPIRED', async () => {
      await expectCode(
        service.signUp(
          { verificationToken: 'v1.fake', role: 1, consents: VALID_CONSENTS },
          EVIDENCE,
        ),
        PHONE_AUTH_ERROR.PHONE_VERIFICATION_EXPIRED,
      );

      await request(PhoneOtpPurpose.SIGNUP);
      const { verificationToken } = await service.verifySignupOtp({
        phone: PHONE,
        code: CODE,
        purpose: PhoneOtpPurpose.SIGNUP,
      });
      advance(config.verificationTokenTtlSeconds);
      await expectCode(
        service.signUp(
          { verificationToken, role: 1, consents: VALID_CONSENTS },
          EVIDENCE,
        ),
        PHONE_AUTH_ERROR.PHONE_VERIFICATION_EXPIRED,
      );
      expect(db.users).toHaveLength(0);
    });

    it('refresh token ใช้ไม่ได้แล้ว → PHONE_VERIFICATION_EXPIRED (ให้ยืนยันเบอร์ใหม่)', async () => {
      await request(PhoneOtpPurpose.SIGNUP);
      const { verificationToken } = await service.verifySignupOtp({
        phone: PHONE,
        code: CODE,
        purpose: PhoneOtpPurpose.SIGNUP,
      });
      supabase.refreshTokens.clear();
      await expectCode(
        service.signUp(
          { verificationToken, role: 1, consents: VALID_CONSENTS },
          EVIDENCE,
        ),
        PHONE_AUTH_ERROR.PHONE_VERIFICATION_EXPIRED,
      );
    });

    it('verifyPhoneOtp รับเฉพาะ SIGNUP → อย่างอื่นได้ BAD_USER_INPUT', async () => {
      await expectCode(
        service.verifySignupOtp({
          phone: PHONE,
          code: CODE,
          purpose: PhoneOtpPurpose.LOGIN,
        }),
        'BAD_USER_INPUT',
      );
    });
  });

  // ═══ AC3 — 1 เบอร์ 1 บัญชี ═══════════════════════════════════════════════════

  describe('S07-AC3 เบอร์หนึ่งเบอร์ใช้ได้กับบัญชีเดียว', () => {
    it('E4: สมัครด้วยเบอร์ที่ยืนยันแล้วของบัญชีอื่น → PHONE_ALREADY_IN_USE ตอนขอรหัส · ไม่เสียค่า SMS', async () => {
      await signUpFlow();
      advance(config.resendCooldownSeconds);
      supabase.smsSent = [];
      await expectCode(
        request(PhoneOtpPurpose.SIGNUP),
        PHONE_AUTH_ERROR.PHONE_ALREADY_IN_USE,
      );
      expect(supabase.smsSent).toHaveLength(0);
    });

    it('ส่งตั๋วเดิมซ้ำหลังสมัครเสร็จ → PHONE_ALREADY_IN_USE และไม่แตะ refresh token (กัน Supabase เพิกถอน session)', async () => {
      await request(PhoneOtpPurpose.SIGNUP);
      const { verificationToken } = await service.verifySignupOtp({
        phone: PHONE,
        code: CODE,
        purpose: PhoneOtpPurpose.SIGNUP,
      });
      await service.signUp(
        { verificationToken, role: 1, consents: VALID_CONSENTS },
        EVIDENCE,
      );

      const refresh = jest.spyOn(supabase, 'refreshSession');
      await expectCode(
        service.signUp(
          { verificationToken, role: 1, consents: VALID_CONSENTS },
          EVIDENCE,
        ),
        PHONE_AUTH_ERROR.PHONE_ALREADY_IN_USE,
      );
      expect(refresh).not.toHaveBeenCalled();
      expect(db.users).toHaveLength(1);
    });

    it('สองคำขอสมัครด้วยเบอร์เดียวกันพร้อมกัน → ได้บัญชีเดียว อีกคำขอได้ PHONE_ALREADY_IN_USE', async () => {
      await request(PhoneOtpPurpose.SIGNUP);
      const { verificationToken } = await service.verifySignupOtp({
        phone: PHONE,
        code: CODE,
        purpose: PhoneOtpPurpose.SIGNUP,
      });
      // ทั้งสองคำขอผ่านการเช็ค "สมัครไปแล้วหรือยัง" ก่อนอีกคำขอเขียน → ไปชน unique ของ supabase_uid
      const rt = [...supabase.refreshTokens.keys()][0];
      const uid = supabase.refreshTokens.get(rt)!;
      jest.spyOn(supabase, 'refreshSession').mockImplementation(() =>
        Promise.resolve({
          supabaseUid: uid,
          accessToken: 'a',
          refreshToken: 'r',
        }),
      );

      const results = await Promise.allSettled([
        service.signUp(
          { verificationToken, role: 1, consents: VALID_CONSENTS },
          EVIDENCE,
        ),
        service.signUp(
          { verificationToken, role: 1, consents: VALID_CONSENTS },
          EVIDENCE,
        ),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0].reason as GraphQLError).extensions.code).toBe(
        PHONE_AUTH_ERROR.PHONE_ALREADY_IN_USE,
      );
      expect(db.users).toHaveLength(1);
      expect(db.consents).toHaveLength(3); // ทรานแซคชันที่ล้มไม่ทิ้ง consent ค้าง
    });

    it('E2: เบอร์ที่ผู้ใช้เดิมกรอกไว้ในโปรไฟล์แต่ยังไม่ยืนยัน ไม่กันคนอื่นสมัคร (คนที่ยืนยันได้ก่อนได้เบอร์)', async () => {
      existingEmailUser({ phone: NATIONAL });
      await expect(signUpFlow()).resolves.toBeDefined();
    });
  });

  // ═══ AC4 / AC5 — ล็อกอินด้วยเบอร์ ═════════════════════════════════════════

  describe('S07-AC4 ล็อกอินด้วยเบอร์ที่ยืนยันแล้ว', () => {
    it('ได้ AuthPayload รูปเดียวกับ login อีเมล (S07-AC5) + บันทึก last_login_at', async () => {
      await signUpFlow();
      advance(config.resendCooldownSeconds);

      await request(PhoneOtpPurpose.LOGIN);
      const result = await service.login({ phone: '081-234-5678', code: CODE }); // พิมพ์รูปไหนก็ได้ (R4)

      expect(result.accessToken).toMatch(/^access-/);
      expect(result.user).toMatchObject({
        id: db.users[0].id,
        email: null,
        phone: NATIONAL,
        role: 1,
        isActive: true,
        isSuspended: false,
        mustChangePassword: false,
      });
      expect(db.users[0].last_login_at).toBeInstanceOf(Date);
    });

    it('E6: เบอร์ที่ไม่มีบัญชี → PHONE_NOT_REGISTERED ตอนขอรหัส · ไม่ส่ง SMS', async () => {
      await expectCode(
        request(PhoneOtpPurpose.LOGIN),
        PHONE_AUTH_ERROR.PHONE_NOT_REGISTERED,
      );
      expect(supabase.smsSent).toHaveLength(0);
    });

    it('E1: เบอร์อยู่ในโปรไฟล์ของผู้ใช้เดิมแต่ยังไม่ยืนยัน → PHONE_NOT_VERIFIED · ไม่ส่ง SMS', async () => {
      existingEmailUser({ phone: NATIONAL });
      await expectCode(
        request(PhoneOtpPurpose.LOGIN),
        PHONE_AUTH_ERROR.PHONE_NOT_VERIFIED,
      );
      expect(supabase.smsSent).toHaveLength(0);
    });

    it('สมัครค้างไว้ (ยืนยันเบอร์แล้วแต่ไม่สร้างบัญชี) → ล็อกอินไม่ได้ PHONE_NOT_REGISTERED', async () => {
      await request(PhoneOtpPurpose.SIGNUP);
      await service.verifySignupOtp({
        phone: PHONE,
        code: CODE,
        purpose: PhoneOtpPurpose.SIGNUP,
      });
      advance(config.resendCooldownSeconds);
      await expectCode(
        request(PhoneOtpPurpose.LOGIN),
        PHONE_AUTH_ERROR.PHONE_NOT_REGISTERED,
      );
    });
  });

  // ═══ AC6 — ผูกเบอร์ ═══════════════════════════════════════════════════════════

  describe('S07-AC6 ผู้ใช้เดิมผูกเบอร์โทรศัพท์เพิ่มกับบัญชีได้', () => {
    it('ผูกสำเร็จ → users.phone เป็นเบอร์ที่ผูก, phoneVerified = true, อีเมลเดิมไม่เปลี่ยน แล้วล็อกอินด้วยเบอร์ได้', async () => {
      const { row, caller, token } = existingEmailUser({ phone: '0899999999' });
      const email = row.email;
      await service.requestOtp(
        { phone: PHONE, purpose: PhoneOtpPurpose.LINK },
        { ip: IP, caller: { user: caller, accessToken: token } },
      );
      expect(supabase.smsSent).toEqual([{ type: 'phone_change', e164: PHONE }]);
      expect(await service.isPhoneVerified(row.id, row.phone)).toBe(false); // ยังไม่ยืนยัน

      const updated = await service.link(caller, { phone: PHONE, code: CODE });
      expect(updated).toMatchObject({ id: row.id, phone: NATIONAL, email });
      expect(await service.isPhoneVerified(row.id, updated.phone)).toBe(true);

      advance(config.resendCooldownSeconds);
      await request(PhoneOtpPurpose.LOGIN);
      const login = await service.login({ phone: PHONE, code: CODE });
      expect(login.user.id).toBe(row.id); // บัญชีเดิม ไม่ใช่บัญชีใหม่
    });

    it('E5: ผูกเบอร์ที่เป็นของบัญชีอื่นอยู่แล้ว → PHONE_ALREADY_IN_USE · ไม่ส่ง SMS', async () => {
      await signUpFlow();
      advance(config.resendCooldownSeconds);
      supabase.smsSent = [];
      const { caller, token } = existingEmailUser();
      await expectCode(
        service.requestOtp(
          { phone: PHONE, purpose: PhoneOtpPurpose.LINK },
          { ip: IP, caller: { user: caller, accessToken: token } },
        ),
        PHONE_AUTH_ERROR.PHONE_ALREADY_IN_USE,
      );
      expect(supabase.smsSent).toHaveLength(0);
    });

    it('R6: รหัสที่ยืนยันได้เป็นของการผูกเบอร์ของผู้ใช้อื่น → OTP_INVALID ไม่แตะบัญชีผู้เรียก', async () => {
      const owner = existingEmailUser();
      const intruder = existingEmailUser();
      await service.requestOtp(
        { phone: PHONE, purpose: PhoneOtpPurpose.LINK },
        { ip: IP, caller: { user: owner.caller, accessToken: owner.token } },
      );
      await expectCode(
        service.link(intruder.caller, { phone: PHONE, code: CODE }),
        PHONE_AUTH_ERROR.OTP_INVALID,
      );
      expect(db.users.find((u) => u.id === intruder.row.id)!.phone).toBeNull();
    });

    it('LINK ต้องมีผู้เรียกที่ล็อกอินอยู่', async () => {
      await expect(request(PhoneOtpPurpose.LINK)).rejects.toThrow(
        'Missing authorization token',
      );
    });

    it('ผูกเบอร์ที่เป็นของตัวเองอยู่แล้ว → ตอบทันที (ไม่รอ SMS ที่ไม่มีวันมา) และซ่อมเบอร์ในโปรไฟล์', async () => {
      const { row, caller, token } = existingEmailUser();
      await service.requestOtp(
        { phone: PHONE, purpose: PhoneOtpPurpose.LINK },
        { ip: IP, caller: { user: caller, accessToken: token } },
      );
      await service.link(caller, { phone: PHONE, code: CODE });
      db.users.find((u) => u.id === row.id)!.phone = '0899999999'; // แก้โปรไฟล์ทีหลัง
      advance(config.resendCooldownSeconds);
      supabase.smsSent = [];

      const err = await expectCode(
        service.requestOtp(
          { phone: PHONE, purpose: PhoneOtpPurpose.LINK },
          { ip: IP, caller: { user: caller, accessToken: token } },
        ),
        PHONE_AUTH_ERROR.PHONE_ALREADY_IN_USE,
      );
      expect(err.message).toContain('บัญชีของคุณ');
      expect(supabase.smsSent).toHaveLength(0);
      expect(db.users.find((u) => u.id === row.id)!.phone).toBe(NATIONAL);
    });

    it('phoneVerified = false เมื่อเบอร์ในโปรไฟล์ไม่ใช่เบอร์ที่ยืนยัน / ไม่มีเบอร์', async () => {
      const { row } = existingEmailUser({ phone: NATIONAL });
      expect(await service.isPhoneVerified(row.id, row.phone)).toBe(false);
      expect(await service.isPhoneVerified(row.id, null)).toBe(false);
    });
  });

  // ═══ AC7 — ข้อความแจ้งที่ชัดเจน (error code แยกกรณี) ══════════════════════════

  describe('S07-AC7 เบอร์ผิดรูปแบบหรือรหัสผิดได้ error code ที่แยกกรณี', () => {
    it.each([['02-123-4567'], ['+14155552671'], ['abc'], ['']])(
      'R7: เบอร์ผิดรูปแบบ "%s" → PHONE_INVALID_FORMAT ก่อนเรียก Supabase',
      async (bad) => {
        const find = jest.spyOn(supabase, 'findAccountByPhone');
        await expectCode(
          request(PhoneOtpPurpose.SIGNUP, bad),
          PHONE_AUTH_ERROR.PHONE_INVALID_FORMAT,
        );
        await expectCode(
          service.login({ phone: bad, code: CODE }),
          PHONE_AUTH_ERROR.PHONE_INVALID_FORMAT,
        );
        expect(find).not.toHaveBeenCalled();
        expect(supabase.smsSent).toHaveLength(0);
      },
    );

    it('รหัสผิด → OTP_INVALID · รหัสผิดรูปแบบก็นับเป็นกรอกผิดโดยไม่เรียก Supabase', async () => {
      await request(PhoneOtpPurpose.SIGNUP);
      await expectCode(
        service.verifySignupOtp({
          phone: PHONE,
          code: WRONG,
          purpose: PhoneOtpPurpose.SIGNUP,
        }),
        PHONE_AUTH_ERROR.OTP_INVALID,
      );
      const verify = jest.spyOn(supabase, 'verifySmsOtp');
      await expectCode(
        service.verifySignupOtp({
          phone: PHONE,
          code: '12ab',
          purpose: PhoneOtpPurpose.SIGNUP,
        }),
        PHONE_AUTH_ERROR.OTP_INVALID,
      );
      expect(verify).not.toHaveBeenCalled();
    });
  });

  // ═══ E7–E11 — อายุรหัส / ขอใหม่ / กรอกผิดเกิน / ขอถี่ / SMS ล้ม ═══════════════

  describe('รหัสยืนยัน (R8, E7–E11)', () => {
    it('E7: รหัสหมดอายุ → OTP_EXPIRED แล้วขอรหัสใหม่ได้', async () => {
      await request(PhoneOtpPurpose.SIGNUP);
      advance(config.otpExpiresSeconds);
      await expectCode(
        service.verifySignupOtp({
          phone: PHONE,
          code: WRONG,
          purpose: PhoneOtpPurpose.SIGNUP,
        }),
        PHONE_AUTH_ERROR.OTP_EXPIRED,
      );
      await expect(request(PhoneOtpPurpose.SIGNUP)).resolves.toBeDefined();
    });

    it('E8: ขอรหัสใหม่แล้วใช้รหัสเก่า → OTP_INVALID · รหัสใหม่ใช้ได้', async () => {
      await request(PhoneOtpPurpose.SIGNUP); // รหัส 123456
      advance(config.resendCooldownSeconds);
      supabase.nextCode = '654321';
      await request(PhoneOtpPurpose.SIGNUP);
      await expectCode(
        service.verifySignupOtp({
          phone: PHONE,
          code: CODE,
          purpose: PhoneOtpPurpose.SIGNUP,
        }),
        PHONE_AUTH_ERROR.OTP_INVALID,
      );
      await expect(
        service.verifySignupOtp({
          phone: PHONE,
          code: '654321',
          purpose: PhoneOtpPurpose.SIGNUP,
        }),
      ).resolves.toHaveProperty('verificationToken');
    });

    it('E9: กรอกผิดครบจำนวน → OTP_ATTEMPTS_EXCEEDED ตั้งแต่ครั้งสุดท้าย และรหัสถูกก็ใช้ไม่ได้อีก', async () => {
      build({ maxAttempts: 3 });
      await request(PhoneOtpPurpose.SIGNUP);
      const attempt = (code: string) =>
        service.verifySignupOtp({
          phone: PHONE,
          code,
          purpose: PhoneOtpPurpose.SIGNUP,
        });

      await expectCode(attempt(WRONG), PHONE_AUTH_ERROR.OTP_INVALID);
      await expectCode(attempt(WRONG), PHONE_AUTH_ERROR.OTP_INVALID);
      await expectCode(attempt(WRONG), PHONE_AUTH_ERROR.OTP_ATTEMPTS_EXCEEDED);

      const verify = jest.spyOn(supabase, 'verifySmsOtp');
      await expectCode(attempt(CODE), PHONE_AUTH_ERROR.OTP_ATTEMPTS_EXCEEDED);
      expect(verify).not.toHaveBeenCalled();
      // ★ เดาสลับไปทาง loginWithPhone ก็ไม่ได้ครั้งเพิ่ม (รหัสชนิดเดียวกันของ Supabase)
      await expectCode(
        service.login({ phone: PHONE, code: CODE }),
        PHONE_AUTH_ERROR.OTP_ATTEMPTS_EXCEEDED,
      );
    });

    it('E10: ขอถี่เกิน → OTP_RATE_LIMITED + resendAfterSeconds (วินาทีที่เหลือจริง) · ไม่ส่ง SMS ซ้ำ', async () => {
      await request(PhoneOtpPurpose.SIGNUP);
      advance(18);
      const err = await expectCode(
        request(PhoneOtpPurpose.SIGNUP),
        PHONE_AUTH_ERROR.OTP_RATE_LIMITED,
      );
      expect(err.extensions.resendAfterSeconds).toBe(
        config.resendCooldownSeconds - 18,
      );
      expect(supabase.smsSent).toHaveLength(1);
    });

    it('E10: เพดานต่อ IP กันการยิงขอรหัสไปหลายเบอร์', async () => {
      build({ maxSendsPerIpPerHour: 2 });
      await request(PhoneOtpPurpose.SIGNUP, '0811111111');
      await request(PhoneOtpPurpose.SIGNUP, '0822222222');
      await expectCode(
        request(PhoneOtpPurpose.SIGNUP, '0833333333'),
        PHONE_AUTH_ERROR.OTP_RATE_LIMITED,
      );
      expect(supabase.smsSent).toHaveLength(2);
    });

    it('กดขอรหัสซ้ำพร้อมกัน → SMS ออกข้อความเดียว อีกคำขอได้ OTP_RATE_LIMITED', async () => {
      const results = await Promise.allSettled([
        request(PhoneOtpPurpose.SIGNUP),
        request(PhoneOtpPurpose.SIGNUP),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(supabase.smsSent).toHaveLength(1);
    });

    it('E11: ส่ง SMS ไม่สำเร็จ → SMS_SEND_FAILED · กดขอใหม่ได้ทันที (ไม่กินโควตา)', async () => {
      supabase.failNext.send = 'sms_failed';
      await expectCode(
        request(PhoneOtpPurpose.SIGNUP),
        PHONE_AUTH_ERROR.SMS_SEND_FAILED,
      );
      await expect(request(PhoneOtpPurpose.SIGNUP)).resolves.toBeDefined();
    });

    it('E11: Supabase ล่มระหว่างตรวจรหัส → INTERNAL_SERVER_ERROR และไม่นับเป็นการกรอกผิด', async () => {
      build({ maxAttempts: 1 });
      await request(PhoneOtpPurpose.SIGNUP);
      supabase.failNext.verify = 'unavailable';
      await expectCode(
        service.verifySignupOtp({
          phone: PHONE,
          code: CODE,
          purpose: PhoneOtpPurpose.SIGNUP,
        }),
        'INTERNAL_SERVER_ERROR',
      );
      // ถ้านับเป็นการกรอกผิด ครั้งนี้จะได้ OTP_ATTEMPTS_EXCEEDED (maxAttempts = 1)
      await expect(
        service.verifySignupOtp({
          phone: PHONE,
          code: CODE,
          purpose: PhoneOtpPurpose.SIGNUP,
        }),
      ).resolves.toHaveProperty('verificationToken');
    });

    it('Supabase จำกัดความถี่เอง → OTP_RATE_LIMITED พร้อมเวลาที่ Supabase บอก', async () => {
      supabase.failNext.send = 'rate_limited';
      const err = await expectCode(
        request(PhoneOtpPurpose.SIGNUP),
        PHONE_AUTH_ERROR.OTP_RATE_LIMITED,
      );
      expect(err.extensions.resendAfterSeconds).toBe(30);
    });
  });

  // ═══ R10 — ไม่มีรหัส / เบอร์เต็ม ใน log และ error ═══════════════════════════

  describe('R10 ไม่เขียนรหัสหรือเบอร์เต็มลง log และไม่ส่งรหัสกลับ', () => {
    it('ทั้ง flow สำเร็จและล้มเหลว ไม่มีรหัส ตั๋ว หรือเบอร์เต็มใน log / error message', async () => {
      const errors: string[] = [];
      const capture = (p: Promise<unknown>) =>
        p.catch((e: Error) => errors.push(e.message));

      await signUpFlow();
      advance(config.resendCooldownSeconds);
      await request(PhoneOtpPurpose.LOGIN);
      await capture(service.login({ phone: PHONE, code: WRONG }));
      await service.login({ phone: PHONE, code: CODE });
      supabase.failNext.send = 'sms_failed';
      advance(config.resendCooldownSeconds);
      await capture(request(PhoneOtpPurpose.LOGIN));

      const everything = [...logLines, ...errors].join('\n');
      expect(logLines.length).toBeGreaterThan(0);
      for (const secret of [
        CODE,
        WRONG,
        NATIONAL,
        '812345678',
        'refresh-',
        'access-',
      ]) {
        expect(everything).not.toContain(secret);
      }
      expect(everything).toContain('081XXX5678'); // log เบอร์แบบปิดบังได้
    });
  });
});
