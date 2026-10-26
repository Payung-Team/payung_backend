import { Test, TestingModule } from '@nestjs/testing';
import {
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
} from '@nestjs/graphql';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { graphql, GraphQLSchema } from 'graphql';
import { ServicePackageService } from './service-package.service';
import { RecommendedServicePackagesResolver } from './service-package.resolver';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { findMemberCareProfile } from '../booking/member-care-profile';
import { ConsentService } from '../consent/consent.service';
import { POLICY_VERSION } from '../consent/consent.constants';

/**
 * ชุดบริการที่แนะนำตอนจองแทนสมาชิกกลุ่ม — recommendedServicePackagesForMember
 *
 * เดิมหน้าจองแทนไม่มีชุดแนะนำเลย: FE มีแค่ memberUserId และแบบประเมินของสมาชิกอยู่ที่ใบ
 * is_self ส่วนตัว ซึ่ง query เดิม (careRecipientId) ไม่ให้สมาชิกคนอื่นอ่าน
 */

const GROUP = '33333333-3333-4333-8333-333333333333';
const BOOKER = '44444444-4444-4444-8444-444444444444';
const MEMBER = '55555555-5555-4555-8555-555555555555';
const GROUP_PROFILE = '66666666-6666-4666-8666-666666666666';
const SELF_PROFILE = '77777777-7777-4777-8777-777777777777';

const GROUP_PROFILE_QUERY = {
  where: {
    patientId: MEMBER,
    familyGroupId: GROUP,
    is_deleted: false,
    assessment: { isNot: null },
  },
  select: { id: true, name: true },
  orderBy: { updated_at: 'desc' },
};
const SELF_PROFILE_QUERY = {
  where: {
    patientId: MEMBER,
    is_self: true,
    familyGroupId: null,
    is_deleted: false,
  },
  select: { id: true, name: true },
  orderBy: { updated_at: 'desc' },
};

type Where = { where: { is_self?: boolean; familyGroupId?: string | null } };

function makeTx() {
  return {
    careRecipient: { findUnique: jest.fn(), findFirst: jest.fn() },
    familyGroupMember: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ userId: BOOKER }, { userId: MEMBER }]),
    },
    careRecipientAssessment: {
      findUnique: jest.fn().mockResolvedValue({ careGroup: 'social' }),
    },
    careGroupServicePackage: {
      findMany: jest.fn().mockResolvedValue([
        {
          sortOrder: 0,
          package: {
            id: 'pkg-id',
            code: 'social_companion',
            nameTh: 'ชุดเพื่อนคู่ใจ',
            nameEn: 'Companion',
            descriptionTh: null,
            descriptionEn: null,
            sortOrder: 0,
            items: [{ serviceType: 'companion', sortOrder: 0 }],
          },
        },
      ]),
    },
  };
}

/** ① โปรไฟล์ในกลุ่มที่ประเมินแล้ว · ② ใบ is_self — ตอบตาม where ที่ถูกถาม */
function profiles(
  tx: ReturnType<typeof makeTx>,
  found: { group?: boolean; self?: boolean },
) {
  tx.careRecipient.findFirst.mockImplementation(({ where }: Where) =>
    Promise.resolve(
      where.is_self
        ? found.self
          ? { id: SELF_PROFILE, name: 'Self' }
          : null
        : found.group
          ? { id: GROUP_PROFILE, name: 'Group' }
          : null,
    ),
  );
}

describe('findMemberCareProfile (shared with createBookingOnBehalf)', () => {
  it('prefers an assessed group profile and does not look at is_self', async () => {
    const tx = makeTx();
    profiles(tx, { group: true, self: true });
    await expect(
      findMemberCareProfile(tx as never, GROUP, MEMBER),
    ).resolves.toEqual({
      id: GROUP_PROFILE,
      name: 'Group',
      source: 'group',
    });
    expect(tx.careRecipient.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.careRecipient.findFirst).toHaveBeenCalledWith(
      GROUP_PROFILE_QUERY,
    );
  });

  it("falls back to the member's own is_self profile only", async () => {
    const tx = makeTx();
    profiles(tx, { self: true });
    await expect(
      findMemberCareProfile(tx as never, GROUP, MEMBER),
    ).resolves.toEqual({
      id: SELF_PROFILE,
      name: 'Self',
      source: 'self',
    });
    expect(tx.careRecipient.findFirst).toHaveBeenNthCalledWith(
      1,
      GROUP_PROFILE_QUERY,
    );
    expect(tx.careRecipient.findFirst).toHaveBeenNthCalledWith(
      2,
      SELF_PROFILE_QUERY,
    );
  });

  it('returns null when the member has neither', async () => {
    const tx = makeTx();
    profiles(tx, {});
    await expect(
      findMemberCareProfile(tx as never, GROUP, MEMBER),
    ).resolves.toBeNull();
  });
});

