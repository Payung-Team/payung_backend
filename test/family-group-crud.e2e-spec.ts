/**
 * E2E (GraphQL) — PYG-415 / TC-BS-01 · Family group CRUD + permissions (AC-BS-01, PYG-407)
 *
 * ยิงผ่าน supertest เข้า GraphQL จริง: SupabaseAuthGuard → RolesGuard → FamilyGroupGuard ตัวจริง
 * ValidationPipe config เดียวกับ main.ts · FamilyGroupService + PrismaService ตัวจริงกับ Postgres จริง
 * mock เฉพาะ SupabaseService.auth.getUser (token → supabase uid)
 *
 * ★★ ต้องชี้ไปที่ Postgres ทิ้งได้ใน Docker เท่านั้น — เทสนี้ลบกลุ่ม/เตะสมาชิกจริง
 *    PYG415_DATABASE_URL ต้องเป็น localhost ไม่งั้น throw ทันที (กันยิงใส่ Supabase ที่มี prod ก้อนเดียว)
 *    ไม่ได้ตั้ง → ทั้งไฟล์ถูก skip เพื่อไม่ให้ `npm run test:e2e` ปกติแดงเพิ่ม
 *
 * วิธีรัน: ดู docs/qa/pyg-415-family-group-crud-report.md หัวข้อ "How to run"
 */
import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/common/prisma.service';
import { SupabaseService } from '../src/common/supabase.service';
import { FamilyGroupResolver } from '../src/family-group/family-group.resolver';
import { FamilyGroupService } from '../src/family-group/family-group.service';
import { FamilyGroupGuard } from '../src/family-group/guards/family-group.guard';
import {
  GROUP_MAX_MEMBERS,
  GROUP_NAME_MAX_LENGTH,
} from '../src/family-group/family-group.constants';

const DB_URL = process.env.PYG415_DATABASE_URL;

if (DB_URL) {
  const host = new URL(DB_URL).hostname;
  if (
    !['localhost', '127.0.0.1', '::1'].includes(host) ||
    /supabase/i.test(DB_URL)
  ) {
    throw new Error(
      `PYG415_DATABASE_URL ต้องเป็น Postgres ทิ้งได้บน localhost เท่านั้น (ได้ host=${host})`,
    );
  }
}

const describeDb = DB_URL ? describe : describe.skip;

jest.setTimeout(30_000);

// ─── GraphQL operations ────────────────────────────────────────────────────
const CREATE = `mutation($name: String!) {
  createFamilyGroup(input: { name: $name }) { id name myRole memberCount members { userId role } }
}`;
const RENAME = `mutation($groupId: ID!, $name: String!) {
  renameFamilyGroup(input: { groupId: $groupId, name: $name }) { id name }
}`;
const DELETE = `mutation($groupId: ID!) {
  deleteFamilyGroup(groupId: $groupId) { id deleted }
}`;
const LEAVE = `mutation($groupId: ID!) {
  leaveFamilyGroup(groupId: $groupId) { groupId left }
}`;
const REMOVE = `mutation($groupId: ID!, $userId: ID!) {
  removeMember(input: { groupId: $groupId, userId: $userId }) { id memberCount }
}`;
const TRANSFER = `mutation($groupId: ID!, $to: ID!) {
  transferOwnership(input: { groupId: $groupId, newOwnerUserId: $to }) { id myRole members { userId role } }
}`;
const GROUP = `query($groupId: ID!) {
  familyGroup(groupId: $groupId) { id name myRole memberCount members { userId role } }
}`;
const CREATE_LINK = `mutation($groupId: ID!, $maxUses: Int) {
  createJoinLink(input: { groupId: $groupId, maxUses: $maxUses }) { url }
}`;
const JOIN = `mutation($token: String!) {
  joinGroupByLink(token: $token) { id memberCount }
}`;

type GqlBody = {
  data?: Record<string, any> | null;
  errors?: { message: string; extensions?: Record<string, unknown> }[];
};

const codeOf = (body: GqlBody) => body.errors?.[0]?.extensions?.code;

