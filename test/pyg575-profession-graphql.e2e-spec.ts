/**
 * PYG-575 — ทดสอบ contract ของ PYG-573 ที่ชั้น HTTP/GraphQL จริง
 *
 * unit test ของ KycService / ProfessionChangeService พิสูจน์กฎทางธุรกิจแล้ว — ไฟล์นี้พิสูจน์สิ่งที่ unit test มองไม่เห็น:
 *   1. error ตอบ **HTTP 200 + errors[0].extensions.code** (contract §5.1 ไม่ใช่ 422 / 400)
 *   2. ValidationPipe ตั้งค่าเดียวกับ main.ts (whitelist + forbidNonWhitelisted) ยอมรับ `KycInput.profession`
 *      และปล่อยค่าผิดไปถึง service — ไม่มี BAD_REQUEST มาตัดหน้า PROFESSION_* (บทเรียน PYG-415)
 *   3. operation ของ FE (คัดลอกจาก payung_frontend/src/graphql/professionChange.ts + queries.ts ตรง ๆ) ใช้ได้
 *   4. guard จริง: ผู้ดูแลเรียก operation ของแอดมินไม่ได้
 *
 * mock: PrismaService, SupabaseService (token = id ผู้ใช้), service รอบข้างของ KycService
 * จริง: GraphQLModule (Apollo), ValidationPipe, KycResolver, KycService, ProfessionChangeResolver,
 *       ProfessionChangeService, AdminProfessionChangeResolver, SupabaseAuthGuard, RolesGuard
 * ไม่ต่อ DB / Supabase จริง → รันได้ทุกเครื่อง
 */
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/common/prisma.service';
import { SupabaseService } from '../src/common/supabase.service';
import { SupabaseAuthGuard } from '../src/common/guards/supabase-auth.guard';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { FieldLockGuard } from '../src/common/guards/field-lock.guard';
import { KycResolver } from '../src/identity/kyc/kyc.resolver';
import { KycService } from '../src/identity/kyc/kyc.service';
import { KycDocumentService } from '../src/identity/kyc/kyc-document.service';
import { CaregiverService } from '../src/identity/kyc/caregiver.service';
import { ProfessionChangeResolver } from '../src/identity/kyc/profession-change.resolver';
import { ProfessionChangeService } from '../src/identity/kyc/profession-change.service';
import { AdminProfessionChangeResolver } from '../src/admin/admin-profession-change.resolver';
import { NotificationService } from '../src/notification/notification.service';
import { EmailService } from '../src/email/email.service';
import { PayoutEncryptionService } from '../src/common/crypto/payout-encryption.service';
import { PayoutAccountService } from '../src/payment/payout-account.service';

// ─── operation ของ FE — คัดลอกจาก payung_frontend (dev @ d1a42a2) ──────────────

/** src/graphql/queries.ts → SUBMIT_KYC (+ profession ในผลลัพธ์ ซึ่ง FE เลือกได้หลัง BE deploy) */
const SUBMIT_KYC = `
  mutation SubmitKyc($input: KycInput!) {
    submitKyc(input: $input) {
      id
      fullName
      dateOfBirth
      gender
      kycStatus
      kycSubmittedAt
      profession
    }
  }
`;

/** src/graphql/professionChange.ts — REQUEST_FIELDS ตรงตัว */
const REQUEST_FIELDS = `
  id
  fromProfession
  toProfession
  status
  licenseNumber
  licenseExpiresAt
  licenseDocument {
    id
    fileName
    signedUrl
  }
  rejectionReason
  requestedAt
  reviewedAt
`;

const MY_PROFESSION_CHANGE_REQUEST = `
  query MyProfessionChangeRequest {
    myProfessionChangeRequest {
      ${REQUEST_FIELDS}
    }
  }
`;

const REQUEST_PROFESSION_CHANGE = `
  mutation RequestProfessionChange($input: ProfessionChangeInput!) {
    requestProfessionChange(input: $input) {
      ${REQUEST_FIELDS}
    }
  }
`;

/** ฝั่งแอดมิน — FE ยังไม่มี ใช้รูปตาม contract §4.6 */
const REJECT_PROFESSION_CHANGE = `
  mutation RejectProfessionChange($input: RejectProfessionChangeInput!) {
    rejectProfessionChangeRequest(input: $input) { id status rejectionReason }
  }
`;

/** Accept header แบบที่ Apollo Client 4 ของ FE ส่ง */
const APOLLO_CLIENT_ACCEPT =
  'application/graphql-response+json,application/json;q=0.9';

