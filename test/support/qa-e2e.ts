/**
 * Shared harness for the QA e2e suites (PYG-5xx/6xx QA cards, S01–S18)
 * Adapted from test/support/pyg527-e2e.ts (PYG-527 · PR #98), with a fake ClockService that can be set.
 *
 * ★★ Connects ONLY to a disposable Postgres on localhost via QA_DATABASE_URL
 *    - host is not localhost / contains "supabase" → throw immediately
 *    - unset: local machine → skip the whole file · CI (process.env.CI) → throw
 *    - build the DB from schema.prisma (not migrations) — see docs/qa/README-qa-e2e.md
 *
 * Real app modules: FamilyGroupModule (→ Booking → Payment / Monitoring / Notification / Consent / CareActivity)
 *   + AssessmentModule (S08) + CareSkillModule (S03/S17) + MatchingModule (S18) + PatientModule (REST care-recipients)
 *   + KycModule + AdminModule + CaregiverPublicModule + SearchModule (S01–S06)
 * Only 3 external services are mocked — no real Omise / Supabase / SMTP call is ever made:
 *   SupabaseService (auth.getUser) · OmiseService (every method) · EmailService (every method)
 */
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import request from 'supertest';
import { App } from 'supertest/types';
import { CommonModule } from '../../src/common/common.module';
import { PrismaService } from '../../src/common/prisma.service';
import { ClockService } from '../../src/common/clock.service';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { SupabaseService } from '../../src/common/supabase.service';
import { FamilyGroupModule } from '../../src/family-group/family-group.module';
import { AssessmentModule } from '../../src/assessment/assessment.module';
import { CareSkillModule } from '../../src/care-skill/care-skill.module';
import { MatchingModule } from '../../src/matching/matching.module';
import { PatientModule } from '../../src/patient/patient.module';
import { KycModule } from '../../src/identity/kyc/kyc.module';
import { AdminModule } from '../../src/admin/admin.module';
import { CaregiverPublicModule } from '../../src/caregiver-public/caregiver-public.module';
import { SearchModule } from '../../src/search/search.module';
import { LICENSE_DOC_TYPE } from '../../src/identity/kyc/license/license.constants';
import { OmiseService } from '../../src/payment/omise/omise.service';
import { EmailService } from '../../src/email/email.service';
import { ADL_ITEMS } from '../../src/assessment/assessment.constants';

export const DB_URL = process.env.QA_DATABASE_URL;

if (DB_URL) {
  const host = new URL(DB_URL).hostname;
  if (
    !['localhost', '127.0.0.1', '::1'].includes(host) ||
    /supabase/i.test(DB_URL)
  ) {
    throw new Error(
      `QA_DATABASE_URL must be a disposable Postgres on localhost (got host=${host})`,
    );
  }
} else if (process.env.CI) {
  throw new Error(
    'QA_DATABASE_URL is not set in CI — the QA e2e suites must really run, never skip',
  );
}

export const describeDb = DB_URL ? describe : describe.skip;

/**
 * ข้อมูลตั้งต้นแบบเดียวกับ production: ล้างตาราง master ของ S15/S16/S17 แล้วรัน migration ข้อมูลตามลำดับจริง
 * (migration มีหลายคำสั่ง + BEGIN/COMMIT → ใช้ pg simple query ไม่ใช่ Prisma) · รันซ้ำบน DB เดิมได้
 */
export const PRODUCTION_SEEDS = [
  '20261008040000_pyg568_seed_care_activities',
  '20261008060000_pyg569_seed_booking_level_rules',
  '20261008070000_pyg569_seed_flag_level_rules',
  '20261008080000_pyg651_care_activities_align_taxonomy',
  '20261008090000_pyg651_care_activity_e11_short_name',
  '20261009000000_pyg570_seed_required_skills',
  '20261009010000_pyg638_f03_level_advanced',
];

export async function seedProductionMasterData() {
  const sql = new Client({ connectionString: DB_URL });
  await sql.connect();
  try {
    await sql.query(
      'TRUNCATE care_skill_rules, care_skills, booking_level_rules, care_activities CASCADE',
    );
    for (const m of PRODUCTION_SEEDS) {
      await sql.query(
        readFileSync(
          join(__dirname, '..', '..', 'prisma/migrations', m, 'migration.sql'),
          'utf8',
        ),
      );
    }
  } finally {
    await sql.end();
  }
}