describe('ServicePackageService.recommendedForMember', () => {
  let tx: ReturnType<typeof makeTx>;
  let consent: {
    findWithdrawnType: jest.Mock;
    grantedCurrentUserIds: jest.Mock;
  };
  let service: ServicePackageService;

  beforeEach(() => {
    tx = makeTx();
    consent = {
      findWithdrawnType: jest.fn().mockResolvedValue(null),
      grantedCurrentUserIds: jest.fn().mockResolvedValue(new Set([MEMBER])),
    };
    const transaction = jest.fn((fn: (value: typeof tx) => Promise<unknown>) =>
      fn(tx),
    );
    service = new ServicePackageService(
      { $transaction: transaction } as never,
      consent as never,
    );
  });

  const denied = {
    extensions: { code: 'ASSESSMENT_ACCESS_DENIED', statusCode: 403 },
  };

  it("recommends from the member's is_self assessment when the member granted family disclosure", async () => {
    profiles(tx, { self: true });
    const result = await service.recommendedForMember(BOOKER, GROUP, MEMBER);
    expect(result.careGroup).toBe('SOCIAL');
    expect(result.packages.map((p) => p.code)).toEqual(['social_companion']);
    expect(tx.careRecipientAssessment.findUnique).toHaveBeenCalledWith({
      where: { careRecipientId: SELF_PROFILE },
      select: { careGroup: true },
    });
    expect(tx.familyGroupMember.findMany).toHaveBeenCalledWith({
      where: {
        groupId: GROUP,
        userId: { in: [BOOKER, MEMBER] },
        status: 'ACTIVE',
      },
      select: { userId: true },
    });
    expect(consent.findWithdrawnType).toHaveBeenCalledWith(
      MEMBER,
      ['disclose_to_family_group'],
      tx,
    );
    expect(consent.grantedCurrentUserIds).toHaveBeenCalledWith(
      [MEMBER],
      'disclose_to_family_group',
      tx,
    );
  });

  it('uses the assessed group profile first, like the booking does', async () => {
    profiles(tx, { group: true, self: true });
    await service.recommendedForMember(BOOKER, GROUP, MEMBER);
    expect(tx.careRecipientAssessment.findUnique).toHaveBeenCalledWith({
      where: { careRecipientId: GROUP_PROFILE },
      select: { careGroup: true },
    });
    // a profile the member already shared into the group needs no extra opt-in
    expect(consent.grantedCurrentUserIds).not.toHaveBeenCalled();
  });

  it('passes selectedServiceType through to the package flag', async () => {
    profiles(tx, { self: true });
    const result = await service.recommendedForMember(
      BOOKER,
      GROUP,
      MEMBER,
      'physiotherapy',
    );
    expect(result.packages[0].containsSelectedServiceType).toBe(false);
  });

  it('denies an is_self profile without an explicit current family-disclosure grant', async () => {
    profiles(tx, { self: true });
    consent.grantedCurrentUserIds.mockResolvedValue(new Set());
    await expect(
      service.recommendedForMember(BOOKER, GROUP, MEMBER),
    ).rejects.toMatchObject(denied);
    expect(tx.careRecipientAssessment.findUnique).not.toHaveBeenCalled();
  });

  it('a member reading their own packages needs no consent checks', async () => {
    profiles(tx, { self: true });
    tx.familyGroupMember.findMany.mockResolvedValue([{ userId: MEMBER }]);
    const result = await service.recommendedForMember(MEMBER, GROUP, MEMBER);
    expect(result.careGroup).toBe('SOCIAL');
    expect(tx.familyGroupMember.findMany).toHaveBeenCalledWith({
      where: { groupId: GROUP, userId: { in: [MEMBER] }, status: 'ACTIVE' },
      select: { userId: true },
    });
    expect(consent.findWithdrawnType).not.toHaveBeenCalled();
    expect(consent.grantedCurrentUserIds).not.toHaveBeenCalled();
  });

  it('member without any profile → no assessment yet (careGroup null), not an error', async () => {
    profiles(tx, {});
    await expect(
      service.recommendedForMember(BOOKER, GROUP, MEMBER),
    ).resolves.toEqual({ careGroup: null, packages: [] });
    expect(tx.careRecipientAssessment.findUnique).not.toHaveBeenCalled();
  });

  it('is_self profile without an assessment → careGroup null', async () => {
    profiles(tx, { self: true });
    tx.careRecipientAssessment.findUnique.mockResolvedValue(null);
    await expect(
      service.recommendedForMember(BOOKER, GROUP, MEMBER),
    ).resolves.toEqual({ careGroup: null, packages: [] });
    expect(tx.careGroupServicePackage.findMany).not.toHaveBeenCalled();
  });

  it.each([
    ['the booker left the group', [{ userId: MEMBER }]],
    ['the member left the group', [{ userId: BOOKER }]],
    ['duplicate rows for one person', [{ userId: BOOKER }, { userId: BOOKER }]],
  ])('denies when %s, before reading any profile', async (_label, rows) => {
    tx.familyGroupMember.findMany.mockResolvedValue(rows);
    await expect(
      service.recommendedForMember(BOOKER, GROUP, MEMBER),
    ).rejects.toMatchObject(denied);
    expect(tx.careRecipient.findFirst).not.toHaveBeenCalled();
  });

  it('denies when the member withdrew family disclosure, before reading any profile', async () => {
    consent.findWithdrawnType.mockResolvedValue('disclose_to_family_group');
    await expect(
      service.recommendedForMember(BOOKER, GROUP, MEMBER),
    ).rejects.toMatchObject(denied);
    expect(tx.careRecipient.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ['groupId', 'not-a-uuid', MEMBER],
    ['memberUserId', GROUP, 'not-a-uuid'],
  ])('rejects a malformed %s before database reads', async (_arg, g, m) => {
    await expect(
      service.recommendedForMember(BOOKER, g, m),
    ).rejects.toMatchObject(denied);
    expect(tx.familyGroupMember.findMany).not.toHaveBeenCalled();
  });

  it('invalid selected type is BAD_USER_INPUT/422', async () => {
    profiles(tx, { self: true });
    await expect(
      service.recommendedForMember(BOOKER, GROUP, MEMBER, 'elderly_care'),
    ).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT', statusCode: 422 },
    });
    expect(tx.careGroupServicePackage.findMany).not.toHaveBeenCalled();
  });

  it('sanitizes database failures', async () => {
    tx.familyGroupMember.findMany.mockRejectedValue(
      new Error('secret health query'),
    );
    await expect(
      service.recommendedForMember(BOOKER, GROUP, MEMBER),
    ).rejects.toThrow('ไม่สามารถอ่านชุดบริการที่แนะนำได้ในขณะนี้');
  });
});

