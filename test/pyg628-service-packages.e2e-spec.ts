/** Only the dedicated disposable Docker Postgres; never a remote environment. */
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Test, TestingModule } from '@nestjs/testing';
import {
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
} from '@nestjs/graphql';
import { graphql, GraphQLSchema } from 'graphql';
import { PrismaService } from '../src/common/prisma.service';
import { ConsentService } from '../src/consent/consent.service';
import { AssessmentService } from '../src/assessment/assessment.service';
import { ADL_ITEMS } from '../src/assessment/assessment.constants';
import { ServicePackageService } from '../src/service-package/service-package.service';
import { RecommendedServicePackagesResolver } from '../src/service-package/service-package.resolver';

const DB_URL = process.env.PYG609_DATABASE_URL;
if (DB_URL) {
  const url = new URL(DB_URL);
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/pyg609_test' ||
    /supabase/i.test(DB_URL)
  )
    throw new Error(
      'PYG609_DATABASE_URL must use the disposable localhost pyg609_test database',
    );
} else if (process.env.CI)
  throw new Error('PYG609_DATABASE_URL is required in CI for S14');
const describeDb = DB_URL ? describe : describe.skip;

describeDb('PYG-628 recommended service packages: Postgres and GraphQL', () => {
  let db: PrismaService;
  let sql: Client;
  let service: ServicePackageService;
  let assessments: AssessmentService;
  let moduleRef: TestingModule;
  let schema: GraphQLSchema;
  let queries = 0;
  const users: string[] = [];
  const groups: string[] = [];
  const extraPackages: string[] = [];
  beforeAll(async () => {
    const client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DB_URL }),
      log: [{ level: 'query', emit: 'event' }],
    });
    client.$on('query', () => {
      queries++;
    });
    db = client as PrismaService;
    await db.$connect();
    sql = new Client({ connectionString: DB_URL });
    await sql.connect();
    await sql.query(
      readFileSync(
        join(
          __dirname,
          '../prisma/migrations/20261009030000_pyg567_seed_service_packages/migration.sql',
        ),
        'utf8',
      ),
    );
    const consent = new ConsentService(db);
    service = new ServicePackageService(db, consent);
    assessments = new AssessmentService(db, consent);
    moduleRef = await Test.createTestingModule({
      imports: [GraphQLSchemaBuilderModule],
    }).compile();
    schema = await moduleRef
      .get(GraphQLSchemaFactory)
      .create([RecommendedServicePackagesResolver]);
  });
  afterAll(async () => {
    if (db) {
      await db.careGroupServicePackage.deleteMany({
        where: { packageId: { in: extraPackages } },
      });
      await db.servicePackageItem.deleteMany({
        where: { packageId: { in: extraPackages } },
      });
      await db.servicePackage.deleteMany({
        where: { id: { in: extraPackages } },
      });
      await db.careRecipientAssessment.deleteMany({
        where: { assessedBy: { in: users } },
      });
      await db.careRecipient.deleteMany({
        where: { patientId: { in: users } },
      });
      await db.familyGroupMember.deleteMany({
        where: { groupId: { in: groups } },
      });
      await db.familyGroup.deleteMany({ where: { id: { in: groups } } });
      await db.user.deleteMany({ where: { id: { in: users } } });
      await db.$disconnect();
    }
    await sql?.end();
    await moduleRef?.close();
  });
  async function user() {
    const id = randomUUID();
    const row = await db.user.create({
      data: { supabaseUid: id, email: `${id}@pyg628.test`, role: 1 },
    });
    users.push(row.id);
    return row.id;
  }
  function values(score: number) {
    let remaining = score;
    return {
      answers: ADL_ITEMS.map(({ code, maxScore }) => {
        const value = Math.min(maxScore, remaining);
        remaining -= value;
        return { code, value };
      }),
      flags: [] as string[],
      noSpecialConditions: true,
    };
  }
  async function profile(owner: string, score?: number) {
    const row = await db.careRecipient.create({
      data: {
        patientId: owner,
        name: 'S14 fixture',
        medical_conditions: [],
        mobility_level: 'bedridden',
      },
    });
    if (score !== undefined)
      await assessments.submit(owner, {
        careRecipientId: row.id,
        ...values(score),
      });
    return row.id;
  }
  it('uses every recipient own latest S09 group for the same account and returns all seeded items', async () => {
    const owner = await user();
    for (const [score, group, codes] of [
      [20, 'SOCIAL', ['companion_care', 'daily_care']],
      [11, 'HOMEBOUND', ['daily_care', 'rehab_care']],
      [0, 'BEDRIDDEN', ['bedridden_full', 'rehab_care']],
    ] as const) {
      const id = await profile(owner, score);
      const result = await service.recommended(owner, id);
      expect(result.careGroup).toBe(group);
      expect(result.packages.map((p) => p.code)).toEqual(codes);
      expect(
        result.packages.every((p) => p.containsSelectedServiceType === null),
      ).toBe(true);
      expect(
        result.packages.every(
          (p) =>
            p.items.length > 0 &&
            p.items.every((item) => item.nameTh && item.nameEn),
        ),
      ).toBe(true);
    }
  });
  it('E6 GraphQL: bedridden + physiotherapy returns both packages in mapping order with false/true', async () => {
    const owner = await user();
    const id = await profile(owner, 0);
    const resolver = new RecommendedServicePackagesResolver(service);
    const source =
      '{ recommendedServicePackages(careRecipientId: "' +
      id +
      '", selectedServiceType: "physiotherapy") { careGroup packages { code containsSelectedServiceType items { serviceType nameTh nameEn } } } }';
    const result = await graphql({
      schema,
      source,
      rootValue: {
        recommendedServicePackages: () =>
          resolver.recommendedServicePackages(
            { id: owner } as never,
            id,
            'physiotherapy',
          ),
      },
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      recommendedServicePackages: {
        careGroup: 'BEDRIDDEN',
        packages: [
          {
            code: 'bedridden_full',
            containsSelectedServiceType: false,
            items: [
              {
                serviceType: 'bedridden_care',
                nameTh: 'ดูแลผู้ป่วยติดเตียง',
                nameEn: 'Bedridden care',
              },
              {
                serviceType: 'medication',
                nameTh: 'ช่วยจัดการยา',
                nameEn: 'Medication assistance',
              },
            ],
          },
          {
            code: 'rehab_care',
            containsSelectedServiceType: true,
            items: [
              {
                serviceType: 'physiotherapy',
                nameTh: 'กายภาพบำบัด',
                nameEn: 'Physiotherapy',
              },
              {
                serviceType: 'general_care',
                nameTh: 'ดูแลทั่วไป',
                nameEn: 'General care',
              },
            ],
          },
        ],
      },
    });
  });
  it('no assessment is success-null/[]; new assessments and group edits take effect immediately', async () => {
    const owner = await user();
    const id = await profile(owner);
    expect(await service.recommended(owner, id)).toEqual({
      careGroup: null,
      packages: [],
    });
    await assessments.submit(owner, { careRecipientId: id, ...values(20) });
    expect(
      (await service.recommended(owner, id)).packages.map((p) => p.code),
    ).toEqual(['companion_care', 'daily_care']);
    await assessments.submit(owner, { careRecipientId: id, ...values(0) });
    expect(
      (await service.recommended(owner, id)).packages.map((p) => p.code),
    ).toEqual(['bedridden_full', 'rehab_care']);
  });
  it('disabled mappings and disabled packages are excluded independently', async () => {
    const owner = await user();
    const id = await profile(owner, 0);
    const mapping = await db.careGroupServicePackage.findFirstOrThrow({
      where: { careGroup: 'bedridden', package: { code: 'bedridden_full' } },
    });
    await db.careGroupServicePackage.update({
      where: { id: mapping.id },
      data: { isActive: false },
    });
    try {
      expect(
        (await service.recommended(owner, id)).packages.map((p) => p.code),
      ).toEqual(['rehab_care']);
    } finally {
      await db.careGroupServicePackage.update({
        where: { id: mapping.id },
        data: { isActive: true },
      });
    }
    await db.servicePackage.update({
      where: { code: 'rehab_care' },
      data: { isActive: false },
    });
    try {
      expect(
        (await service.recommended(owner, id)).packages.map((p) => p.code),
      ).toEqual(['bedridden_full']);
    } finally {
      await db.servicePackage.update({
        where: { code: 'rehab_care' },
        data: { isActive: true },
      });
    }
  });
  it('an empty mapping table gives a known group and [] without errors', async () => {
    const owner = await user();
    const id = await profile(owner, 11);
    const rows = await db.careGroupServicePackage.findMany();
    await db.careGroupServicePackage.deleteMany();
    try {
      expect(await service.recommended(owner, id)).toEqual({
        careGroup: 'HOMEBOUND',
        packages: [],
      });
    } finally {
      await db.careGroupServicePackage.createMany({ data: rows });
    }
  });
  it('uses live family membership, shared profile and data-owner disclosure consent', async () => {
    const owner = await user();
    const relative = await user();
    const outsider = await user();
    const id = await profile(owner, 20);
    const unshared = await profile(owner, 20);
    const group = await db.familyGroup.create({
      data: { name: 'S14 fixture', createdBy: owner },
    });
    groups.push(group.id);
    await db.familyGroupMember.createMany({
      data: [owner, relative].map((userId) => ({
        userId,
        groupId: group.id,
        status: 'ACTIVE',
      })),
    });
    await db.careRecipient.update({
      where: { id },
      data: { familyGroupId: group.id },
    });
    expect((await service.recommended(relative, id)).careGroup).toBe('SOCIAL');
    for (const [actor, recipient] of [
      [outsider, id],
      [relative, unshared],
      [owner, randomUUID()],
    ])
      await expect(service.recommended(actor, recipient)).rejects.toMatchObject(
        { extensions: { code: 'ASSESSMENT_ACCESS_DENIED' } },
      );
    await db.familyGroupMember.updateMany({
      where: { userId: relative, groupId: group.id },
      data: { status: 'LEFT' },
    });
    await expect(service.recommended(relative, id)).rejects.toMatchObject({
      extensions: { code: 'ASSESSMENT_ACCESS_DENIED' },
    });
    await db.familyGroupMember.updateMany({
      where: { userId: relative, groupId: group.id },
      data: { status: 'ACTIVE' },
    });
    await db.user_consents.create({
      data: {
        user_id: owner,
        consent_type: 'disclose_to_family_group',
        policy_version: '1.0',
        granted: false,
        source: 'settings',
      },
    });
    await expect(service.recommended(relative, id)).rejects.toMatchObject({
      extensions: { code: 'ASSESSMENT_ACCESS_DENIED' },
    });
    expect((await service.recommended(owner, id)).careGroup).toBe('SOCIAL');
  });
  it('query count is constant as packages grow; groups/memberships and package data are never cached between calls', async () => {
    const owner = await user();
    const id = await profile(owner, 20);
    let before = queries;
    await service.recommended(owner, id);
    const initial = queries - before;
    for (let i = 0; i < 5; i++) {
      const row = await db.servicePackage.create({
        data: {
          code: `pyg628_${randomUUID()}`,
          nameTh: 'ชุดทดสอบ',
          nameEn: 'Test package',
          items: { create: { serviceType: 'general_care' } },
          careGroups: { create: { careGroup: 'social', sortOrder: 30 + i } },
        },
      });
      extraPackages.push(row.id);
    }
    before = queries;
    const result = await service.recommended(owner, id);
    const expanded = queries - before;
    expect(result.packages).toHaveLength(7);
    expect(expanded).toBe(initial);
  });
});
