/**
 * PYG-581 — ทดสอบ contract ของ PYG-579 ที่ชั้น HTTP/GraphQL จริง
 *
 * unit test (src/admin/admin-care-level.spec.ts) พิสูจน์กฎทางธุรกิจแล้ว — ไฟล์นี้พิสูจน์สิ่งที่ unit test มองไม่เห็น:
 *   1. error ตอบ **HTTP 200 + errors[0].extensions.code** (contract §5.1 — ไม่ใช่ 422 / 400)
 *   2. ValidationPipe ตั้งค่าเดียวกับ main.ts (whitelist + forbidNonWhitelisted) ปล่อยค่าระดับที่ผิดไปถึง service
 *      → ได้ CARE_LEVEL_INVALID ไม่ใช่ BAD_REQUEST (บทเรียน PYG-415)
 *   3. operation ของ FE ที่มีอยู่ตอนนี้ (คัดลอกจาก payung_frontend dev @ a550a06) ยังใช้กับ schema ใหม่ได้
 *      และ APPROVE_KYC เวอร์ชันเก่า (ไม่ส่งระดับ) ได้ CARE_LEVEL_REQUIRED ที่ FE อ่านได้
 *   4. enum CareLevel ส่งออกเป็นตัวพิมพ์ใหญ่ ("ADVANCED") จากค่าใน DB ('advanced')
 *   5. guard จริง: ผู้ดูแลเรียก operation ของแอดมินไม่ได้
 *
 * mock: PrismaService (แถวผู้ดูแลแถวเดียวในหน่วยความจำ), SupabaseService (token = id ผู้ใช้), service รอบข้าง
 * จริง: GraphQLModule (Apollo), ValidationPipe, AdminResolver, AdminService, AdminCareLevelResolver,
 *       AdminCareLevelService, KycResolver, CaregiverService, SupabaseAuthGuard, RolesGuard
 * ไม่ต่อ DB / Supabase จริง → รันได้ทุกเครื่อง
 */
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import { AdminResolver } from '../src/admin/admin.resolver';
import { AdminService } from '../src/admin/admin.service';
import { AdminCareLevelResolver } from '../src/admin/admin-care-level.resolver';
import { AdminCareLevelService } from '../src/admin/admin-care-level.service';
import { KycResolver } from '../src/identity/kyc/kyc.resolver';
import { KycService } from '../src/identity/kyc/kyc.service';
import { KycDocumentService } from '../src/identity/kyc/kyc-document.service';
import { CaregiverService } from '../src/identity/kyc/caregiver.service';
import { NotificationService } from '../src/notification/notification.service';
import { EmailService } from '../src/email/email.service';
import { PayoutAccountService } from '../src/payment/payout-account.service';

// ─── operation ของ FE — คัดลอกจาก payung_frontend/src/graphql/queries.ts (dev @ a550a06) ─────

/** APPROVE_KYC ตามที่ FE ยิงอยู่ตอนนี้ — ยังไม่ส่ง careLevel */
const APPROVE_KYC_CURRENT_FE = `
  mutation ApproveKyc($caregiverId: ID!) {
    approveKyc(caregiverId: $caregiverId) {
      id
      kycStatus
      kycVerifiedAt
      updatedAt
    }
  }
`;

/** APPROVE_KYC ตาม contract §4.1 (สิ่งที่ FE PYG-582 จะเปลี่ยนไปใช้) */
const APPROVE_KYC_WITH_LEVEL = `
  mutation ApproveKyc($caregiverId: ID!, $careLevel: String) {
    approveKyc(caregiverId: $caregiverId, careLevel: $careLevel) {
      id
      kycStatus
      kycVerifiedAt
      updatedAt
      careLevel
    }
  }
`;

/** GET_CAREGIVER_PROFILE ของ FE (PROFESSION_FIELD / CUSTOM_SKILLS_FIELD เป็น "" อยู่) + careLevel ตาม contract §3 */
const GET_CAREGIVER_PROFILE = `
  query GetCaregiverProfile {
    myCaregiverProfile {
      id
      caregiverNumber
      fullName
      idCardNumber
      gender
      dateOfBirth
      phone
      address
      bio
      hourlyRate
      skills
      experienceYears
      kycStatus
      kycSubmittedAt
      kycVerifiedAt
      resubmitCount
      isSearchable
      languages
      createdAt
      updatedAt
      careLevel
    }
  }
`;

