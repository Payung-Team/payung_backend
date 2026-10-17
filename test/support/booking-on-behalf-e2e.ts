/**
 * ตัวช่วยร่วมของ e2e จองแทน (PYG-427) — ใช้โดย
 *   test/booking-on-behalf.e2e-spec.ts
 *   test/booking-on-behalf.concurrency.e2e-spec.ts
 *
 * ★★ ต่อได้เฉพาะ Postgres ทิ้งได้บน localhost ผ่าน PYG427_DATABASE_URL เท่านั้น
 *    - host ไม่ใช่ localhost / มีคำว่า supabase → throw ทันที
 *    - ไม่ได้ตั้งค่า: เครื่อง dev → skip ทั้งไฟล์ · CI (process.env.CI) → throw
 *
 * แอปที่บูต: FamilyGroupModule + BookingModule + PaymentModule + MonitoringModule + NotificationModule ตัวจริง
 * (guard chain / resolver / service / REST controller / event listener จริงทั้งหมด)
 * mock เฉพาะของภายนอก 3 ตัว — ไม่มีการเรียก Omise / Supabase / SMTP จริงแม้แต่ครั้งเดียว:
 *   SupabaseService (auth.getUser) · OmiseService (ทุกเมธอด) · EmailService (ทุกเมธอด)
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
import { SupabaseService } from '../../src/common/supabase.service';
import { FamilyGroupModule } from '../../src/family-group/family-group.module';
import { OmiseService } from '../../src/payment/omise/omise.service';
import { EmailService } from '../../src/email/email.service';

export const DB_URL = process.env.PYG427_DATABASE_URL;

if (DB_URL) {
  const host = new URL(DB_URL).hostname;
  if (
    !['localhost', '127.0.0.1', '::1'].includes(host) ||
    /supabase/i.test(DB_URL)
  ) {
    throw new Error(
      `PYG427_DATABASE_URL ต้องเป็น Postgres ทิ้งได้บน localhost เท่านั้น (ได้ host=${host})`,
    );
  }
} else if (process.env.CI) {
  throw new Error(
    'PYG427_DATABASE_URL ไม่ได้ตั้งค่าใน CI — ชุดทดสอบ PYG-427 ต้องรันจริง ห้าม skip',
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
  process.env.APP_PUBLIC_BASE_URL = 'https://pyg427.test';
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
    ],
  })
    .overrideProvider(SupabaseService)
    .useValue(supabase)
    .overrideProvider(OmiseService)
    .useValue(omise)
    .overrideProvider(EmailService)
    .useValue(email)
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

  const seedUser = async (tag: string, role = 1) => {
    const uid = randomUUID();
    const user = await prisma.user.create({
      data: {
        supabaseUid: uid,
        email: `${tag}-${uid}@pyg427.test`,
        displayName: `${tag}-${uid.slice(0, 8)}`,
        role,
        isActive: true,
        is_deleted: false,
      },
      select: { id: true, displayName: true },
    });
    const token = `tok-${uid}`;
    tokens.set(token, uid);
    return { id: user.id, displayName: user.displayName as string, token };
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
    return { ...user, caregiverId: cg.id, hourlyRate };
  };

  /** เจ้าของสร้างกลุ่มผ่าน API จริง แล้วเพิ่มสมาชิกเป็น precondition ตรงลง DB */
  const seedGroup = async (memberCount = 0, memberRole = 1) => {
    const owner = await seedUser('owner');
    const body = await gql(
      owner.token,
      `mutation($name: String!) { createFamilyGroup(input: { name: $name }) { id } }`,
      { name: 'บ้าน PYG-427' },
    );
    if (body.errors) throw new Error(JSON.stringify(body.errors));
    const groupId = body.data!.createFamilyGroup.id as string;

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

  const close = async () => {
    await prisma.$disconnect();
    await app.close();
  };

  return {
    app,
    prisma,
    omise,
    gql,
    gqlRaw,
    rest,
    seedUser,
    seedCaregiver,
    seedGroup,
    close,
  };
}

export type Harness = Awaited<ReturnType<typeof bootstrap>>;
