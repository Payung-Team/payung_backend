/** S09 uses the same disposable local Postgres as S08; never a remote DB. */
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaService } from '../src/common/prisma.service';
import { ClockService } from '../src/common/clock.service';
import { AssessmentService } from '../src/assessment/assessment.service';
import { CareRecipientsService } from '../src/patient/care-recipients.service';
import { ConsentService } from '../src/consent/consent.service';
import { ADL_ITEMS } from '../src/assessment/assessment.constants';

const DB_URL = process.env.PYG609_DATABASE_URL;
if (DB_URL) {
  const url = new URL(DB_URL);
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/pyg609_test' ||
    /supabase/i.test(DB_URL)
  ) {
    throw new Error(
      'PYG609_DATABASE_URL must be the disposable localhost pyg609_test database',
    );
  }
} else if (process.env.CI)
  throw new Error('PYG609_DATABASE_URL is required in CI for S09');
const describeDb = DB_URL ? describe : describe.skip;

describeDb('PYG-614 care group: real Postgres', () => {
  let prisma: PrismaService;
  let assessments: AssessmentService;
  let profiles: CareRecipientsService;
  let sql: Client;
  let queryCount = 0;
  const owners: string[] = [];
  beforeAll(async () => {
    const client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DB_URL }),
      log: [{ level: 'query', emit: 'event' }],
    });
    // Count only; do not log SQL parameters or health/recipient values.
    client.$on('query', () => {
      queryCount++;
    });
    prisma = client as PrismaService;
    await prisma.$connect();
    sql = new Client({ connectionString: DB_URL });
    await sql.connect();
    assessments = new AssessmentService(prisma, new ConsentService(prisma));
    profiles = new CareRecipientsService(prisma, new ClockService());
  });
  afterAll(async () => {
    if (prisma) {
      await prisma.careRecipientAssessment.deleteMany({
        where: { assessedBy: { in: owners } },
      });
      await prisma.careRecipient.deleteMany({
        where: { patientId: { in: owners } },
      });
      await prisma.user.deleteMany({ where: { id: { in: owners } } });
      await prisma.$disconnect();
    }
    await sql?.end();
  });
  async function owner() {
    const id = randomUUID();
    const row = await prisma.user.create({
      data: { supabaseUid: id, email: `${id}@pyg614.test`, role: 1 },
    });
    owners.push(row.id);
    return row.id;
  }
  async function inputFor(actorId: string, score: number) {
    const profile = await prisma.careRecipient.create({
      data: {
        patientId: actorId,
        name: 'S09 test',
        medical_conditions: [],
        mobility_level: 'bedridden',
      },
    });
    return { careRecipientId: profile.id, ...valuesFor(score) };
  }
  function valuesFor(score: number) {
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
  it('persists all scores 0..20 and returns the same stored groups in assessment and profile APIs', async () => {
    const actorId = await owner();
    const expected = [
      ...Array(5).fill('bedridden'),
      ...Array(7).fill('homebound'),
      ...Array(9).fill('social'),
    ];
    const ids: string[] = [];
    for (let score = 0; score <= 20; score++) {
      const input = await inputFor(actorId, score);
      ids.push(input.careRecipientId);
      const saved = await assessments.submit(actorId, input);
      expect(saved.adlTotalScore).toBe(score);
      expect(saved.careGroup).toBe(expected[score].toUpperCase());
      const stored = await prisma.careRecipientAssessment.findUniqueOrThrow({
        where: { careRecipientId: input.careRecipientId },
      });
      expect(stored.careGroup).toBe(expected[score]);
      expect(
        (await assessments.read(actorId, input.careRecipientId))?.careGroup,
      ).toBe(saved.careGroup);
    }
    const rows = await profiles.list(actorId);
    expect(ids.map((id) => rows.find((r) => r.id === id)?.careGroup)).toEqual(
      expected.map((group) => group.toUpperCase()),
    );
    expect(rows).toHaveLength(21);
  }, 20000);
  it('changes groups on both sides of each cutoff in a single save', async () => {
    const actorId = await owner();
    const input = await inputFor(actorId, 4);
    for (const [score, group] of [
      [4, 'BEDRIDDEN'],
      [5, 'HOMEBOUND'],
      [11, 'HOMEBOUND'],
      [12, 'SOCIAL'],
      [11, 'HOMEBOUND'],
      [4, 'BEDRIDDEN'],
    ] as const) {
      const saved = await assessments.submit(actorId, {
        ...input,
        ...valuesFor(score),
      });
      expect(saved).toMatchObject({ adlTotalScore: score, careGroup: group });
      expect((await profiles.list(actorId))[0].careGroup).toBe(group);
    }
  });
  it('returns null only when unassessed, even if mobility_level says bedridden', async () => {
    const actorId = await owner();
    const input = await inputFor(actorId, 20);
    expect((await profiles.list(actorId))[0]).toMatchObject({
      hasAssessment: false,
      careGroup: null,
    });
    expect(await assessments.read(actorId, input.careRecipientId)).toBeNull();
    const saved = await assessments.submit(actorId, {
      ...input,
      answers: input.answers.map((a) => ({ ...a, value: null })),
    });
    expect(saved).toMatchObject({
      adlTotalScore: 0,
      careGroup: 'BEDRIDDEN',
      unsureCount: 10,
    });
  });
  it('does not issue per-row assessment queries for profile lists', async () => {
    const actorId = await owner();
    await assessments.submit(actorId, await inputFor(actorId, 20));
    queryCount = 0;
    await profiles.list(actorId);
    const oneRowQueries = queryCount;
    for (let i = 0; i < 9; i++)
      await assessments.submit(actorId, await inputFor(actorId, i));
    queryCount = 0;
    expect(await profiles.list(actorId)).toHaveLength(10);
    expect(queryCount).toBe(oneRowQueries);
    expect(queryCount).toBeGreaterThan(0);
  });
  it('rolls back both group and score when a save fails after the write', async () => {
    const actorId = await owner();
    const input = await inputFor(actorId, 4);
    await assessments.submit(actorId, input);
    const before = await prisma.careRecipientAssessment.findUniqueOrThrow({
      where: { careRecipientId: input.careRecipientId },
    });
    const failing = new AssessmentService(
      {
        $transaction: (fn) =>
          prisma.$transaction((tx) =>
            fn(
              new Proxy(tx, {
                get(target, property) {
                  if (property === 'careRecipientAssessment')
                    return {
                      upsert: async (args) => {
                        await tx.careRecipientAssessment.upsert(args);
                        await tx.$executeRaw`SELECT 1 / 0`;
                      },
                    };
                  return Reflect.get(target, property);
                },
              }),
            ),
          ),
      } as unknown as PrismaService,
      new ConsentService(prisma),
    );
    await expect(
      failing.submit(actorId, { ...input, ...valuesFor(20) }),
    ).rejects.toThrow();
    expect(
      await prisma.careRecipientAssessment.findUniqueOrThrow({
        where: { careRecipientId: input.careRecipientId },
      }),
    ).toEqual(before);
  });
  it('backfills legacy rows once without changing assessedAt; reads never calculate the missing group', async () => {
    const actorId = await owner();
    const ids: string[] = [];
    for (let score = 0; score <= 20; score++) {
      const input = await inputFor(actorId, score);
      await assessments.submit(actorId, input);
      ids.push(input.careRecipientId);
    }
    await prisma.careRecipientAssessment.updateMany({
      where: { careRecipientId: { in: ids } },
      data: { careGroup: null },
    });
    const before = await prisma.careRecipientAssessment.findMany({
      where: { careRecipientId: { in: ids } },
      orderBy: { careRecipientId: 'asc' },
      select: { careRecipientId: true, assessedAt: true },
    });
    const readiness = readFileSync(
      join(__dirname, '../prisma/checks/pyg614-care-group-readiness.sql'),
      'utf8',
    );
    await expect(sql.query(readiness)).rejects.toThrow('S09 not ready');
    await expect(assessments.read(actorId, ids[0])).rejects.toThrow(
      'ไม่สามารถดำเนินการกับแบบประเมินได้ในขณะนี้',
    );
    await sql.query(
      readFileSync(
        join(__dirname, '../prisma/backfills/pyg614-care-group.sql'),
        'utf8',
      ),
    );
    await expect(sql.query(readiness)).resolves.toBeDefined();
    expect(
      await prisma.careRecipientAssessment.findMany({
        where: { careRecipientId: { in: ids } },
        orderBy: { careRecipientId: 'asc' },
        select: { careRecipientId: true, assessedAt: true },
      }),
    ).toEqual(before);
    const groups = (
      await Promise.all(ids.map((id) => assessments.read(actorId, id)))
    ).map((r) => r?.careGroup);
    expect(groups).toEqual([
      ...Array(5).fill('BEDRIDDEN'),
      ...Array(7).fill('HOMEBOUND'),
      ...Array(9).fill('SOCIAL'),
    ]);
  }, 20000);
});
