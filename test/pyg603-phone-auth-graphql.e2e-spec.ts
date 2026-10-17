/**
 * PYG-603 — ทดสอบ contract ของ PYG-601 ที่ชั้น HTTP/GraphQL จริง
 *
 * unit test ของ PhoneAuthService พิสูจน์กฎทางธุรกิจแล้ว — ไฟล์นี้พิสูจน์สิ่งที่ unit test มองไม่เห็น:
 *   1. error ของ business rule ตอบ **HTTP 200 + errors[0].extensions.code** (contract §6.1 ไม่ใช่ 422)
 *   2. ValidationPipe ตั้งค่าเดียวกับ main.ts (whitelist + forbidNonWhitelisted) ยอมรับ input ทุกตัว
 *      — ไม่มี BAD_REQUEST มาตัดหน้า PHONE_INVALID_FORMAT (บทเรียนจาก PYG-415 ที่การ์ดอ้าง)
 *   3. query ของ FE (คัดลอกจาก payung_frontend/src/graphql/phoneAuth.ts ตรง ๆ) ใช้ได้กับ schema จริง
 *      รวม `purpose: SIGNUP` แบบ inline และ consents ซ้อนใน input
 *   4. requestPhoneOtp(LINK) ไม่มี token → UNAUTHENTICATED (ส่วน SIGNUP/LOGIN ไม่ต้องมี)
 *
 * mock: PhoneAuthGateway (แทน Supabase — ไม่ส่ง SMS จริง), PrismaService, SupabaseService
 * จริง: GraphQLModule (Apollo), ValidationPipe, PhoneAuthResolver, PhoneAuthService, PhoneOtpTracker,
 *       PhoneVerificationTokenService, ConsentService, SupabaseAuthGuard
 * ไม่ต่อ DB / Supabase จริง → รันได้ทุกเครื่อง
 */
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GraphQLModule, Query, Resolver } from '@nestjs/graphql';
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/common/prisma.service';
import { SupabaseService } from '../src/common/supabase.service';
import { SupabaseAuthGuard } from '../src/common/guards/supabase-auth.guard';
import { ConsentService } from '../src/consent/consent.service';
import { CONSENT_TYPE, POLICY_VERSION } from '../src/consent/consent.constants';
import { CaregiverService } from '../src/identity/kyc/caregiver.service';
import { UserService } from '../src/identity/auth/user.service';
import { PhoneAuthResolver } from '../src/identity/auth/phone/phone-auth.resolver';
import { PhoneAuthService } from '../src/identity/auth/phone/phone-auth.service';
import {
  PhoneAuthGateway,
  PhoneGatewayError,
} from '../src/identity/auth/phone/phone-auth.gateway';
import { PhoneOtpTracker } from '../src/identity/auth/phone/phone-otp-tracker';
import {
  PHONE_VERIFICATION_TOKEN_SECRET_ENV,
  PhoneVerificationTokenService,
} from '../src/identity/auth/phone/phone-verification-token.service';
import {
  PHONE_AUTH_CONFIG,
  PHONE_AUTH_DEFAULTS,
} from '../src/identity/auth/phone/phone-auth.config';

// ─── operation ของ FE — คัดลอกจาก payung_frontend/src/graphql/phoneAuth.ts (dev @ 25734e4) ───

const REQUEST_PHONE_OTP = `
  mutation RequestPhoneOtp($phone: String!, $purpose: PhoneOtpPurpose!) {
    requestPhoneOtp(input: { phone: $phone, purpose: $purpose }) {
      resendAfterSeconds
      expiresInSeconds
    }
  }
`;

const VERIFY_PHONE_OTP = `
  mutation VerifyPhoneOtp($phone: String!, $code: String!) {
    verifyPhoneOtp(input: { phone: $phone, code: $code, purpose: SIGNUP }) {
      verificationToken
      expiresInSeconds
    }
  }
`;