describe('recommendedServicePackagesForMember GraphQL field', () => {
  let moduleRef: TestingModule;
  let schema: GraphQLSchema;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [GraphQLSchemaBuilderModule],
    }).compile();
    schema = await moduleRef
      .get(GraphQLSchemaFactory)
      .create([RecommendedServicePackagesResolver]);
  });
  afterAll(async () => {
    await moduleRef.close();
  });

  it('takes groupId + memberUserId (+ optional service type) and returns the same type as the profile query', () => {
    const field = schema
      .getQueryType()!
      .getFields().recommendedServicePackagesForMember;
    expect(String(field.type)).toBe('RecommendedServicePackages!');
    expect(field.args.map((arg) => [arg.name, String(arg.type)])).toEqual([
      ['groupId', 'ID!'],
      ['memberUserId', 'ID!'],
      ['selectedServiceType', 'String'],
    ]);
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      RecommendedServicePackagesResolver,
    ) as unknown[];
    expect(guards).toContain(SupabaseAuthGuard);
  });

  it('passes the authenticated actor, never a caller-supplied one', async () => {
    const recommendedForMember = jest
      .fn()
      .mockResolvedValue({ careGroup: 'SOCIAL', packages: [] });
    const resolver = new RecommendedServicePackagesResolver({
      recommendedForMember,
    } as never);
    const result = await graphql({
      schema,
      source: `query ($g: ID!, $m: ID!) {
        recommendedServicePackagesForMember(groupId: $g, memberUserId: $m) { careGroup }
      }`,
      variableValues: { g: GROUP, m: MEMBER },
      rootValue: {
        recommendedServicePackagesForMember: (args: {
          groupId: string;
          memberUserId: string;
          selectedServiceType?: string | null;
        }) =>
          resolver.recommendedServicePackagesForMember(
            { id: 'authenticated-actor' } as never,
            args.groupId,
            args.memberUserId,
            args.selectedServiceType,
          ),
      },
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      recommendedServicePackagesForMember: { careGroup: 'SOCIAL' },
    });
    expect(recommendedForMember).toHaveBeenCalledWith(
      'authenticated-actor',
      GROUP,
      MEMBER,
      undefined,
    );
  });
});

