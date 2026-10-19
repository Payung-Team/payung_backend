/** Real transaction/race checks. Only the dedicated disposable Docker database. */
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaService } from '../src/common/prisma.service';
import { AssessmentService } from '../src/assessment/assessment.service';
import { CareRecipientsService } from '../src/patient/care-recipients.service';
import { ConsentService } from '../src/consent/consent.service';
import { ADL_ITEMS } from '../src/assessment/assessment.constants';
import { assertBookingAssessment } from '../src/assessment/assessment-booking-gate';

const DB_URL = process.env.PYG609_DATABASE_URL;
if (DB_URL) {
  const url = new URL(DB_URL);
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/pyg609_test' ||
    /supabase/i.test(DB_URL)
  ) {
    throw new Error(
      'PYG609_DATABASE_URL must point to the disposable localhost pyg609_test database',
    );
  }
} else if (process.env.CI) {
  throw new Error(
    'PYG609_DATABASE_URL is required in CI; do not skip database tests',
  );
}
const describeDb = DB_URL ? describe : describe.skip;

describeDb('PYG-609 assessment: Postgres transactions and races', () => {
  let prisma: PrismaService;
  let assessments: AssessmentService;
  let recipients: CareRecipientsService;
  const userIds: string[] = [];
  beforeAll(async () => {
    // Let the adapter own its pool so $disconnect closes every connection.
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DB_URL }),
    }) as PrismaService;
    await prisma.$connect();
    assessments = new AssessmentService(prisma, new ConsentService(prisma));
    recipients = new CareRecipientsService(prisma);
  });
  afterAll(async () => {
    if (prisma) {
      await prisma.careRecipientAssessment.deleteMany({
        where: { assessedBy: { in: userIds } },
      });
      await prisma.booking.deleteMany({
        where: { patientId: { in: userIds } },
      });
      await prisma.careRecipient.deleteMany({
        where: { patientId: { in: userIds } },
      });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.$disconnect();
    }
  });
  async function fixture() {
    const uid = randomUUID();
    const owner = await prisma.user.create({
      data: { supabaseUid: uid, email: `${uid}@pyg609.test`, role: 1 },
    });
    userIds.push(owner.id);
    const recipient = await prisma.careRecipient.create({
      data: {
        patientId: owner.id,
        name: 'Assessment test',
        medical_conditions: [],
      },
    });
    const input = {
      careRecipientId: recipient.id,
      answers: ADL_ITEMS.map(({ code, maxScore }) => ({
        code,
        value: maxScore as number | null,
      })),
      flags: [] as string[],
      noSpecialConditions: true,
    };
    return { owner, recipient, input };
  }
  it('creates, replaces and reads one row, updates time and profile hasAssessment', async () => {
    const { owner, recipient, input } = await fixture();
    expect((await recipients.list(owner.id))[0].hasAssessment).toBe(false);
    expect(await assessments.read(owner.id, recipient.id)).toBeNull();
    const first = await assessments.submit(owner.id, {
      ...input,
      flags: ['dementia'],
      noSpecialConditions: false,
      dementiaSevere: true,
    });
    expect(first.adlTotalScore).toBe(20);
    const second = await assessments.submit(owner.id, {
      ...input,
      answers: input.answers.map((a) => ({ ...a, value: null })),
    });
    expect(second).toMatchObject({
      adlTotalScore: 0,
      unsureCount: 10,
      hasUnsureFlag: true,
      flags: [],
      dementiaSevere: null,
    });
    expect(second.assessedAt.getTime()).toBeGreaterThan(
      first.assessedAt.getTime(),
    );
    expect((await assessments.read(owner.id, recipient.id))?.answers).toEqual(
      second.answers,
    );
    expect((await recipients.list(owner.id))[0].hasAssessment).toBe(true);
    expect(
      await prisma.careRecipientAssessment.count({
        where: { careRecipientId: recipient.id },
      }),
    ).toBe(1);
  });
  it('invalid replacement leaves all stored fields unchanged', async () => {
    const { owner, recipient, input } = await fixture();
    await assessments.submit(owner.id, input);
    const before = await prisma.careRecipientAssessment.findUnique({
      where: { careRecipientId: recipient.id },
    });
    await expect(
      assessments.submit(owner.id, {
        ...input,
        answers: input.answers.slice(1),
      }),
    ).rejects.toMatchObject({ extensions: { code: 'ASSESSMENT_INCOMPLETE' } });
    expect(
      await prisma.careRecipientAssessment.findUnique({
        where: { careRecipientId: recipient.id },
      }),
    ).toEqual(before);
  });
  it('concurrent first saves never duplicate or mix answers and derived fields', async () => {
    for (let round = 0; round < 10; round++) {
      const { owner, recipient, input } = await fixture();
      await Promise.all([
        assessments.submit(owner.id, input),
        assessments.submit(owner.id, {
          ...input,
          answers: input.answers.map((a) => ({ ...a, value: null })),
        }),
      ]);
      const rows = await prisma.careRecipientAssessment.findMany({
        where: { careRecipientId: recipient.id },
      });
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect([0, 20]).toContain(row.adlTotalScore);
      expect(row.unsureCount).toBe(row.adlTotalScore === 0 ? 10 : 0);
      expect(row.hasUnsureFlag).toBe(row.unsureCount === 10);
    }
  }, 20000);
  it('hides and deletes assessment without changing an unfinished booking', async () => {
    const { owner, recipient, input } = await fixture();
    await assessments.submit(owner.id, input);
    const booking = await prisma.booking.create({
      data: {
        patientId: owner.id,
        careRecipientId: recipient.id,
        status: 'in_progress',
        serviceType: 'elderly_care',
        timeSlot: 'morning',
        bookingDate: new Date('2026-10-20'),
        locationAddress: 'Test',
        startTime: new Date('1970-01-01T09:00:00.000Z'),
        durationHours: 4,
      },
    });
    await recipients.remove(owner.id, recipient.id);
    expect(
      await prisma.careRecipientAssessment.count({
        where: { careRecipientId: recipient.id },
      }),
    ).toBe(0);
    expect(
      await prisma.careRecipient.findUnique({ where: { id: recipient.id } }),
    ).toMatchObject({ is_deleted: true });
    expect(
      await prisma.booking.findUnique({ where: { id: booking.id } }),
    ).toEqual(booking);
  });
  it('hiding a profile without an assessment still succeeds', async () => {
    const { owner, recipient } = await fixture();
    await recipients.remove(owner.id, recipient.id);
    expect(
      await prisma.careRecipient.findUnique({ where: { id: recipient.id } }),
    ).toMatchObject({ is_deleted: true });
  });
  it('rolls back hiding if assessment cleanup fails', async () => {
    const { owner, recipient, input } = await fixture();
    await assessments.submit(owner.id, input);
    const failing = new CareRecipientsService({
      careRecipient: prisma.careRecipient,
      $transaction: (fn) =>
        prisma.$transaction((tx) =>
          fn(
            new Proxy(tx, {
              get(target, property) {
                if (property === 'careRecipientAssessment')
                  return { deleteMany: () => tx.$executeRaw`SELECT 1 / 0` };
                return Reflect.get(target, property);
              },
            }),
          ),
        ),
    } as unknown as PrismaService);
    await expect(failing.remove(owner.id, recipient.id)).rejects.toThrow();
    expect(
      await prisma.careRecipient.findUnique({ where: { id: recipient.id } }),
    ).toMatchObject({ is_deleted: false, deleted_at: null });
    expect(
      await prisma.careRecipientAssessment.count({
        where: { careRecipientId: recipient.id },
      }),
    ).toBe(1);
  });
  it('a save racing with hiding cannot resurrect health data', async () => {
    for (let round = 0; round < 10; round++) {
      const { owner, recipient, input } = await fixture();
      const outcomes = await Promise.allSettled([
        assessments.submit(owner.id, input),
        recipients.remove(owner.id, recipient.id),
      ]);
      expect(outcomes[1].status).toBe('fulfilled');
      expect(
        await prisma.careRecipientAssessment.count({
          where: { careRecipientId: recipient.id },
        }),
      ).toBe(0);
      await expect(assessments.submit(owner.id, input)).rejects.toMatchObject({
        extensions: { code: 'ASSESSMENT_ACCESS_DENIED' },
      });
    }
  }, 20000);
  it('the real gate rejects an unassessed recipient and allows only that assessed profile', async () => {
    const { owner, recipient, input } = await fixture();
    await expect(
      prisma.$transaction((tx) =>
        assertBookingAssessment(tx, recipient.id, 'graphql'),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'ASSESSMENT_REQUIRED' } });
    await assessments.submit(owner.id, input);
    await expect(
      prisma.$transaction((tx) =>
        assertBookingAssessment(tx, recipient.id, 'graphql'),
      ),
    ).resolves.toBeUndefined();
    const other = await fixture();
    await expect(
      prisma.$transaction((tx) =>
        assertBookingAssessment(tx, other.recipient.id, 'rest'),
      ),
    ).rejects.toMatchObject({
      response: { code: 'ASSESSMENT_REQUIRED', statusCode: 422 },
    });
  });
});
