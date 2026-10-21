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
 *   + AssessmentModule (S08) + CareSkillModule (S03/S17)
 * Only 3 external services are mocked — no real Omise / Supabase / SMTP call is ever made:
 *   SupabaseService (auth.getUser) · OmiseService (every method) · EmailService (every method)
 */
import { randomUUID } from 'crypto';
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
      throw new Error('Supabase admin client ไม่ควรถูกเรียกในชุดทดสอบนี้');
    },
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

  /** ผู้ดูแลที่จองได้ (verified + searchable + มีเรทรายชั่วโมง) */
  const seedCaregiver = async (hourlyRate = 300) => {
    const user = await seedUser('caregiver', 2);
    const cg = await prisma.caregiver.create({
      data: {
        userId: user.id,
        fullName: `ผู้ดูแล ${user.displayName}`,
        kycStatus: 'verified',
        isSearchable: true,
        hourlyRate,
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
    return { ...user, caregiverId: cg.id, hourlyRate };
  };

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
  const seedAssessedRecipient = async (
    owner: Seeded,
    opts: { flags?: string[]; score?: 'max' | 'zero' } = {},
  ) => {
    const recipient = await prisma.careRecipient.create({
      data: { patientId: owner.id, name: owner.accountName, is_self: true },
      select: { id: true },
    });
    const body = await gql(
      owner.token,
      `mutation($input: SubmitCareRecipientAssessmentInput!) {
         submitCareRecipientAssessment(input: $input) { careRecipientId adlTotalScore }
       }`,
      {
        input: {
          careRecipientId: recipient.id,
          answers: ADL_ITEMS.map((item) => ({
            code: item.code,
            value: opts.score === 'zero' ? 0 : item.maxScore,
          })),
          flags: opts.flags ?? [],
          noSpecialConditions: (opts.flags ?? []).length === 0,
        },
      },
    );
    if (body.errors) throw new Error(JSON.stringify(body.errors));
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
    gql,
    gqlRaw,
    rest,
    seedUser,
    seedCaregiver,
    seedGroup,
    seedAdmin,
    seedAssessedRecipient,
    close,
  };
}

export type Harness = Awaited<ReturnType<typeof bootstrap>>;
