/**
 * ตัวช่วยร่วมของ e2e ฟีดกิจกรรมกลุ่มครอบครัว (PYG-423)
 *
 * ★★ ต่อได้เฉพาะ Postgres ทิ้งได้บน localhost ผ่าน PYG423_DATABASE_URL เท่านั้น
 *    - host ไม่ใช่ localhost / มีคำว่า supabase → throw ทันที
 *    - ไม่ได้ตั้งค่า: เครื่อง dev → skip ทั้งไฟล์ · CI (process.env.CI) → throw
 *
 * บูต FamilyGroupModule ตัวจริงทั้งโมดูล (ดึง BookingModule/PaymentModule/MonitoringModule/NotificationModule มาด้วย)
 * เพราะเคสจองแทน (_18 _19 _27) ต้องวิ่งผ่าน createBookingOnBehalf จริง
 * mock เฉพาะของภายนอก: SupabaseService (auth) · OmiseService · EmailService — ไม่มีการเรียกภายนอกจริง
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

export const DB_URL = process.env.PYG423_DATABASE_URL;

if (DB_URL) {
  const host = new URL(DB_URL).hostname;
  if (
    !['localhost', '127.0.0.1', '::1'].includes(host) ||
    /supabase/i.test(DB_URL)
  ) {
    throw new Error(
      `PYG423_DATABASE_URL ต้องเป็น Postgres ทิ้งได้บน localhost เท่านั้น (ได้ host=${host})`,
    );
  }
} else if (process.env.CI) {
  throw new Error(
    'PYG423_DATABASE_URL ไม่ได้ตั้งค่าใน CI — ชุดทดสอบ PYG-423 ต้องรันจริง ห้าม skip',
  );
}

export const describeDb = DB_URL ? describe : describe.skip;

export type GqlBody = {
  data?: Record<string, any> | null;
  errors?: { message: string; extensions?: Record<string, unknown> }[];
};

export const codeOf = (body: GqlBody) => body.errors?.[0]?.extensions?.code;

export const FEED = `query($groupId: ID!, $first: Int, $after: String) {
  familyGroupActivity(groupId: $groupId, first: $first, after: $after) {
    nodes { id action targetType targetId metadata createdAt cursor actor { userId displayName } }
    pageInfo { endCursor hasNextPage }
  }
}`;

export type FeedNode = {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: string;
  createdAt: string;
  cursor: string;
  actor: { userId: string; displayName: string | null } | null;
};

export async function bootstrap() {
  process.env.DATABASE_URL = DB_URL;
  process.env.APP_PUBLIC_BASE_URL = 'https://pyg423.test';

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
  // ไม่มีเคสไหนในชุดนี้ที่ไปถึงขั้นจ่ายเงิน — ถ้ามีการเรียก Omise ถือว่าผิดปกติ
  const omise = new Proxy(
    {},
    {
      get: (_t, prop) =>
        typeof prop !== 'string' || prop === 'then' || prop.startsWith('on')
          ? undefined
          : () => {
              throw new Error(`Omise.${prop} ไม่ควรถูกเรียกในชุดทดสอบ PYG-423`);
            },
    },
  );
  // ★ ต้องไม่ตอบ 'then' / lifecycle hooks — ไม่งั้น Nest มองว่าเป็น Promise แล้ว await ค้าง
  const email = new Proxy(
    {},
    {
      get: (_t, prop) =>
        typeof prop !== 'string' ||
        prop === 'then' ||
        prop.startsWith('on') ||
        prop.startsWith('before')
          ? undefined
          : () => Promise.resolve(undefined),
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

  const gql = async (
    token: string | null,
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<GqlBody> => {
    const req = request(app.getHttpServer()).post('/graphql');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return (await req.send({ query, variables })).body as GqlBody;
  };

  const seedUser = async (tag: string, role = 1) => {
    const uid = randomUUID();
    const user = await prisma.user.create({
      data: {
        supabaseUid: uid,
        email: `${tag}-${uid}@pyg423.test`,
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

  /** กลุ่มผ่าน API จริง (มีแถว GROUP_CREATED) + สมาชิกเพิ่มตรงลง DB */
  const seedGroupViaApi = async (memberCount = 0) => {
    const owner = await seedUser('owner');
    const body = await gql(
      owner.token,
      `mutation($name: String!) { createFamilyGroup(input: { name: $name }) { id } }`,
      { name: 'บ้าน PYG-423' },
    );
    if (body.errors) throw new Error(JSON.stringify(body.errors));
    const groupId = body.data!.createFamilyGroup.id as string;
    const members: Seeded[] = [];
    for (let i = 0; i < memberCount; i++) {
      const m = await seedUser(`member${i}`);
      await prisma.familyGroupMember.create({
        data: { groupId, userId: m.id, role: 'MEMBER', status: 'ACTIVE' },
      });
      members.push(m);
    }
    return { groupId, owner, members };
  };

  /**
   * กลุ่ม "เปล่า" ตรงลง DB — ไม่มีแถวกิจกรรมใด ๆ
   * ใช้กับเคสเรียงลำดับ/แบ่งหน้า ที่ต้องคุม created_at เองทุกแถว
   */
  const seedBareGroup = async (memberCount = 0) => {
    const owner = await seedUser('owner');
    const group = await prisma.familyGroup.create({
      data: {
        name: 'กลุ่มเปล่า PYG-423',
        createdBy: owner.id,
        members: {
          create: { userId: owner.id, role: 'OWNER', status: 'ACTIVE' },
        },
      },
      select: { id: true },
    });
    const members: Seeded[] = [];
    for (let i = 0; i < memberCount; i++) {
      const m = await seedUser(`member${i}`);
      await prisma.familyGroupMember.create({
        data: {
          groupId: group.id,
          userId: m.id,
          role: 'MEMBER',
          status: 'ACTIVE',
        },
      });
      members.push(m);
    }
    return { groupId: group.id, owner, members };
  };

  /** แถวกิจกรรมที่คุม created_at เอง — คืน id ตามลำดับที่ส่งเข้า */
  const seedEvents = async (
    groupId: string,
    actorId: string,
    createdAts: Date[],
  ) => {
    const ids: string[] = [];
    for (const createdAt of createdAts) {
      const row = await prisma.familyGroupActivity.create({
        data: {
          groupId,
          actorId,
          action: 'GROUP_RENAMED',
          targetType: 'GROUP',
          targetId: groupId,
          metadata: { seeded: true },
          createdAt,
        },
        select: { id: true },
      });
      ids.push(row.id);
    }
    return ids;
  };

  const feed = async (
    token: string | null,
    groupId: string,
    first?: number,
    after?: string,
  ) => {
    const body = await gql(token, FEED, { groupId, first, after });
    return {
      body,
      nodes: (body.data?.familyGroupActivity?.nodes ?? []) as FeedNode[],
      pageInfo: body.data?.familyGroupActivity?.pageInfo as
        | { endCursor: string | null; hasNextPage: boolean }
        | undefined,
    };
  };

  const activityCount = (groupId: string) =>
    prisma.familyGroupActivity.count({ where: { groupId } });

  const close = async () => {
    await prisma.$disconnect();
    await app.close();
  };

  return {
    app,
    prisma,
    gql,
    seedUser,
    seedGroupViaApi,
    seedBareGroup,
    seedEvents,
    feed,
    activityCount,
    close,
  };
}

export type Harness = Awaited<ReturnType<typeof bootstrap>>;
