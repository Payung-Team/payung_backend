/**
 * ตัวช่วยร่วมของ e2e ลิงก์เข้าร่วมกลุ่ม (PYG-420) — ใช้โดย
 *   test/family-group-join-link.e2e-spec.ts
 *   test/family-group-join-link.concurrency.e2e-spec.ts
 *
 * ★★ ต่อได้เฉพาะ Postgres ทิ้งได้บน localhost ผ่าน PYG420_DATABASE_URL เท่านั้น
 *    - host ไม่ใช่ localhost / มีคำว่า supabase → throw ทันที
 *    - ไม่ได้ตั้งค่า: เครื่อง dev → skip ทั้งไฟล์ · CI (process.env.CI) → throw
 *      (ไม่งั้นพอ PYG-453 เปิด CI จริง ชุดนี้จะเขียวตลอดกาลโดยไม่เคยรันเลย)
 */
import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../../src/common/prisma.service';
import { SupabaseService } from '../../src/common/supabase.service';
import { FamilyGroupResolver } from '../../src/family-group/family-group.resolver';
import { FamilyGroupService } from '../../src/family-group/family-group.service';
import { FamilyGroupGuard } from '../../src/family-group/guards/family-group.guard';

export const DB_URL = process.env.PYG420_DATABASE_URL;

if (DB_URL) {
  const host = new URL(DB_URL).hostname;
  if (
    !['localhost', '127.0.0.1', '::1'].includes(host) ||
    /supabase/i.test(DB_URL)
  ) {
    throw new Error(
      `PYG420_DATABASE_URL ต้องเป็น Postgres ทิ้งได้บน localhost เท่านั้น (ได้ host=${host})`,
    );
  }
} else if (process.env.CI) {
  throw new Error(
    'PYG420_DATABASE_URL ไม่ได้ตั้งค่าใน CI — ชุดทดสอบ PYG-420 ต้องรันจริง ห้าม skip',
  );
}

export const describeDb = DB_URL ? describe : describe.skip;

export type GqlBody = {
  data?: Record<string, any> | null;
  errors?: { message: string; extensions?: Record<string, unknown> }[];
};

export const codeOf = (body: GqlBody) => body.errors?.[0]?.extensions?.code;

export const tokenFromUrl = (url: string) =>
  new URL(url).searchParams.get('token') as string;

// ─── GraphQL operations ────────────────────────────────────────────────────
export const OPS = {
  CREATE_GROUP: `mutation($name: String!) { createFamilyGroup(input: { name: $name }) { id } }`,
  GROUP: `query($groupId: ID!) { familyGroup(groupId: $groupId) { id memberCount members { userId role } } }`,
  REMOVE: `mutation($groupId: ID!, $userId: ID!) { removeMember(input: { groupId: $groupId, userId: $userId }) { id } }`,
  CREATE_LINK: `mutation($groupId: ID!, $maxUses: Int, $ttlHours: Int) {
    createJoinLink(input: { groupId: $groupId, maxUses: $maxUses, ttlHours: $ttlHours }) {
      id url expiresAt maxUses remainingUses memberCount memberLimit isUsable
    }
  }`,
  ROTATE_LINK: `mutation($groupId: ID!, $maxUses: Int) {
    rotateJoinLink(input: { groupId: $groupId, maxUses: $maxUses }) { id url }
  }`,
  REVOKE_LINK: `mutation($groupId: ID!) { revokeJoinLink(groupId: $groupId) }`,
  GROUP_LINK: `query($groupId: ID!) { groupJoinLink(groupId: $groupId) { id url isUsable } }`,
  PREVIEW: `query($token: String!) {
    joinLinkPreview(token: $token) { groupName ownerName memberCount isUsable unusableReason alreadyMember }
  }`,
  JOIN: `mutation($token: String!) { joinGroupByLink(token: $token) { id memberCount members { userId role } } }`,
};

/** แอป Nest ที่มี resolver ครอบครัวพร้อม guard chain จริง + Prisma จริง; mock แค่ Supabase auth */
export async function bootstrap() {
  process.env.DATABASE_URL = DB_URL;
  process.env.APP_PUBLIC_BASE_URL = 'https://pyg420.test';

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
  };

  const moduleRef = await Test.createTestingModule({
    imports: [
      GraphQLModule.forRoot<ApolloDriverConfig>({
        driver: ApolloDriver,
        autoSchemaFile: true,
        context: ({ req, res }: { req: unknown; res: unknown }) => ({
          req,
          res,
        }),
      }),
    ],
    providers: [
      FamilyGroupResolver,
      FamilyGroupService,
      FamilyGroupGuard,
      PrismaService,
      { provide: SupabaseService, useValue: supabase },
    ],
  }).compile();

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

  const seedUser = async (tag: string) => {
    const uid = randomUUID();
    const user = await prisma.user.create({
      data: {
        supabaseUid: uid,
        email: `${tag}-${uid}@pyg420.test`,
        displayName: `${tag}-${uid.slice(0, 8)}`,
        role: 1,
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

  /** เจ้าของสร้างกลุ่มผ่าน API จริง แล้วเพิ่มสมาชิกเป็น precondition ตรงลง DB */
  const seedGroup = async (memberCount = 0) => {
    const owner = await seedUser('owner');
    const body = await gql(owner.token, OPS.CREATE_GROUP, {
      name: 'บ้าน PYG-420',
    });
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

  /** เจ้าของสร้างลิงก์ผ่าน API จริง → { id, url, token } */
  const createLink = async (
    ownerToken: string,
    groupId: string,
    vars: { maxUses?: number; ttlHours?: number } = {},
  ) => {
    const body = await gql(ownerToken, OPS.CREATE_LINK, { groupId, ...vars });
    if (body.errors) throw new Error(JSON.stringify(body.errors));
    const link = body.data!.createJoinLink as { id: string; url: string };
    return { ...link, token: tokenFromUrl(link.url) };
  };

  const linkRow = (id: string) =>
    prisma.familyGroupJoinLink.findUnique({
      where: { id },
      select: {
        status: true,
        usedCount: true,
        maxUses: true,
        tokenHash: true,
        expiresAt: true,
        updatedAt: true,
        revokedAt: true,
      },
    });

  const activeCount = (groupId: string) =>
    prisma.familyGroupMember.count({ where: { groupId, status: 'ACTIVE' } });

  const memberRow = (groupId: string, userId: string) =>
    prisma.familyGroupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
      select: { role: true, status: true, joinedViaLinkId: true },
    });

  const close = async () => {
    await prisma.$disconnect();
    await app.close();
  };

  return {
    app,
    prisma,
    gql,
    gqlRaw,
    seedUser,
    seedGroup,
    createLink,
    linkRow,
    activeCount,
    memberRow,
    close,
  };
}

export type Harness = Awaited<ReturnType<typeof bootstrap>>;