/**
 * Worker: PrismaService เปิด pg pool ขนาด 1 connection ต่อ request
 * transaction ถือ connection นั้นไว้ → อ่านอะไรผ่าน client นอก transaction ระหว่างนั้น = รอไม่มีวันได้
 * จน transaction หมดเวลา (production 2026-10-27: หน้าจองแทนขึ้น "โหลดชุดบริการที่แนะนำไม่สำเร็จ")
 * ใช้ ConsentService ตัวจริง — ด่านนี้พังเพราะ consent อ่านผ่าน this.prisma ไม่ใช่ tx
 */
describe('on the Worker one-connection pool (real ConsentService)', () => {
  function oneConnectionPrisma(tx: ReturnType<typeof makeTx>) {
    let inTransaction = false;
    const outside = {
      user_consents: {
        // connection เดียวถูก transaction ถืออยู่ → รอไปเรื่อย ๆ
        findMany: jest.fn(() =>
          inTransaction
            ? new Promise<never>(() => undefined)
            : Promise.resolve([]),
        ),
      },
    };
    const txWithConsents = {
      ...tx,
      user_consents: {
        findMany: jest.fn().mockResolvedValue([
          {
            user_id: MEMBER,
            consent_type: 'disclose_to_family_group',
            granted: true,
            policy_version: POLICY_VERSION,
          },
        ]),
      },
    };
    const prisma = {
      ...outside,
      // เหมือน interactive transaction ของ Prisma: ค้างเกินเวลา = ถูกปิดทิ้งพร้อม error
      $transaction: async (
        fn: (client: typeof txWithConsents) => Promise<unknown>,
      ) => {
        inTransaction = true;
        try {
          return await Promise.race([
            fn(txWithConsents),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error('Transaction already closed: timeout')),
                200,
              ),
            ),
          ]);
        } finally {
          inTransaction = false;
        }
      },
    };
    return { prisma, outside, txWithConsents };
  }

  it('member packages read consent through the open transaction and resolve', async () => {
    const tx = makeTx();
    profiles(tx, { self: true });
    const { prisma, outside, txWithConsents } = oneConnectionPrisma(tx);
    const service = new ServicePackageService(
      prisma as never,
      new ConsentService(prisma as never),
    );
    await expect(
      service.recommendedForMember(BOOKER, GROUP, MEMBER),
    ).resolves.toMatchObject({ careGroup: 'SOCIAL' });
    expect(outside.user_consents.findMany).not.toHaveBeenCalled();
    // findWithdrawnType + grantedCurrentUserIds
    expect(txWithConsents.user_consents.findMany).toHaveBeenCalledTimes(2);
  });

  it('a relative reading a shared group profile also resolves (existing query)', async () => {
    const tx = makeTx();
    tx.careRecipient.findUnique.mockResolvedValue({
      patientId: MEMBER,
      is_deleted: false,
      familyGroupId: GROUP,
    });
    const { prisma, outside } = oneConnectionPrisma(tx);
    const service = new ServicePackageService(
      prisma as never,
      new ConsentService(prisma as never),
    );
    await expect(
      service.recommended(BOOKER, GROUP_PROFILE),
    ).resolves.toMatchObject({ careGroup: 'SOCIAL' });
    expect(outside.user_consents.findMany).not.toHaveBeenCalled();
  });
});