/** ทักษะกลาง 15 ตัว (seed PYG-642) ที่ไม่ล็อกวิชาชีพ — ผู้ดูแลทั่วไปถือได้ */
export const UNLOCKED_SKILLS = [
  'bathing',
  'dementia_care',
  'dressing_assist',
  'feeding_assist',
  'glucose_diet_care',
  'pressure_ulcer_care',
  'toileting_care',
  'transfer_assist',
  'wheelchair_push',
];

/** ค่า cron flag ที่ใช้รันจริง — รายงานต้องระบุ (PYG-461/462) */
export const CRON_FLAGS_AT_RUN = {
  BOOKING_EXPIRY_CRON_ENABLED:
    process.env.BOOKING_EXPIRY_CRON_ENABLED ?? '(unset)',
  HOLD_REFRESH_CRON_ENABLED: process.env.HOLD_REFRESH_CRON_ENABLED ?? '(unset)',
};

export type GqlBody = {
  data?: Record<string, any> | null;
  errors?: { message: string; extensions?: Record<string, unknown> }[];
};

export const codeOf = (body: GqlBody) => body.errors?.[0]?.extensions?.code;

/** วันที่ให้บริการในอนาคต (ไกลพอไม่ชน deadline guard ของ PYG-461/462) */
export const futureDate = (daysAhead: number) =>
  new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);

/** Omise ปลอม — นับการเรียกทุกเมธอด, ไม่ออกไปนอกเครื่อง */
export function createOmiseMock() {
  let seq = 0;
  const charge = (amount: number, extra: Record<string, unknown> = {}) => ({
    id: `chrg_test_${++seq}`,
    status: 'pending',
    amount,
    captured: false,
    paid: false,
    authorized: true,
    ...extra,
  });
  return {
    createCharge: jest.fn((amount: number) => Promise.resolve(charge(amount))),
    createCustomerWithCard: jest.fn(() =>
      Promise.resolve({ customerId: 'cust_test_1', cardId: 'card_test_1' }),
    ),
    createChargeForCustomer: jest.fn((amount: number) =>
      Promise.resolve(charge(amount)),
    ),
    captureCharge: jest.fn((id: string) =>
      Promise.resolve({
        id,
        status: 'successful',
        amount: 0,
        captured: true,
        paid: true,
        authorized: true,
      }),
    ),
    reverseCharge: jest.fn((id: string) =>
      Promise.resolve({
        id,
        status: 'reversed',
        amount: 0,
        captured: false,
        paid: false,
        authorized: false,
      }),
    ),
    voidCharge: jest.fn((id: string) =>
      Promise.resolve({
        id,
        status: 'reversed',
        amount: 0,
        captured: false,
        paid: false,
        authorized: false,
      }),
    ),
    retrieveCharge: jest.fn((id: string) =>
      Promise.resolve({
        id,
        status: 'pending',
        amount: 0,
        captured: false,
        paid: false,
        authorized: true,
      }),
    ),
    createRefund: jest.fn(),
    createPromptPayCharge: jest.fn(),
    createTransfer: jest.fn(),
    createRecipient: jest.fn(),
    retrieveRecipient: jest.fn(),
  };
}

export type OmiseMock = ReturnType<typeof createOmiseMock>;