const CAREGIVER = {
  id: 'user-cg-1',
  supabaseUid: 'user-cg-1',
  email: 'cg@x.com',
  role: 2,
  isActive: true,
  is_deleted: false,
};
const ADMIN = {
  id: 'user-admin-1',
  supabaseUid: 'user-admin-1',
  email: 'ad@x.com',
  role: 3,
  isActive: true,
  is_deleted: false,
};

const KYC_INPUT = {
  fullName: 'สมใจ ใจดี',
  idCardNumber: '1234567890121', // เลขบัตรที่ check digit ถูก (ValidThaiId)
  phone: '0812345678',
  skills: ['bathing'],
  experienceYears: 3,
  bio: 'ดูแลผู้สูงอายุ',
  documentIds: [],
};

describe('PYG-575 profession — contract ที่ชั้น GraphQL (e2e, ไม่ต่อ DB)', () => {
  let app: INestApplication<App>;
  /** สถานะ KYC ที่ lockCaregiver (SELECT … FOR UPDATE) จะเห็น — แต่ละเทสตั้งเอง */
  let lockedKycStatus: string;
  const upsert = jest.fn();

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    // Nest log GraphQLError ที่ไม่ใช่ HttpException เป็น ERROR (พฤติกรรมเดิมของ ConsentError ด้วย) — ปิดให้ผลเทสอ่านง่าย
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const tx = {
      caregiver: { upsert, update: jest.fn() },
      kycDocument: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn(),
      },
      caregiverPayoutAccount: { findUnique: jest.fn(), upsert: jest.fn() },
      $executeRaw: jest.fn().mockResolvedValue(1),
      // ใช้แค่ lockCaregiver ในเทสนี้ (เทสที่ไปถึงขั้นนี้หยุดที่ NOT_ALLOWED ก่อนอ่านคำขอ)
      $queryRaw: jest.fn(() =>
        Promise.resolve([
          {
            id: 'cg-1',
            profession: 'general_caregiver',
            kyc_status: lockedKycStatus,
          },
        ]),
      ),
    };

    const prisma = {
      user: {
        // SupabaseAuthGuard: หา users จาก supabase uid (= token ในเทสนี้)
        findUnique: jest.fn(({ where }: { where: { supabaseUid: string } }) =>
          Promise.resolve(
            [CAREGIVER, ADMIN].find(
              (u) => u.supabaseUid === where.supabaseUid,
            ) ?? null,
          ),
        ),
      },
      caregiver: { findUnique: jest.fn().mockResolvedValue(null) },
      kycDocument: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
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
        KycResolver,
        KycService,
        ProfessionChangeResolver,
        ProfessionChangeService,
        AdminProfessionChangeResolver,
        SupabaseAuthGuard,
        RolesGuard,
        FieldLockGuard,
        { provide: PrismaService, useValue: prisma },
        {
          provide: SupabaseService,
          // token = supabase uid ของผู้ใช้ (ง่ายพอสำหรับเทส) · token อื่น = ไม่ผ่าน
          useValue: {
            getClient: () => ({
              auth: {
                getUser: (token: string) =>
                  Promise.resolve({
                    data: { user: { id: token } },
                    error: null,
                  }),
              },
            }),
          },
        },
        {
          provide: CaregiverService,
          useValue: {
            generateCaregiverNumber: jest
              .fn()
              .mockResolvedValue('CG-261017-0001'),
          },
        },
        { provide: KycDocumentService, useValue: {} },
        { provide: NotificationService, useValue: { create: jest.fn() } },
        { provide: EmailService, useValue: { sendKycSubmitted: jest.fn() } },
        { provide: PayoutEncryptionService, useValue: {} },
        { provide: PayoutAccountService, useValue: {} },
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

  beforeEach(() => {
    upsert.mockReset();
    lockedKycStatus = 'verified';
  });

  /** ยิง GraphQL แบบที่ FE ยิง → คืน HTTP status + body ที่ parse แล้ว */
  async function gql(
    query: string,
    variables: Record<string, unknown>,
    token: string,
  ) {
    const res = await request(app.getHttpServer())
      .post('/graphql')
      .set('Accept', APOLLO_CLIENT_ACCEPT)
      .set('Authorization', `Bearer ${token}`)
      .send({ query, variables });
    const body = JSON.parse(res.text) as {
      data?: Record<string, unknown> | null;
      errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
    };
    return { status: res.status, body };
  }

  // ─── KycInput.profession (S01-AC1 · E3 · E4) ──────────────────────────

  it('E3: SubmitKyc ของ client เก่า (ไม่มี profession) → HTTP 200 + PROFESSION_REQUIRED ไม่ใช่ 400', async () => {
    const { status, body } = await gql(
      SUBMIT_KYC,
      { input: KYC_INPUT },
      CAREGIVER.id,
    );

    expect(status).toBe(200);
    expect(body.data).toBeNull();
    expect(body.errors?.[0].extensions).toMatchObject({
      code: 'PROFESSION_REQUIRED',
      allowed: ['general_caregiver', 'nurse', 'physiotherapist'],
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('E4: ค่านอกรายการผ่าน schema + ValidationPipe ไปถึง service → PROFESSION_INVALID', async () => {
    const { status, body } = await gql(
      SUBMIT_KYC,
      { input: { ...KYC_INPUT, profession: 'doctor' } },
      CAREGIVER.id,
    );

    expect(status).toBe(200);
    expect(body.errors?.[0].extensions).toMatchObject({
      code: 'PROFESSION_INVALID',
      received: 'doctor',
    });
  });

  it('S01-AC1: ส่ง profession ถูกต้อง → forbidNonWhitelisted ยอมรับ field ใหม่ และคืน profession (enum ตัวพิมพ์เล็ก)', async () => {
    upsert.mockResolvedValueOnce({
      id: 'cg-1',
      userId: CAREGIVER.id,
      fullName: KYC_INPUT.fullName,
      idCardNumber: KYC_INPUT.idCardNumber,
      phone: KYC_INPUT.phone,
      skills: KYC_INPUT.skills,
      profession: 'physiotherapist',
      kycStatus: 'pending',
      kycSubmittedAt: new Date('2026-10-17T04:00:00Z'),
      isSearchable: false,
      languages: [],
      resubmitCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const { status, body } = await gql(
      SUBMIT_KYC,
      { input: { ...KYC_INPUT, profession: 'physiotherapist' } },
      CAREGIVER.id,
    );

    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data?.submitKyc).toMatchObject({
      kycStatus: 'pending',
      profession: 'physiotherapist',
    });
    const upsertArg = (upsert.mock.calls[0] as unknown[])[0] as {
      create: { profession: string };
    };
    expect(upsertArg.create.profession).toBe('physiotherapist');
  });

  // ─── คำขอเปลี่ยนวิชาชีพ (S01-AC6) ──────────────────────────────────────

  it('MyProfessionChangeRequest ของ FE (REQUEST_FIELDS ครบ รวม licenseDocument) ใช้ได้ · ไม่เคยขอ → null', async () => {
    const { status, body } = await gql(
      MY_PROFESSION_CHANGE_REQUEST,
      {},
      CAREGIVER.id,
    );

    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({ myProfessionChangeRequest: null });
  });

  it('RequestProfessionChange ค่าผิด → HTTP 200 + PROFESSION_INVALID (ไม่ใช่ BAD_USER_INPUT ของ enum)', async () => {
    const { status, body } = await gql(
      REQUEST_PROFESSION_CHANGE,
      { input: { profession: 'NURSE' } },
      CAREGIVER.id,
    );

    expect(status).toBe(200);
    expect(body.errors?.[0].extensions).toMatchObject({
      code: 'PROFESSION_INVALID',
      received: 'NURSE',
    });
  });

  it('E2: KYC ยังไม่อนุมัติ → PROFESSION_CHANGE_NOT_ALLOWED + kycStatus (FE ส่งผู้ใช้ไปฟอร์ม KYC)', async () => {
    lockedKycStatus = 'rejected';

    const { status, body } = await gql(
      REQUEST_PROFESSION_CHANGE,
      { input: { profession: 'nurse' } },
      CAREGIVER.id,
    );

    expect(status).toBe(200);
    expect(body.errors?.[0].extensions).toMatchObject({
      code: 'PROFESSION_CHANGE_NOT_ALLOWED',
      kycStatus: 'rejected',
    });
  });

  it('ผู้ดูแลเรียก operation ของแอดมิน → FORBIDDEN (RolesGuard จริง)', async () => {
    const { body } = await gql(
      REJECT_PROFESSION_CHANGE,
      {
        input: { id: '0b9e2f1c-7e7d-4a51-9a63-1f0b3c3f9a11', reason: 'ไม่ชัด' },
      },
      CAREGIVER.id,
    );

    expect(body.errors?.[0].extensions?.code).toBe('FORBIDDEN');
  });

  it('แอดมินปฏิเสธโดยไม่ใส่เหตุผล → BAD_REQUEST จาก DTO (กติกาเดียวกับ rejectProfilePhoto)', async () => {
    const { body } = await gql(
      REJECT_PROFESSION_CHANGE,
      { input: { id: '0b9e2f1c-7e7d-4a51-9a63-1f0b3c3f9a11', reason: '' } },
      ADMIN.id,
    );

    expect(body.errors?.[0].extensions?.code).toBe('BAD_REQUEST');
  });
});