const SIGN_UP_WITH_PHONE = `
  mutation SignUpWithPhone(
    $verificationToken: String!
    $role: Int!
    $consents: [ConsentAnswerInput!]
  ) {
    signUpWithPhone(input: {
      verificationToken: $verificationToken
      role: $role
      consents: $consents
    }) {
      accessToken
      refreshToken
      user {
        id
        email
        phone
        role
      }
    }
  }
`;

/**
 * GraphQL บังคับให้ schema มี Query อย่างน้อย 1 ตัว — แอปจริงมีหลายตัว แต่โมดูลเทสนี้โหลดแค่
 * PhoneAuthResolver (มีแต่ mutation) จึงต้องมี query เปล่า ๆ ไว้ให้ schema สร้างได้
 */
@Resolver()
class PingResolver {
  @Query(() => String)
  ping(): string {
    return 'ok';
  }
}

/** Accept header แบบที่ Apollo Client 4 ของ FE ส่ง */
const APOLLO_CLIENT_ACCEPT =
  'application/graphql-response+json,application/json;q=0.9';

describe('PYG-603 phone auth — contract ที่ชั้น GraphQL (e2e, ไม่ต่อ DB)', () => {
  let app: INestApplication<App>;
  // แยกเป็นตัวแปรของตัวเอง (ไม่อ้างผ่าน gateway.xxx) — eslint unbound-method
  const sendSmsOtp = jest.fn().mockResolvedValue(undefined);
  const sendPhoneChangeOtp = jest.fn();

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const gateway = {
      findAccountByPhone: jest.fn().mockResolvedValue(null),
      loginPhoneStatus: jest.fn(),
      sendSmsOtp,
      verifySmsOtp: jest
        .fn()
        .mockRejectedValue(new PhoneGatewayError('otp_rejected')),
      sendPhoneChangeOtp,
      verifyPhoneChangeOtp: jest.fn(),
      refreshSession: jest.fn(),
    } as unknown as PhoneAuthGateway;

    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        GraphQLModule.forRoot<ApolloDriverConfig>({
          driver: ApolloDriver,
          autoSchemaFile: true,
          context: ({ req }: { req: unknown }) => ({ req }),
        }),
      ],
      providers: [
        PingResolver,
        PhoneAuthResolver,
        PhoneAuthService,
        PhoneVerificationTokenService,
        ConsentService,
        SupabaseAuthGuard,
        { provide: PHONE_AUTH_CONFIG, useValue: PHONE_AUTH_DEFAULTS },
        {
          provide: PhoneOtpTracker,
          useFactory: () => new PhoneOtpTracker(PHONE_AUTH_DEFAULTS),
        },
        { provide: PhoneAuthGateway, useValue: gateway },
        { provide: PrismaService, useValue: prisma },
        {
          provide: SupabaseService,
          // token ใด ๆ ใช้ไม่ได้ — เทสนี้ไม่มีผู้ใช้ที่ล็อกอิน
          useValue: {
            getClient: () => ({
              auth: {
                getUser: jest.fn().mockResolvedValue({
                  data: { user: null },
                  error: new Error('bad'),
                }),
              },
            }),
          },
        },
        { provide: CaregiverService, useValue: {} },
        { provide: UserService, useValue: { mapToEntity: (u: unknown) => u } },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === PHONE_VERIFICATION_TOKEN_SECRET_ENV
                ? 'e2e-secret-that-is-at-least-32-characters'
                : undefined,
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // ★ ตั้งค่าเดียวกับ src/main.ts ทุกตัว — จุดประสงค์หลักของไฟล์นี้
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  /** ยิง GraphQL แบบที่ FE ยิง → คืน HTTP status + body ที่ parse แล้ว */
  async function gql(
    query: string,
    variables: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) {
    const res = await request(app.getHttpServer())
      .post('/graphql')
      .set('Accept', APOLLO_CLIENT_ACCEPT)
      .set(headers)
      .send({ query, variables });
    const body = JSON.parse(res.text) as {
      data?: Record<string, unknown> | null;
      errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
    };
    return { status: res.status, body };
  }

  it('§6.1: เบอร์ผิดรูปแบบ → HTTP 200 + PHONE_INVALID_FORMAT (ไม่ใช่ 400 จาก ValidationPipe / ไม่ใช่ 422)', async () => {
    const { status, body } = await gql(REQUEST_PHONE_OTP, {
      phone: '081',
      purpose: 'SIGNUP',
    });
    expect(status).toBe(200);
    expect(body.data).toBeNull();
    expect(body.errors?.[0].extensions?.code).toBe('PHONE_INVALID_FORMAT');
    expect(sendSmsOtp).not.toHaveBeenCalled();
  });

  it('§4.1: ขอรหัสสำเร็จ → resendAfterSeconds / expiresInSeconds เป็นจำนวนวินาที ไม่มีรหัสใน response', async () => {
    const { status, body } = await gql(REQUEST_PHONE_OTP, {
      phone: '+66812345678',
      purpose: 'SIGNUP',
    });
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({
      requestPhoneOtp: { resendAfterSeconds: 60, expiresInSeconds: 60 },
    });
    expect(sendSmsOtp).toHaveBeenCalledWith('+66812345678', true);
  });

  it('§6.2: ขอซ้ำทันที → OTP_RATE_LIMITED + extensions.resendAfterSeconds เป็นตัวเลข ≥ 1', async () => {
    const { status, body } = await gql(REQUEST_PHONE_OTP, {
      phone: '0812345678',
      purpose: 'SIGNUP',
    });
    expect(status).toBe(200);
    const ext = body.errors?.[0].extensions;
    expect(ext?.code).toBe('OTP_RATE_LIMITED');
    expect(typeof ext?.resendAfterSeconds).toBe('number');
    expect(ext?.resendAfterSeconds as number).toBeGreaterThanOrEqual(1);
  });

  it('§4.2: VerifyPhoneOtp ของ FE (purpose: SIGNUP แบบ inline) ใช้ได้ · รหัสผิด → OTP_INVALID', async () => {
    const { status, body } = await gql(VERIFY_PHONE_OTP, {
      phone: '+66812345678',
      code: '000000',
    });
    expect(status).toBe(200);
    expect(body.errors?.[0].extensions?.code).toBe('OTP_INVALID');
  });

  it('§4.3: SignUpWithPhone ของ FE พร้อม consents ซ้อน ผ่าน ValidationPipe · ตั๋วปลอม → PHONE_VERIFICATION_EXPIRED', async () => {
    const { status, body } = await gql(SIGN_UP_WITH_PHONE, {
      verificationToken: 'v1.not-a-real-token',
      role: 1,
      consents: [
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
      ],
    });
    expect(status).toBe(200);
    expect(body.errors?.[0].extensions?.code).toBe(
      'PHONE_VERIFICATION_EXPIRED',
    );
  });

  it('§4.3: ไม่ส่ง consents → CONSENT_REQUIRED (ชุดเดิมของ register)', async () => {
    const { body } = await gql(SIGN_UP_WITH_PHONE, {
      verificationToken: 'v1.x',
      role: 1,
    });
    expect(body.errors?.[0].extensions?.code).toBe('CONSENT_REQUIRED');
  });

  it('§4.1: LINK ไม่มี / มี token ที่ใช้ไม่ได้ → UNAUTHENTICATED · SIGNUP/LOGIN ไม่ต้องมี token', async () => {
    const noToken = await gql(REQUEST_PHONE_OTP, {
      phone: '0899999999',
      purpose: 'LINK',
    });
    expect(noToken.body.errors?.[0].extensions?.code).toBe('UNAUTHENTICATED');

    const badToken = await gql(
      REQUEST_PHONE_OTP,
      { phone: '0899999999', purpose: 'LINK' },
      { Authorization: 'Bearer expired' },
    );
    expect(badToken.body.errors?.[0].extensions?.code).toBe('UNAUTHENTICATED');
    expect(sendPhoneChangeOtp).not.toHaveBeenCalled();
  });
});