describeDb('PYG-415 · family group CRUD + permissions (e2e, real DB)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  /** token → supabase uid (seed ผู้ใช้ทีละเทส ไม่แชร์ state) */
  const tokens = new Map<string, string>();

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.APP_PUBLIC_BASE_URL = 'https://pyg415.test';

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

    app = moduleRef.createNestApplication();
    // ★ ต้องตรงกับ src/main.ts
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  // ─── helpers ─────────────────────────────────────────────────────────────
  const gql = async (
    token: string | null,
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<GqlBody> => {
    const req = request(app.getHttpServer()).post('/graphql');
    if (token) req.set('Authorization', `Bearer ${token}`);
    const res = await req.send({ query, variables });
    return res.body as GqlBody;
  };

  /** ผู้ใช้ใหม่ 1 คน → { id, token } */
  const seedUser = async (tag: string) => {
    const uid = randomUUID();
    const user = await prisma.user.create({
      data: {
        supabaseUid: uid,
        email: `${tag}-${uid}@pyg415.test`,
        displayName: tag,
        role: 1,
        isActive: true,
        is_deleted: false,
      },
      select: { id: true },
    });
    const token = `tok-${uid}`;
    tokens.set(token, uid);
    return { id: user.id, token };
  };

  type Seeded = Awaited<ReturnType<typeof seedUser>>;

  /** เจ้าของสร้างกลุ่มผ่าน API จริง แล้วเพิ่มสมาชิกเป็น precondition ตรงลง DB */
  const seedGroup = async (memberCount = 0) => {
    const owner = await seedUser('owner');
    const body = await gql(owner.token, CREATE, { name: 'บ้าน PYG-415' });
    expect(body.errors).toBeUndefined();
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

  const activeCount = (groupId: string) =>
    prisma.familyGroupMember.count({ where: { groupId, status: 'ACTIVE' } });

  const memberRow = (groupId: string, userId: string) =>
    prisma.familyGroupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
      select: { role: true, status: true },
    });

  const groupName = async (groupId: string) =>
    (
      await prisma.familyGroup.findUnique({
        where: { id: groupId },
        select: { name: true },
      })
    )?.name;

  const tokenFromUrl = (url: string) =>
    new URL(url).searchParams.get('token') as string;

  // ═══════════════════════════════════════════════════════════════════════
  //  14 cases จากชีต
  // ═══════════════════════════════════════════════════════════════════════

  it('PYG-415_01 — creator becomes OWNER with an ACTIVE membership row', async () => {
    const user = await seedUser('creator');
    const body = await gql(user.token, CREATE, { name: 'ครอบครัวใหม่' });

    expect(body.errors).toBeUndefined();
    const g = body.data!.createFamilyGroup;
    expect(g.myRole).toBe('OWNER');
    expect(g.memberCount).toBe(1);
    expect(await memberRow(g.id as string, user.id)).toEqual({
      role: 'OWNER',
      status: 'ACTIVE',
    });
  });

  it('PYG-415_02 — empty group name is rejected and no group is created', async () => {
    const user = await seedUser('creator');
    const body = await gql(user.token, CREATE, { name: '' });

    expect(body.data).toBeNull();
    expect(
      await prisma.familyGroup.count({ where: { createdBy: user.id } }),
    ).toBe(0);
    // สัญญากับ FE (family-group.errors.ts): GROUP_NAME_INVALID + maxLength — เช็คท้ายสุดให้ state ถูกยืนยันก่อน
    expect(body.errors![0]).toMatchObject({
      extensions: {
        code: 'GROUP_NAME_INVALID',
        maxLength: GROUP_NAME_MAX_LENGTH,
      },
    });
  });

  it(`PYG-415_03 — name of ${GROUP_NAME_MAX_LENGTH + 1} chars is rejected, ${GROUP_NAME_MAX_LENGTH} chars passes`, async () => {
    const user = await seedUser('creator');

    const over = await gql(user.token, CREATE, {
      name: 'ก'.repeat(GROUP_NAME_MAX_LENGTH + 1),
    });
    expect(over.data).toBeNull();
    expect(
      await prisma.familyGroup.count({ where: { createdBy: user.id } }),
    ).toBe(0);

    const max = await gql(user.token, CREATE, {
      name: 'ก'.repeat(GROUP_NAME_MAX_LENGTH),
    });
    expect(max.errors).toBeUndefined();
    expect(
      await prisma.familyGroup.count({ where: { createdBy: user.id } }),
    ).toBe(1);

    expect(over.errors![0]).toMatchObject({
      extensions: {
        code: 'GROUP_NAME_INVALID',
        maxLength: GROUP_NAME_MAX_LENGTH,
      },
    });
  });

  it('PYG-415_04 — owner rename persists after reload', async () => {
    const { groupId, owner } = await seedGroup();

    const body = await gql(owner.token, RENAME, { groupId, name: 'บ้านย่า' });
    expect(body.errors).toBeUndefined();

    const reload = await gql(owner.token, GROUP, { groupId });
    expect(reload.data!.familyGroup.name).toBe('บ้านย่า');
    expect(await groupName(groupId)).toBe('บ้านย่า');
  });

  it('PYG-415_05 — non-owner member cannot rename the group', async () => {
    const { groupId, members } = await seedGroup(1);

    const body = await gql(members[0].token, RENAME, { groupId, name: 'แฮ็ก' });
    expect(codeOf(body)).toBe('NOT_GROUP_OWNER');
    expect(await groupName(groupId)).toBe('บ้าน PYG-415');
  });

  it('PYG-415_06 — non-member is denied without revealing whether the group exists', async () => {
    const { groupId } = await seedGroup(1);
    const stranger = await seedUser('stranger');

    const real = await gql(stranger.token, GROUP, { groupId });
    const fake = await gql(stranger.token, GROUP, { groupId: randomUUID() });

    expect(real.data).toBeNull();
    expect(codeOf(real)).toBe('NOT_A_MEMBER');
    // ต้องแยกไม่ออกระหว่างกลุ่มจริงกับ id มั่ว
    expect(codeOf(fake)).toBe(codeOf(real));
    expect(fake.errors![0].message).toBe(real.errors![0].message);
  });

  it('PYG-415_07 — owner removes member; removed member loses access immediately', async () => {
    const { groupId, owner, members } = await seedGroup(1);
    const target = members[0];

    // ยืนยันว่าก่อนถูกเตะยังอ่านได้
    expect(
      (await gql(target.token, GROUP, { groupId })).errors,
    ).toBeUndefined();

    const body = await gql(owner.token, REMOVE, { groupId, userId: target.id });
    expect(body.errors).toBeUndefined();
    expect(body.data!.removeMember.memberCount).toBe(1);
    expect(await memberRow(groupId, target.id)).toEqual({
      role: 'MEMBER',
      status: 'REMOVED',
    });

    const after = await gql(target.token, GROUP, { groupId });
    expect(codeOf(after)).toBe('NOT_A_MEMBER');
  });

  it('PYG-415_08 — regular member cannot remove another member', async () => {
    const { groupId, members } = await seedGroup(2);
    const before = await activeCount(groupId);

    const body = await gql(members[0].token, REMOVE, {
      groupId,
      userId: members[1].id,
    });
    expect(codeOf(body)).toBe('NOT_GROUP_OWNER');
    expect(await activeCount(groupId)).toBe(before);
    expect(await memberRow(groupId, members[1].id)).toEqual({
      role: 'MEMBER',
      status: 'ACTIVE',
    });
  });

  it('PYG-415_09 — member leaves; owner sees member count drop', async () => {
    const { groupId, owner, members } = await seedGroup(1);
    expect(
      (await gql(owner.token, GROUP, { groupId })).data!.familyGroup
        .memberCount,
    ).toBe(2);

    const body = await gql(members[0].token, LEAVE, { groupId });
    expect(body.errors).toBeUndefined();
    expect(body.data!.leaveFamilyGroup.left).toBe(true);

    expect(
      (await gql(owner.token, GROUP, { groupId })).data!.familyGroup
        .memberCount,
    ).toBe(1);
    expect((await memberRow(groupId, members[0].id))!.status).toBe('LEFT');
  });

  it('PYG-415_10 — owner cannot leave while other members exist', async () => {
    const { groupId, owner } = await seedGroup(2);

    const body = await gql(owner.token, LEAVE, { groupId });
    expect(codeOf(body)).toBe('LAST_OWNER');
    expect(await memberRow(groupId, owner.id)).toEqual({
      role: 'OWNER',
      status: 'ACTIVE',
    });
    expect(await activeCount(groupId)).toBe(3);
  });

  it('PYG-415_11 — transferOwnership makes target OWNER and previous owner MEMBER', async () => {
    const { groupId, owner, members } = await seedGroup(1);
    const target = members[0];

    const body = await gql(owner.token, TRANSFER, { groupId, to: target.id });
    expect(body.errors).toBeUndefined();
    expect(body.data!.transferOwnership.myRole).toBe('MEMBER');

    expect(await memberRow(groupId, target.id)).toEqual({
      role: 'OWNER',
      status: 'ACTIVE',
    });
    expect(await memberRow(groupId, owner.id)).toEqual({
      role: 'MEMBER',
      status: 'ACTIVE',
    });
  });

  it('PYG-415_12 — regular member cannot call transferOwnership', async () => {
    const { groupId, owner, members } = await seedGroup(2);

    const body = await gql(members[0].token, TRANSFER, {
      groupId,
      to: members[1].id,
    });
    expect(codeOf(body)).toBe('NOT_GROUP_OWNER');
    expect(await memberRow(groupId, owner.id)).toEqual({
      role: 'OWNER',
      status: 'ACTIVE',
    });
    expect(await memberRow(groupId, members[0].id)).toEqual({
      role: 'MEMBER',
      status: 'ACTIVE',
    });
    expect(await memberRow(groupId, members[1].id)).toEqual({
      role: 'MEMBER',
      status: 'ACTIVE',
    });
  });

  it(`PYG-415_13 — join beyond the member cap (${GROUP_MAX_MEMBERS}) is rejected`, async () => {
    // เจ้าของ + (cap - 2) = cap - 1 → เหลือที่ว่าง 1 ที่
    const { groupId, owner } = await seedGroup(GROUP_MAX_MEMBERS - 2);
    const link = await gql(owner.token, CREATE_LINK, {
      groupId,
      maxUses: GROUP_MAX_MEMBERS,
    });
    expect(link.errors).toBeUndefined();
    const token = tokenFromUrl(link.data!.createJoinLink.url as string);

    const last = await seedUser('last-seat');
    const ok = await gql(last.token, JOIN, { token });
    expect(ok.errors).toBeUndefined();
    expect(await activeCount(groupId)).toBe(GROUP_MAX_MEMBERS);

    const extra = await seedUser('over-cap');
    const denied = await gql(extra.token, JOIN, { token });
    expect(codeOf(denied)).toBe('GROUP_MEMBER_LIMIT_REACHED');
    expect(denied.errors![0].extensions!.maxMembers).toBe(GROUP_MAX_MEMBERS);
    expect(await activeCount(groupId)).toBe(GROUP_MAX_MEMBERS);
    expect(await memberRow(groupId, extra.id)).toBeNull();
  });

  it('PYG-415_14 — deleting the group invalidates join links (rows removed by FK cascade)', async () => {
    const { groupId, owner } = await seedGroup();
    const link = await gql(owner.token, CREATE_LINK, { groupId });
    expect(link.errors).toBeUndefined();
    const token = tokenFromUrl(link.data!.createJoinLink.url as string);
    expect(await prisma.familyGroupJoinLink.count({ where: { groupId } })).toBe(
      1,
    );

    const del = await gql(owner.token, DELETE, { groupId });
    expect(del.errors).toBeUndefined();

    expect(await prisma.familyGroupJoinLink.count({ where: { groupId } })).toBe(
      0,
    );
    const joiner = await seedUser('late-joiner');
    expect(codeOf(await gql(joiner.token, JOIN, { token }))).toBe(
      'JOIN_LINK_INVALID',
    );
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  10 cases ที่เพิ่มเพื่อปิดช่องว่างกับ AC-BS-01
  // ═══════════════════════════════════════════════════════════════════════

  it('PYG-415_15 — group cannot be renamed to an empty name', async () => {
    const { groupId, owner } = await seedGroup();

    const body = await gql(owner.token, RENAME, { groupId, name: '' });
    expect(body.data).toBeNull();
    expect(await groupName(groupId)).toBe('บ้าน PYG-415');
    expect(body.errors![0]).toMatchObject({
      extensions: {
        code: 'GROUP_NAME_INVALID',
        maxLength: GROUP_NAME_MAX_LENGTH,
      },
    });
  });

  it(`PYG-415_16 — rename boundary enforced at ${GROUP_NAME_MAX_LENGTH} characters`, async () => {
    const { groupId, owner } = await seedGroup();
    const max = 'ข'.repeat(GROUP_NAME_MAX_LENGTH);

    expect(
      (await gql(owner.token, RENAME, { groupId, name: max })).errors,
    ).toBeUndefined();
    expect(await groupName(groupId)).toBe(max);

    const over = await gql(owner.token, RENAME, {
      groupId,
      name: 'ข'.repeat(GROUP_NAME_MAX_LENGTH + 1),
    });
    expect(over.data).toBeNull();
    expect(await groupName(groupId)).toBe(max);
    expect(over.errors![0]).toMatchObject({
      extensions: {
        code: 'GROUP_NAME_INVALID',
        maxLength: GROUP_NAME_MAX_LENGTH,
      },
    });
  });

  it('PYG-415_17 — sole owner cannot leave (LAST_OWNER)', async () => {
    const { groupId, owner } = await seedGroup();

    const body = await gql(owner.token, LEAVE, { groupId });
    expect(codeOf(body)).toBe('LAST_OWNER');
    expect(await prisma.familyGroup.count({ where: { id: groupId } })).toBe(1);
    expect(await memberRow(groupId, owner.id)).toEqual({
      role: 'OWNER',
      status: 'ACTIVE',
    });
  });

  it('PYG-415_18 — previous owner can leave after transferring ownership', async () => {
    const { groupId, owner, members } = await seedGroup(1);
    const target = members[0];

    expect(
      (await gql(owner.token, TRANSFER, { groupId, to: target.id })).errors,
    ).toBeUndefined();
    expect((await gql(owner.token, LEAVE, { groupId })).errors).toBeUndefined();

    expect((await memberRow(groupId, owner.id))!.status).toBe('LEFT');
    const owners = await prisma.familyGroupMember.findMany({
      where: { groupId, status: 'ACTIVE', role: 'OWNER' },
      select: { userId: true },
    });
    expect(owners).toEqual([{ userId: target.id }]);
  });

  it('PYG-415_19 — deleting a group cascades members, care recipients and activity rows', async () => {
    const { groupId, owner, members } = await seedGroup(1);
    const recipient = await prisma.careRecipient.create({
      data: {
        patientId: members[0].id,
        name: 'คุณยาย',
        familyGroupId: groupId,
      },
      select: { id: true },
    });
    expect(await prisma.familyGroupMember.count({ where: { groupId } })).toBe(
      2,
    );
    expect(
      await prisma.familyGroupActivity.count({ where: { groupId } }),
    ).toBeGreaterThanOrEqual(1);

    const del = await gql(owner.token, DELETE, { groupId });
    expect(del.errors).toBeUndefined();

    expect(await prisma.familyGroup.count({ where: { id: groupId } })).toBe(0);
    expect(await prisma.familyGroupMember.count({ where: { groupId } })).toBe(
      0,
    );
    expect(await prisma.familyGroupActivity.count({ where: { groupId } })).toBe(
      0,
    );
    // AC A2: "delete cascades members / invites / recipients / activity"
    expect(
      await prisma.careRecipient.findUnique({ where: { id: recipient.id } }),
    ).toBeNull();
  });

  it('PYG-415_20 — deleting a group preserves bookings made on behalf', async () => {
    const { groupId, owner } = await seedGroup();
    const booking = await prisma.booking.create({
      data: {
        patientId: owner.id,
        bookedBy: owner.id,
        familyGroupId: groupId,
        status: 'confirmed',
        serviceType: 'elderly_care',
        timeSlot: 'morning',
        startTime: new Date('1970-01-01T09:00:00Z'),
        durationHours: 2,
        locationAddress: 'PYG-415 test address',
        bookingDate: new Date('2026-10-01'),
      },
      select: { id: true },
    });
    await prisma.bookingStatusHistory.create({
      data: {
        bookingId: booking.id,
        fromStatus: 'pending',
        toStatus: 'confirmed',
      },
    });

    const del = await gql(owner.token, DELETE, { groupId });
    expect(del.errors).toBeUndefined();
    expect(del.data!.deleteFamilyGroup.deleted).toBe(true);

    const after = await prisma.booking.findUnique({
      where: { id: booking.id },
      select: { status: true, familyGroupId: true },
    });
    expect(after).toEqual({ status: 'confirmed', familyGroupId: null });
    expect(
      await prisma.bookingStatusHistory.count({
        where: { bookingId: booking.id },
      }),
    ).toBe(1);
  });

  it('PYG-415_21 — every state-changing action writes one activity row in the same transaction', async () => {
    const actions = async (groupId: string) =>
      prisma.familyGroupActivity.findMany({
        where: { groupId },
        orderBy: { createdAt: 'asc' },
        select: { action: true, actorId: true, targetId: true },
      });

    // create
    const { groupId, owner, members } = await seedGroup(2);
    expect(await actions(groupId)).toEqual([
      { action: 'GROUP_CREATED', actorId: owner.id, targetId: groupId },
    ]);

    // rename
    await gql(owner.token, RENAME, { groupId, name: 'บ้านใหม่' });
    expect((await actions(groupId)).slice(1)).toEqual([
      { action: 'GROUP_RENAMED', actorId: owner.id, targetId: groupId },
    ]);

    // remove member
    await gql(owner.token, REMOVE, { groupId, userId: members[0].id });
    expect((await actions(groupId)).slice(2)).toEqual([
      { action: 'MEMBER_REMOVED', actorId: owner.id, targetId: members[0].id },
    ]);

    // transfer ownership
    await gql(owner.token, TRANSFER, { groupId, to: members[1].id });
    expect((await actions(groupId)).slice(3)).toEqual([
      {
        action: 'OWNERSHIP_TRANSFERRED',
        actorId: owner.id,
        targetId: members[1].id,
      },
    ]);

    // same transaction: บังคับให้ insert activity ของกลุ่มนี้ล้ม → rename ต้อง rollback ทั้งก้อน
    // (trigger ชั่วคราวใน DB ทิ้งได้เท่านั้น, จำกัดเฉพาะ group_id นี้)
    const newOwner = members[1];
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION pyg415_fail_activity() RETURNS trigger AS $$
      BEGIN
        IF NEW.group_id = '${groupId}'::uuid THEN
          RAISE EXCEPTION 'pyg415 forced activity failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER pyg415_fail_activity BEFORE INSERT ON family_group_activity
      FOR EACH ROW EXECUTE FUNCTION pyg415_fail_activity()`);
    try {
      const body = await gql(newOwner.token, RENAME, {
        groupId,
        name: 'ต้องไม่ติด',
      });
      expect(body.errors).toBeDefined();
      expect(await groupName(groupId)).toBe('บ้านใหม่');
      expect(await actions(groupId)).toHaveLength(4);
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS pyg415_fail_activity ON family_group_activity',
      );
      await prisma.$executeRawUnsafe(
        'DROP FUNCTION IF EXISTS pyg415_fail_activity()',
      );
    }
  });

  it('PYG-415_22 — a rejected action writes no activity row', async () => {
    const { groupId, members } = await seedGroup(1);
    const before = await prisma.familyGroupActivity.count({
      where: { groupId },
    });

    const body = await gql(members[0].token, RENAME, {
      groupId,
      name: 'ห้ามติด',
    });
    expect(codeOf(body)).toBe('NOT_GROUP_OWNER');
    expect(await prisma.familyGroupActivity.count({ where: { groupId } })).toBe(
      before,
    );
  });

  it('PYG-415_23 — non-owner cannot delete the group', async () => {
    const { groupId, members } = await seedGroup(2);

    const body = await gql(members[0].token, DELETE, { groupId });
    expect(codeOf(body)).toBe('NOT_GROUP_OWNER');
    expect(await prisma.familyGroup.count({ where: { id: groupId } })).toBe(1);
    expect(await activeCount(groupId)).toBe(3);
  });

  it('PYG-415_24 — owner cannot remove themselves via removeMember', async () => {
    const { groupId, owner } = await seedGroup(1);

    const body = await gql(owner.token, REMOVE, { groupId, userId: owner.id });
    expect(codeOf(body)).toBe('LAST_OWNER');
    expect(await memberRow(groupId, owner.id)).toEqual({
      role: 'OWNER',
      status: 'ACTIVE',
    });
    expect(await activeCount(groupId)).toBe(2);
  });
});