const SET_CAREGIVER_CARE_LEVEL = `
  mutation SetCaregiverCareLevel($input: SetCaregiverCareLevelInput!) {
    setCaregiverCareLevel(input: $input) {
      changed
      careLevel { caregiverId level setBy setByName setAt needsReview }
    }
  }
`;

const CAREGIVER_CARE_LEVEL_HISTORY = `
  query CaregiverCareLevelHistory($caregiverId: ID!) {
    caregiverCareLevelHistory(caregiverId: $caregiverId) {
      id oldLevel newLevel changedBy changedByName reason source createdAt
    }
  }
`;

/** Accept header แบบที่ Apollo Client 4 ของ FE ส่ง */
const APOLLO_CLIENT_ACCEPT =
  'application/graphql-response+json,application/json;q=0.9';

const CAREGIVER_ID = '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607';

const CAREGIVER_USER = {
  id: 'user-cg-1',
  supabaseUid: 'user-cg-1',
  email: 'cg@x.com',
  role: 2,
  isActive: true,
  is_deleted: false,
};
const ADMIN_USER = {
  id: 'user-admin-1',
  supabaseUid: 'user-admin-1',
  email: 'ad@x.com',
  role: 3,
  isActive: true,
  is_deleted: false,
};

describe('PYG-581 care level — contract ที่ชั้น GraphQL (e2e, ไม่ต่อ DB)', () => {
  let app: INestApplication<App>;

  /** แถว caregivers แถวเดียวที่ "DB" มี — แต่ละเทสตั้งเอง */
  let row: {
    kycStatus: string;
    careLevel: string | null;
    careLevelSetBy: string | null;
    careLevelSetAt: Date | null;
  } | null;
  let logs: Array<Record<string, unknown>>;

  const prismaRow = () => ({
    id: CAREGIVER_ID,
    userId: CAREGIVER_USER.id,
    caregiverNumber: 'CG-0001',
    fullName: 'สมศรี ใจดี',
    idCardNumber: '1234567890123',
    gender: null,
    dateOfBirth: null,
    address: null,
    phone: '0812345678',
    skills: [],
    experienceYears: 2,
    hourlyRate: 150,
    bio: null,
    kycSubmittedAt: new Date('2026-10-01T00:00:00Z'),
    kycVerifiedAt:
      row!.kycStatus === 'verified' ? new Date('2026-10-18T03:00:00Z') : null,
    isSearchable: false,
    languages: [],
    resubmitCount: 0,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    rejection_reasons: null,
    user: { email: 'cg@x.com' },
    careLevelSetByUser: row!.careLevelSetBy
      ? { displayName: 'แอดมิน ทดสอบ' }
      : null,
    ...row!,
  });

  const update = jest.fn(({ data }: { data: Record<string, unknown> }) => {
    Object.assign(row!, data);
    return Promise.resolve(prismaRow());
  });

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    // Nest log GraphQLError ที่ไม่ใช่ HttpException เป็น ERROR (พฤติกรรมเดิมของ ProfessionError ด้วย) — ปิดให้ผลเทสอ่านง่าย
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const tx = {
      $queryRaw: jest.fn((strings: TemplateStringsArray) => {
        const sql = strings.join('?');
        if (sql.includes('FOR UPDATE')) {
          return Promise.resolve(
            row
              ? [
                  {
                    id: CAREGIVER_ID,
                    kyc_status: row.kycStatus,
                    care_level: row.careLevel,
                    care_level_set_by: row.careLevelSetBy,
                  },
                ]
              : [],
          );
        }
        return Promise.resolve([{ now: new Date('2026-10-18T03:00:00Z') }]); // clock_timestamp()
      }),
      caregiver: { update },
      caregiver_care_level_logs: {
        create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          logs.push(data);
          return Promise.resolve({});
        }),
      },
      kycReview: { create: jest.fn().mockResolvedValue({}) },
    };

    const prisma = {
      user: {
        // SupabaseAuthGuard: หา users จาก supabase uid (= token ในเทสนี้)
        findUnique: jest.fn(({ where }: { where: { supabaseUid: string } }) =>
          Promise.resolve(
            [CAREGIVER_USER, ADMIN_USER].find(
              (u) => u.supabaseUid === where.supabaseUid,
            ) ?? null,
          ),
        ),
      },
      caregiver: {
        // หาได้ทั้งด้วย id (ฝั่งแอดมิน) และ userId (myCaregiverProfile)
        findUnique: jest.fn(
          ({ where }: { where: { id?: string; userId?: string } }) =>
            Promise.resolve(
              row &&
                (where.id === CAREGIVER_ID ||
                  where.userId === CAREGIVER_USER.id)
                ? prismaRow()
                : null,
            ),
        ),
      },
      caregiver_care_level_logs: {
        findMany: jest.fn(() =>
          Promise.resolve([
            {
              id: '0b7c6a1e-2f3d-4e5f-8a9b-0c1d2e3f4a5b',
              caregiver_id: CAREGIVER_ID,
              old_level: null,
              new_level: 'basic',
              changed_by: null,
              reason: 'migration_default',
              created_at: new Date('2026-10-07T03:57:48Z'),
              users: null,
            },
          ]),
        ),
      },
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
        AdminResolver,
        AdminService,
        AdminCareLevelResolver,
        AdminCareLevelService,
        KycResolver,
        CaregiverService,
        SupabaseAuthGuard,
        RolesGuard,
        FieldLockGuard,
        { provide: PrismaService, useValue: prisma },
        {
          provide: SupabaseService,
          // token = supabase uid ของผู้ใช้ (ง่ายพอสำหรับเทส)
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
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: KycService, useValue: {} },
        { provide: KycDocumentService, useValue: {} },
        {
          provide: NotificationService,
          useValue: { create: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: EmailService,
          useValue: { sendKycVerified: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: PayoutAccountService,
          useValue: {
            createRecipientForCaregiver: jest.fn().mockResolvedValue(undefined),
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

  beforeEach(() => {
    row = {
      kycStatus: 'pending',
      careLevel: null,
      careLevelSetBy: null,
      careLevelSetAt: null,
    };
    logs = [];
    update.mockClear();
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

  // ─── approveKyc (S02-AC1, AC2 · E1 · E9) ────────────────────────────────

  it('E1: APPROVE_KYC ของ FE ปัจจุบัน (ไม่ส่งระดับ) → HTTP 200 + CARE_LEVEL_REQUIRED และไม่มีอะไรถูกเขียน', async () => {
    const { status, body } = await gql(
      APPROVE_KYC_CURRENT_FE,
      { caregiverId: CAREGIVER_ID },
      ADMIN_USER.id,
    );

    expect(status).toBe(200);
    expect(body.data).toBeNull();
    expect(body.errors?.[0].extensions).toMatchObject({
      code: 'CARE_LEVEL_REQUIRED',
      allowed: ['BASIC', 'INTERMEDIATE', 'ADVANCED'],
    });
    expect(update).not.toHaveBeenCalled();
    expect(row!.kycStatus).toBe('pending');
  });

  it('E9: careLevel นอกรายการผ่าน schema ไปถึง service → HTTP 200 + CARE_LEVEL_INVALID', async () => {
    const { status, body } = await gql(
      APPROVE_KYC_WITH_LEVEL,
      { caregiverId: CAREGIVER_ID, careLevel: 'EXPERT' },
      ADMIN_USER.id,
    );

    expect(status).toBe(200);
    expect(body.errors?.[0].extensions).toMatchObject({
      code: 'CARE_LEVEL_INVALID',
      received: 'EXPERT',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('AC1: อนุมัติพร้อมระดับ → verified + careLevel ส่งออกเป็นชื่อ enum ตัวพิมพ์ใหญ่', async () => {
    const { status, body } = await gql(
      APPROVE_KYC_WITH_LEVEL,
      { caregiverId: CAREGIVER_ID, careLevel: 'ADVANCED' },
      ADMIN_USER.id,
    );

    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data?.approveKyc).toMatchObject({
      kycStatus: 'verified',
      careLevel: 'ADVANCED',
    });
    expect(row).toMatchObject({
      careLevel: 'advanced',
      careLevelSetBy: ADMIN_USER.id,
    });
    expect(logs).toEqual([
      expect.objectContaining({
        old_level: null,
        new_level: 'advanced',
        changed_by: ADMIN_USER.id,
        reason: 'kyc_approval',
      }),
    ]);
  });

  it('สิทธิ์: ผู้ดูแลเรียก approveKyc ไม่ได้ → FORBIDDEN', async () => {
    const { body } = await gql(
      APPROVE_KYC_WITH_LEVEL,
      { caregiverId: CAREGIVER_ID, careLevel: 'ADVANCED' },
      CAREGIVER_USER.id,
    );

    expect(body.errors?.[0].extensions?.code).toBe('FORBIDDEN');
    expect(update).not.toHaveBeenCalled();
  });

  // ─── setCaregiverCareLevel (S02-AC4) ────────────────────────────────────

  it('AC4: แอดมินแก้ระดับ → changed + ข้อมูลระดับ + ผู้กำหนด', async () => {
    row = {
      kycStatus: 'verified',
      careLevel: 'basic',
      careLevelSetBy: null,
      careLevelSetAt: new Date('2026-10-07T03:57:48Z'),
    };

    const { status, body } = await gql(
      SET_CAREGIVER_CARE_LEVEL,
      {
        input: {
          caregiverId: CAREGIVER_ID,
          level: 'INTERMEDIATE',
          reason: 'ผ่านอบรมเพิ่ม',
        },
      },
      ADMIN_USER.id,
    );

    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data?.setCaregiverCareLevel).toEqual({
      changed: true,
      careLevel: {
        caregiverId: CAREGIVER_ID,
        level: 'INTERMEDIATE',
        setBy: ADMIN_USER.id,
        setByName: 'แอดมิน ทดสอบ',
        setAt: '2026-10-18T03:00:00.000Z',
        needsReview: false,
      },
    });
  });

  it('E9: level ผิดผ่าน ValidationPipe (forbidNonWhitelisted) ไปถึง service → CARE_LEVEL_INVALID ไม่ใช่ BAD_REQUEST', async () => {
    row = {
      kycStatus: 'verified',
      careLevel: 'basic',
      careLevelSetBy: ADMIN_USER.id,
      careLevelSetAt: null,
    };

    const { status, body } = await gql(
      SET_CAREGIVER_CARE_LEVEL,
      { input: { caregiverId: CAREGIVER_ID, level: 'basic', reason: 'x' } }, // ตัวพิมพ์เล็ก = ค่าใน DB ไม่ใช่ค่าใน API
      ADMIN_USER.id,
    );

    expect(status).toBe(200);
    expect(body.errors?.[0].extensions).toMatchObject({
      code: 'CARE_LEVEL_INVALID',
      received: 'basic',
    });
  });

  it('เปลี่ยนระดับโดยไม่มีเหตุผล → CARE_LEVEL_REASON_REQUIRED', async () => {
    row = {
      kycStatus: 'verified',
      careLevel: 'basic',
      careLevelSetBy: ADMIN_USER.id,
      careLevelSetAt: null,
    };

    const { body } = await gql(
      SET_CAREGIVER_CARE_LEVEL,
      { input: { caregiverId: CAREGIVER_ID, level: 'ADVANCED' } },
      ADMIN_USER.id,
    );

    expect(body.errors?.[0].extensions).toEqual({
      code: 'CARE_LEVEL_REASON_REQUIRED',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('ผู้ดูแลที่ยังรอตรวจ → CARE_LEVEL_KYC_NOT_VERIFIED', async () => {
    const { body } = await gql(
      SET_CAREGIVER_CARE_LEVEL,
      { input: { caregiverId: CAREGIVER_ID, level: 'BASIC', reason: 'x' } },
      ADMIN_USER.id,
    );

    expect(body.errors?.[0].extensions).toEqual({
      code: 'CARE_LEVEL_KYC_NOT_VERIFIED',
      kycStatus: 'pending',
    });
  });

  it('เหตุผลยาวเกิน 500 ตัวอักษร → DTO ตอบ BAD_REQUEST (ตามที่ contract §5.2 ระบุ)', async () => {
    row = {
      kycStatus: 'verified',
      careLevel: 'basic',
      careLevelSetBy: ADMIN_USER.id,
      careLevelSetAt: null,
    };

    const { body } = await gql(
      SET_CAREGIVER_CARE_LEVEL,
      {
        input: {
          caregiverId: CAREGIVER_ID,
          level: 'ADVANCED',
          reason: 'ก'.repeat(501),
        },
      },
      ADMIN_USER.id,
    );

    expect(body.errors?.[0].extensions?.code).toBe('BAD_REQUEST');
    expect(update).not.toHaveBeenCalled();
  });

  it('ไม่พบผู้ดูแล → INTERNAL_SERVER_ERROR + status 404 (พฤติกรรมเดิมของ NotFoundException ใน repo — contract §5.2)', async () => {
    row = null;

    const { body } = await gql(
      SET_CAREGIVER_CARE_LEVEL,
      { input: { caregiverId: CAREGIVER_ID, level: 'BASIC', reason: 'x' } },
      ADMIN_USER.id,
    );

    // @nestjs/apollo ไม่มี code เฉพาะให้ 404 — FE ต้องดู extensions.status (เหมือน 409 ของ approve ซ้ำ)
    expect(body.errors?.[0].extensions).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      status: 404,
    });
  });

  it.each([
    [
      'setCaregiverCareLevel',
      SET_CAREGIVER_CARE_LEVEL,
      { input: { caregiverId: CAREGIVER_ID, level: 'ADVANCED', reason: 'x' } },
    ],
    [
      'caregiverCareLevelHistory',
      CAREGIVER_CARE_LEVEL_HISTORY,
      { caregiverId: CAREGIVER_ID },
    ],
  ])(
    'สิทธิ์: ผู้ดูแลเรียก %s ไม่ได้ → FORBIDDEN',
    async (_name, query, variables) => {
      row = {
        kycStatus: 'verified',
        careLevel: 'basic',
        careLevelSetBy: null,
        careLevelSetAt: null,
      };

      const { body } = await gql(query, variables, CAREGIVER_USER.id);

      expect(body.errors?.[0].extensions?.code).toBe('FORBIDDEN');
      expect(update).not.toHaveBeenCalled();
    },
  );

  // ─── ฝั่งอ่าน (S02-AC5 · E5 · AC4) ──────────────────────────────────────

  it('AC5: ผู้ดูแลเห็นระดับตัวเองใน GET_CAREGIVER_PROFILE ของ FE (+ careLevel)', async () => {
    row = {
      kycStatus: 'verified',
      careLevel: 'intermediate',
      careLevelSetBy: ADMIN_USER.id,
      careLevelSetAt: null,
    };

    const { status, body } = await gql(
      GET_CAREGIVER_PROFILE,
      {},
      CAREGIVER_USER.id,
    );

    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data?.myCaregiverProfile).toMatchObject({
      id: CAREGIVER_ID,
      careLevel: 'INTERMEDIATE',
    });
  });

  it('E5: ผู้ดูแลที่ยังไม่มีระดับ → careLevel = null (ไม่ใช่ error)', async () => {
    const { body } = await gql(GET_CAREGIVER_PROFILE, {}, CAREGIVER_USER.id);

    expect(body.errors).toBeUndefined();
    expect(body.data?.myCaregiverProfile).toMatchObject({ careLevel: null });
  });

  it('AC4: ประวัติส่ง source เป็น enum และแถว migration ไม่มีผู้เปลี่ยน/ไม่มี reason ภายใน', async () => {
    row = {
      kycStatus: 'verified',
      careLevel: 'basic',
      careLevelSetBy: null,
      careLevelSetAt: null,
    };

    const { body } = await gql(
      CAREGIVER_CARE_LEVEL_HISTORY,
      { caregiverId: CAREGIVER_ID },
      ADMIN_USER.id,
    );

    expect(body.errors).toBeUndefined();
    expect(body.data?.caregiverCareLevelHistory).toEqual([
      {
        id: '0b7c6a1e-2f3d-4e5f-8a9b-0c1d2e3f4a5b',
        oldLevel: null,
        newLevel: 'BASIC',
        changedBy: null,
        changedByName: null,
        reason: null,
        source: 'MIGRATION_DEFAULT',
        createdAt: '2026-10-07T03:57:48.000Z',
      },
    ]);
  });
});