export async function bootstrap() {
  process.env.DATABASE_URL = DB_URL;
  process.env.APP_PUBLIC_BASE_URL = 'https://qa.test';
  // KYC document upload/sign อ่านค่านี้ด้วย getOrThrow (PYG-589) — ค่าปลอม ไม่มีการยิงออกไปจริง
  process.env.SUPABASE_URL ??= 'https://qa-project.supabase.co';
  delete process.env.BOOKING_EXPIRY_CRON_ENABLED;
  delete process.env.HOLD_REFRESH_CRON_ENABLED;

  const tokens = new Map<string, string>();
  const supabase = {
    getClient: () => ({
      auth: {
        getUser: (token: string) =>
          Promise.resolve(
            tokens.has(token)
              ? { data: { user: { id: tokens.get(token) } }, error: null }
              : { data: { user: null }, error: new Error('invalid token') },
          ),
      },
    }),
    getAdminClient: () => {
      if (!storageEnabled)
        throw new Error('Supabase admin client ไม่ควรถูกเรียกในชุดทดสอบนี้');
      // เปิดเฉพาะ storage (signed URL ของเอกสาร KYC) — ส่วนอื่นของ admin client ยังห้ามเรียก
      return {
        storage: {
          from: (bucket: string) => ({
            createSignedUrl: (path: string, ttl: number) => {
              signedUrlCalls.push({ bucket, path, ttl });
              return Promise.resolve({
                data: {
                  signedUrl: `https://storage.qa.test/${bucket}/${path}?ttl=${ttl}`,
                },
                error: null,
              });
            },
          }),
        },
      };
    },
  };
  /**
   * opt-in (PYG-589): spec ที่ต้องอ่านเอกสาร KYC เรียก enableStorage() — ชุดอื่นยังได้ error เดิม
   * signedUrlCalls เก็บทุกครั้งที่ระบบขอ signed URL ไว้ตรวจ bucket/path
   */
  let storageEnabled = false;
  const signedUrlCalls: { bucket: string; path: string; ttl: number }[] = [];
  const enableStorage = () => {
    storageEnabled = true;
  };
  const omise = createOmiseMock();
  // นาฬิกาเซิร์ฟเวอร์ปลอม — ไม่ตั้ง = เวลาจริง · ตั้งแล้วทุกที่ที่ใช้ ClockService เห็นเวลานี้
  let frozen: Date | null = null;
  const clock = {
    now: () => (frozen ? new Date(frozen) : new Date()),
    set: (d: Date) => {
      frozen = d;
    },
    reset: () => {
      frozen = null;
    },
  };
  // ★ ต้องไม่ตอบ 'then' / lifecycle hooks — ไม่งั้น Nest มองว่าเป็น Promise แล้ว await ค้างตลอดกาล
  const email = new Proxy(
    {},
    {
      get: (_t, prop) =>
        typeof prop !== 'string' ||
        prop === 'then' ||
        prop.startsWith('on') ||
        prop.startsWith('before')
          ? undefined
          : jest.fn(() => Promise.resolve(undefined)),
    },
  );

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      EventEmitterModule.forRoot(),
      GraphQLModule.forRoot<ApolloDriverConfig>({
        driver: ApolloDriver,
        autoSchemaFile: true,
        context: ({ req, res }: { req: unknown; res: unknown }) => ({
          req,
          res,
        }),
      }),
      CommonModule,
      FamilyGroupModule,
      AssessmentModule,
      CareSkillModule,
      MatchingModule,
      PatientModule,
      KycModule,
      AdminModule,
      CaregiverPublicModule,
      SearchModule,
    ],
  })
    .overrideProvider(SupabaseService)
    .useValue(supabase)
    .overrideProvider(OmiseService)
    .useValue(omise)
    .overrideProvider(EmailService)
    .useValue(email)
    .overrideProvider(ClockService)
    .useValue(clock)
    // PrismaService สร้าง pg Pool เองแล้วส่งให้ adapter → $disconnect() ไม่ปิด pool นั้น jest จึงไม่ออก
    // ใช้ client ที่ adapter เป็นเจ้าของ pool เอง (แบบเดียวกับ test/pyg609-assessment.e2e-spec.ts)
    .overrideProvider(PrismaService)
    .useValue(
      new PrismaClient({
        adapter: new PrismaPg({ connectionString: DB_URL! }),
      }),
    )
    .compile();

  const app: INestApplication<App> = moduleRef.createNestApplication();
  // ★ ต้องตรงกับ src/main.ts
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  await app.init();
  // ฟัง port เดียวตลอดชุด — ถ้าไม่ listen, supertest เปิด/ปิด port ชั่วคราวทุก request
  // ซึ่งเมื่อรันหลายชุดใน process เดียว (แบบ CI) เคยได้ "Parse Error: Expected HTTP/" แบบสุ่ม
  await app.listen(0, '127.0.0.1');
  const prisma = app.get(PrismaService);

  const gqlRaw = (
    token: string | null,
    query: string,
    variables: Record<string, unknown> = {},
  ) => {
    const req = request(app.getHttpServer()).post('/graphql');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req.send({ query, variables });
  };

  const gql = async (
    token: string | null,
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<GqlBody> =>
    (await gqlRaw(token, query, variables)).body as GqlBody;

  const rest = (token: string) => ({
    post: (path: string, body: unknown) =>
      request(app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${token}`)
        .send(body as object),
    get: (path: string) =>
      request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${token}`),
    put: (path: string, body: unknown) =>
      request(app.getHttpServer())
        .put(path)
        .set('Authorization', `Bearer ${token}`)
        .send(body as object),
  });

  /**
   * ผู้ใช้ที่ผ่าน Onboarding แล้ว (มี first_name/last_name — ด่าน PYG-499)
   * ชื่อบัญชีที่คาดหวัง = `${firstName} ${lastName}` (accountDisplayName)
   */
  const seedUser = async (
    tag: string,
    role = 1,
    name?: { firstName: string | null; lastName: string | null },
  ) => {
    const uid = randomUUID();
    const short = uid.slice(0, 8);
    const firstName = name ? name.firstName : `ชื่อ${tag}`;
    const lastName = name ? name.lastName : `สกุล${short}`;
    const user = await prisma.user.create({
      data: {
        supabaseUid: uid,
        email: `${tag}-${uid}@qa.test`,
        displayName: `${tag}-${short}`,
        firstName,
        lastName,
        role,
        isActive: true,
        is_deleted: false,
      },
      select: { id: true, displayName: true },
    });
    const token = `tok-${uid}`;
    tokens.set(token, uid);
    const accountName =
      [firstName, lastName].filter((p) => p?.trim()).join(' ') ||
      (user.displayName as string);
    return {
      id: user.id,
      displayName: user.displayName as string,
      accountName,
      token,
    };
  };

  type Seeded = Awaited<ReturnType<typeof seedUser>>;

  /**
   * ผู้ดูแลที่อยู่ในกลุ่ม public ของ S18 (verified + searchable + เปิดรับทุกวันทุก slot)
   * ค่าเริ่มต้นผ่านตัวกรอง S18 สำหรับ booking ที่ไม่ต้องการทักษะล็อกวิชาชีพ:
   *   ระดับสูง · ผู้ดูแลทั่วไป · มีทักษะกลางทุกตัวที่ไม่ล็อกวิชาชีพ
   * license: ใบประกอบฯ (professional_license) ของ caregiver/user เดียวกัน — ไม่ระบุ = ไม่มีใบ
   */
  const seedCaregiver = async (
    opts: {
      hourlyRate?: number;
      careLevel?: 'basic' | 'intermediate' | 'advanced' | null;
      profession?: 'general_caregiver' | 'nurse' | 'physiotherapist';
      skills?: string[];
      searchable?: boolean;
      kycStatus?: string;
      license?: { status: string; expiresAt: Date | null } | null;
    } = {},
  ) => {
    const hourlyRate = opts.hourlyRate ?? 300;
    const user = await seedUser('caregiver', 2);
    const cg = await prisma.caregiver.create({
      data: {
        userId: user.id,
        fullName: `ผู้ดูแล ${user.displayName}`,
        kycStatus: opts.kycStatus ?? 'verified',
        isSearchable: opts.searchable ?? true,
        hourlyRate,
        careLevel: opts.careLevel === undefined ? 'advanced' : opts.careLevel,
        profession: opts.profession ?? 'general_caregiver',
        skills: opts.skills ?? UNLOCKED_SKILLS,
      },
      select: { id: true },
    });
    // PYG-524: จองได้เฉพาะช่วงที่ผู้ดูแลเปิดรับ — เปิดทุกวันทุก slot
    await prisma.caregiverAvailability.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].flatMap((dayOfWeek) =>
        (['morning', 'afternoon', 'evening'] as const).map((timeSlot) => ({
          caregiverId: cg.id,
          dayOfWeek,
          timeSlot,
        })),
      ),
    });
    if (opts.license) {
      await prisma.kycDocument.create({
        data: {
          caregiverId: cg.id,
          userId: user.id,
          documentType: LICENSE_DOC_TYPE,
          fileUrl: '',
          fileName: 'license.jpg',
          fileSize: 1,
          mimeType: 'image/jpeg',
          reviewStatus: opts.license.status,
          expiresAt: opts.license.expiresAt,
          licenseNumber: `QA-${user.id.slice(0, 6)}`,
        },
      });
    }
    return { ...user, caregiverId: cg.id, hourlyRate };
  };

  /** S18: เจ้าของ booking เลือกผู้ดูแลผ่าน API จริง (selectBookingCaregiver) */
  const selectCaregiver = (
    owner: Seeded,
    bookingId: string,
    caregiverId: string,
  ) =>
    gql(
      owner.token,
      `mutation($b: ID!, $c: ID!) { selectBookingCaregiver(bookingId: $b, caregiverId: $c) { bookingId caregiverId status } }`,
      { b: bookingId, c: caregiverId },
    );

  /** เจ้าของสร้างกลุ่มผ่าน API จริง แล้วเพิ่มสมาชิกเป็น precondition ตรงลง DB */
  const seedGroup = async (memberCount = 0, memberRole = 1) => {
    const owner = await seedUser('owner');
    const body = await gql(
      owner.token,
      `mutation($name: String!) { createFamilyGroup(input: { name: $name }) { id } }`,
      { name: 'บ้าน QA' },
    );
    if (body.errors) throw new Error(JSON.stringify(body.errors));
    const groupId = (body.data as { createFamilyGroup: { id: string } })
      .createFamilyGroup.id;

    const members: Seeded[] = [];
    for (let i = 0; i < memberCount; i++) {
      const m = await seedUser(`member${i}`, memberRole);
      await prisma.familyGroupMember.create({
        data: { groupId, userId: m.id, role: 'MEMBER', status: 'ACTIVE' },
      });
      members.push(m);
    }
    return { groupId, owner, members };
  };

  /** แอดมิน (role 3) — สิทธิ์ AdminCareActivityResolver / หน้าแอดมินอื่น */
  const seedAdmin = () => seedUser('admin', 3);

  /**
   * โปรไฟล์ผู้รับบริการของ owner + แบบประเมิน ADL ผ่าน API จริง (submitCareRecipientAssessment)
   * — ผ่านด่าน S08 ASSESSMENT_REQUIRED ของการจอง · คะแนนเต็มทุกข้อ = care group "social"
   */
  /**
   * ส่ง/แก้แบบประเมิน ADL ผ่าน API จริง (submitCareRecipientAssessment)
   * adl: คะแนนรายข้อที่ต้องการ (ข้อที่ไม่ระบุ = คะแนนเต็ม · null = "ไม่แน่ใจ")
   */
  const submitAssessment = async (
    owner: Seeded,
    careRecipientId: string,
    opts: {
      flags?: string[];
      score?: 'max' | 'zero';
      adl?: Partial<Record<string, number | null>>;
      dementiaSevere?: boolean;
    } = {},
  ) => {
    const body = await gql(
      owner.token,
      `mutation($input: SubmitCareRecipientAssessmentInput!) {
         submitCareRecipientAssessment(input: $input) { careRecipientId adlTotalScore }
       }`,
      {
        input: {
          careRecipientId,
          answers: ADL_ITEMS.map((item) => ({
            code: item.code,
            value:
              opts.adl && item.code in opts.adl
                ? opts.adl[item.code]
                : opts.score === 'zero'
                  ? 0
                  : item.maxScore,
          })),
          flags: opts.flags ?? [],
          noSpecialConditions: (opts.flags ?? []).length === 0,
          ...(opts.dementiaSevere === undefined
            ? {}
            : { dementiaSevere: opts.dementiaSevere }),
        },
      },
    );
    if (body.errors) throw new Error(JSON.stringify(body.errors));
    return (
      body.data as { submitCareRecipientAssessment: { adlTotalScore: number } }
    ).submitCareRecipientAssessment.adlTotalScore;
  };

  /**
   * โปรไฟล์ผู้รับบริการของ owner + แบบประเมิน ADL — ผ่านด่าน S08 ASSESSMENT_REQUIRED ของการจอง
   * ค่าเริ่มต้น: คะแนนเต็มทุกข้อ ไม่มี Flag (care group "social")
   */
  const seedAssessedRecipient = async (
    owner: Seeded,
    opts: Parameters<typeof submitAssessment>[2] = {},
  ) => {
    const recipient = await prisma.careRecipient.create({
      data: { patientId: owner.id, name: owner.accountName, is_self: true },
      select: { id: true },
    });
    await submitAssessment(owner, recipient.id, opts);
    return recipient.id;
  };

  const close = async () => {
    await prisma.$disconnect();
    await app.close();
  };

  return {
    app,
    prisma,
    omise,
    clock,
    enableStorage,
    signedUrlCalls,
    gql,
    gqlRaw,
    rest,
    seedUser,
    seedCaregiver,
    selectCaregiver,
    seedGroup,
    seedAdmin,
    seedAssessedRecipient,
    submitAssessment,
    close,
  };
}

export type Harness = Awaited<ReturnType<typeof bootstrap>>;
