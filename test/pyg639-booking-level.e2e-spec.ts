/** S16/S17 atomicity against the guarded disposable Docker database only. */
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaService } from '../src/common/prisma.service';
import { AssessmentService } from '../src/assessment/assessment.service';
import { ConsentService } from '../src/consent/consent.service';
import { ADL_ITEMS } from '../src/assessment/assessment.constants';
import { BookingService } from '../src/booking/booking.service';
import { CareActivityService } from '../src/care-activity/care-activity.service';
import { ClockService } from '../src/common/clock.service';
import { recalculateBookingRequirements } from '../src/booking/booking-requirements.persistence';
import { lockRequiredSkillRecipient } from '../src/booking/required-skills/required-skills.persistence';
import { readSavedBookingLevels } from '../src/booking/level/booking-level.read';
import { seedBookingLevelRules } from './fixtures/booking-level-rules';
const urlValue = process.env.PYG609_DATABASE_URL;
if (urlValue) {
  const url = new URL(urlValue);
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname != '/pyg609_test' ||
    /supabase/i.test(urlValue)
  )
    throw new Error('S16 tests require disposable localhost pyg609_test');
} else if (process.env.CI)
  throw new Error('PYG609_DATABASE_URL required in CI');
const describeDb = urlValue ? describe : describe.skip;
describeDb('PYG-639 booking levels: Postgres atomicity and lifecycle', () => {
  let db: PrismaService;
  let sql: Client;
  let assessments: AssessmentService;
  let bookings: BookingService;
  const owners: string[] = [];
  const newActivities: string[] = [];
  const qr = { createForBooking: jest.fn().mockResolvedValue(undefined) };
  beforeAll(async () => {
    db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: urlValue }),
    }) as PrismaService;
    await db.$connect();
    await seedBookingLevelRules(db);
    sql = new Client({ connectionString: urlValue });
    await sql.connect();
    await sql.query(
      readFileSync(
        join(
          __dirname,
          '../prisma/migrations/20261009000000_pyg570_seed_required_skills/migration.sql',
        ),
        'utf8',
      ),
    );
    for (const serviceType of ['elderly_care', 'physiotherapy'])
      await db.servicePriceCatalog.upsert({
        where: { serviceType },
        create: { serviceType, pricePerHour: 100 },
        update: { isActive: true },
      });
    assessments = new AssessmentService(db, new ConsentService(db));
    bookings = new BookingService(
      db,
      { emit: jest.fn() } as never,
      {} as never,
      qr as never,
      new ConsentService(db),
      {} as never,
      new CareActivityService(db, new ClockService()),
    );
  });
  afterAll(async () => {
    if (db) {
      await db.booking.deleteMany({ where: { patientId: { in: owners } } });
      await db.careRecipientAssessment.deleteMany({
        where: { assessedBy: { in: owners } },
      });
      await db.careRecipient.deleteMany({
        where: { patientId: { in: owners } },
      });
      await db.user.deleteMany({ where: { id: { in: owners } } });
      await db.careActivity.deleteMany({
        where: { id: { in: newActivities } },
      });
      await db.$disconnect();
    }
    await sql?.end();
  });
  async function fixture(assessed = true) {
    const uid = randomUUID();
    const owner = await db.user.create({
      data: {
        supabaseUid: uid,
        email: `${uid}@pyg639.test`,
        firstName: 'Test',
        lastName: 'S16',
        role: 1,
      },
    });
    owners.push(owner.id);
    const recipient = await db.careRecipient.create({
      data: {
        patientId: owner.id,
        name: 'S16',
        medical_conditions: ['injection'],
        mobility_level: 'bedridden',
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
    if (assessed) await assessments.submit(owner.id, input);
    return { owner, recipient, input };
  }
  async function rawBooking(
    f: Awaited<ReturnType<typeof fixture>>,
    status = 'unmatched',
  ) {
    return db.booking.create({
      data: {
        patientId: f.owner.id,
        careRecipientId: f.recipient.id,
        status,
        serviceType: 'elderly_care',
        timeSlot: 'morning',
        bookingDate: new Date('2035-10-20'),
        locationAddress: 'Test',
        startTime: new Date('1970-01-01T09:00:00Z'),
        durationHours: 4,
        tasks: ['ฉีดยา', 'กายภาพบำบัด'],
      },
    });
  }
  const createInput = (recipientId: string, serviceType = 'elderly_care') => ({
    careRecipientId: recipientId,
    tasks: ['custom'],
    serviceLocations: ['บ้าน'],
    serviceType,
    bookingDate: '2035-10-20',
    startTime: '09:00',
    endTime: '13:00',
    durationHours: 4,
    locationAddress: 'Test',
  });
  const recalc = (id: string) =>
    db.$transaction((tx) => recalculateBookingRequirements(tx, id));
  const snapshot = async (id: string) => {
    const b = await db.booking.findUniqueOrThrow({ where: { id } });
    return {
      requiredLevel: b.requiredLevel,
      adl: b.levelFromAdl,
      flags: b.levelFromFlags,
      services: b.levelFromServices,
      time: b.levelCalculatedAt,
      skills: (
        await db.$queryRaw<
          { skills: string[] | null }[]
        >`SELECT required_skills AS skills FROM bookings WHERE id=${id}::uuid`
      )[0].skills,
      rows: await db.bookingRequiredSkill.findMany({
        where: { bookingId: id },
        orderBy: { skillCode: 'asc' },
      }),
    };
  };
  it('creation persists all criteria, marker and S17 skills together and returns the REST contract', async () => {
    const f = await fixture();
    await assessments.submit(f.owner.id, {
      ...f.input,
      flags: ['injection'],
      noSpecialConditions: false,
    });
    const result = await bookings.createBooking(
      f.owner.id,
      createInput(f.recipient.id),
    );
    expect(result).toMatchObject({
      requiredLevel: 'ADVANCED',
      levelBreakdown: { adl: 'BASIC', flags: 'ADVANCED', services: null },
      requiredSkills: [{ skill: { code: 'injection' }, sources: ['FLAG'] }],
    });
    expect(await snapshot(result.id)).toMatchObject({
      requiredLevel: 'advanced',
      adl: 'basic',
      flags: 'advanced',
      services: null,
      time: expect.any(Date),
      skills: ['injection'],
    });
    qr.createForBooking.mockRejectedValueOnce(new Error('rollback QR'));
    await expect(
      bookings.createBooking(f.owner.id, {
        ...createInput(f.recipient.id),
        bookingDate: '2035-10-21',
      }),
    ).rejects.toThrow('rollback QR');
    expect(await db.booking.count({ where: { patientId: f.owner.id } })).toBe(
      1,
    );
  });
  it('physiotherapy serviceType resolves F03 advanced even without selected activities', async () => {
    const f = await fixture();
    const result = await bookings.createBooking(
      f.owner.id,
      createInput(f.recipient.id, 'physiotherapy'),
    );
    expect(result).toMatchObject({
      requiredLevel: 'ADVANCED',
      levelBreakdown: { adl: 'BASIC', flags: null, services: 'ADVANCED' },
      requiredSkills: [{ skill: { code: 'physiotherapy' } }],
    });
    expect(
      await db.bookingActivity.count({ where: { bookingId: result.id } }),
    ).toBe(0);
  });
  it('recalculates every unconfirmed sibling from the same new assessment and ignores free text', async () => {
    const f = await fixture();
    const a = await rawBooking(f),
      b = await rawBooking(f, 'accepted');
    await assessments.submit(f.owner.id, {
      ...f.input,
      answers: f.input.answers.map((a) => ({ ...a, value: 0 })),
    });
    for (const booking of [a, b])
      expect(await snapshot(booking.id)).toMatchObject({
        requiredLevel: 'advanced',
        adl: 'advanced',
        flags: null,
        services: null,
        time: expect.any(Date),
        skills: expect.arrayContaining(['bathing', 'transfer_assist']),
      });
    await assessments.submit(f.owner.id, f.input);
    for (const booking of [a, b])
      expect(await snapshot(booking.id)).toMatchObject({
        requiredLevel: 'basic',
        adl: 'basic',
        flags: null,
        services: null,
        skills: [],
      });
  });
  it('null ADL answers contribute zero and hasUnsureFlag contributes intermediate independently', async () => {
    const f = await fixture();
    const b = await rawBooking(f);
    const answers = f.input.answers.map((a, index) =>
      index < 3 ? { ...a, value: null } : a,
    );
    await assessments.submit(f.owner.id, { ...f.input, answers });
    const assessment = await db.careRecipientAssessment.findUniqueOrThrow({
      where: { careRecipientId: f.recipient.id },
    });
    expect(assessment.hasUnsureFlag).toBe(true);
    expect(assessment.adlTotalScore).toBe(
      answers.reduce((sum, a) => sum + (a.value ?? 0), 0),
    );
    expect(await snapshot(b.id)).toMatchObject({ flags: 'intermediate' });
  });
  it('selected activity creation and future replacements use DB levels in the same transaction', async () => {
    const f = await fixture();
    const code = `S16-${randomUUID()}`;
    const activity = await db.careActivity.create({
      data: {
        code,
        nameTh: 'S16 test',
        category: 'S16',
        careLevel: 'intermediate',
      },
    });
    newActivities.push(activity.id);
    const result = await bookings.createBooking(f.owner.id, {
      ...createInput(f.recipient.id),
      activityIds: [activity.id],
    });
    expect(result.levelBreakdown?.services).toBe('INTERMEDIATE');
    await db.$transaction(async (tx) => {
      await lockRequiredSkillRecipient(tx, f.recipient.id);
      await tx.bookingActivity.deleteMany({ where: { bookingId: result.id } });
      await recalculateBookingRequirements(tx, result.id);
    });
    expect(await snapshot(result.id)).toMatchObject({
      requiredLevel: 'basic',
      services: null,
    });
  });
  it.each(['missing', 'inactive'])(
    'a %s Flag rule gives E7 and rolls back creation and every assessment/booking snapshot',
    async (mode) => {
      const f = await fixture();
      const a = await rawBooking(f),
        b = await rawBooking(f, 'pending');
      await recalc(a.id);
      await recalc(b.id);
      const previous = await Promise.all([snapshot(a.id), snapshot(b.id)]);
      const beforeAssessment = await db.careRecipientAssessment.findUnique({
        where: { careRecipientId: f.recipient.id },
      });
      const rule = await db.bookingLevelRule.findUniqueOrThrow({
        where: {
          source_code_variant: {
            source: 'flag',
            code: 'injection',
            variant: '',
          },
        },
      });
      if (mode === 'inactive')
        await db.bookingLevelRule.update({
          where: {
            source_code_variant: {
              source: rule.source,
              code: rule.code,
              variant: rule.variant,
            },
          },
          data: { isActive: false },
        });
      else
        await db.bookingLevelRule.delete({
          where: {
            source_code_variant: {
              source: rule.source,
              code: rule.code,
              variant: rule.variant,
            },
          },
        });
      try {
        await expect(
          assessments.submit(f.owner.id, {
            ...f.input,
            flags: ['injection'],
            noSpecialConditions: false,
          }),
        ).rejects.toMatchObject({
          extensions: { code: 'BOOKING_LEVEL_RULE_MISSING', statusCode: 422 },
        });
        expect(await Promise.all([snapshot(a.id), snapshot(b.id)])).toEqual(
          previous,
        );
        expect(
          await db.careRecipientAssessment.findUnique({
            where: { careRecipientId: f.recipient.id },
          }),
        ).toEqual(beforeAssessment);
        // Directly prepare the source to exercise the REST creation error boundary.
        await db.careRecipientAssessment.update({
          where: { careRecipientId: f.recipient.id },
          data: { flags: ['injection'], noSpecialConditions: false },
        });
        await expect(
          bookings.createBooking(f.owner.id, {
            ...createInput(f.recipient.id),
            bookingDate: '2035-10-22',
          }),
        ).rejects.toMatchObject({
          response: { statusCode: 422, code: 'BOOKING_LEVEL_RULE_MISSING' },
        });
        expect(
          await db.booking.count({ where: { patientId: f.owner.id } }),
        ).toBe(2);
      } finally {
        await db.bookingLevelRule.upsert({
          where: {
            source_code_variant: {
              source: rule.source,
              code: rule.code,
              variant: rule.variant,
            },
          },
          create: rule,
          update: { isActive: true },
        });
      }
    },
  );
  it('a skills failure after level write rolls back the timestamp, all levels and the source assessment', async () => {
    const f = await fixture();
    const b = await rawBooking(f);
    await recalc(b.id);
    const before = await snapshot(b.id);
    const assessmentBefore = await db.careRecipientAssessment.findUnique({
      where: { careRecipientId: f.recipient.id },
    });
    await db.careSkill.update({
      where: { code: 'injection' },
      data: { isActive: false },
    });
    try {
      await expect(
        assessments.submit(f.owner.id, {
          ...f.input,
          flags: ['injection'],
          noSpecialConditions: false,
        }),
      ).rejects.toMatchObject({ extensions: { code: 'SKILL_RULE_INVALID' } });
      expect(await snapshot(b.id)).toEqual(before);
      expect(
        await db.careRecipientAssessment.findUnique({
          where: { careRecipientId: f.recipient.id },
        }),
      ).toEqual(assessmentBefore);
    } finally {
      await db.careSkill.update({
        where: { code: 'injection' },
        data: { isActive: true },
      });
    }
  });
  it('confirmation freezes levels, calculation time and skills despite source/rule changes', async () => {
    const f = await fixture();
    const b = await rawBooking(f, 'accepted');
    await assessments.submit(f.owner.id, {
      ...f.input,
      flags: ['injection'],
      noSpecialConditions: false,
    });
    await bookings.confirmBooking(b.id, f.owner.id);
    const frozen = await snapshot(b.id);
    await assessments.submit(f.owner.id, f.input);
    await db.bookingLevelRule.updateMany({
      where: { source: 'flag', code: 'injection' },
      data: { isActive: false },
    });
    try {
      await recalc(b.id);
      expect(await snapshot(b.id)).toEqual(frozen);
      expect(
        (await readSavedBookingLevels(db, [b.id])).get(b.id)?.requiredLevel,
      ).toBe('advanced');
    } finally {
      await seedBookingLevelRules(db);
    }
  });
  it('concurrent save/confirmation keeps level and skills from one assessment version', async () => {
    for (let i = 0; i < 5; i++) {
      const f = await fixture();
      const b = await rawBooking(f, 'accepted');
      await Promise.all([
        assessments.submit(f.owner.id, {
          ...f.input,
          flags: ['injection'],
          noSpecialConditions: false,
        }),
        bookings.confirmBooking(b.id, f.owner.id),
      ]);
      const saved = await snapshot(b.id);
      expect(saved.requiredLevel).toBe(
        saved.skills?.includes('injection') ? 'advanced' : 'basic',
      );
      const frozen = await snapshot(b.id);
      await assessments.submit(f.owner.id, {
        ...f.input,
        answers: f.input.answers.map((a) => ({ ...a, value: 0 })),
      });
      expect(await snapshot(b.id)).toEqual(frozen);
    }
  }, 20000);
  it('legacy reads stay null; missing assessment fails without mobility/medical fallback', async () => {
    const f = await fixture(false);
    const b = await rawBooking(f);
    expect((await readSavedBookingLevels(db, [b.id])).get(b.id)).toEqual({
      requiredLevel: null,
      levelBreakdown: null,
    });
    await expect(recalc(b.id)).rejects.toMatchObject({
      extensions: { code: 'ASSESSMENT_REQUIRED' },
    });
    expect(await snapshot(b.id)).toMatchObject({
      requiredLevel: null,
      time: null,
      skills: null,
    });
  });
});
