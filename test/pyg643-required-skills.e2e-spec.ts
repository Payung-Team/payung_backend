/** Real S17 writes/races against the disposable PYG-609 Docker Postgres only. */
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaService } from '../src/common/prisma.service';
import { AssessmentService } from '../src/assessment/assessment.service';
import { ConsentService } from '../src/consent/consent.service';
import { ADL_ITEMS } from '../src/assessment/assessment.constants';
import { BookingService } from '../src/booking/booking.service';
import { CareActivityService } from '../src/care-activity/care-activity.service';
import { ClockService } from '../src/common/clock.service';
import {
  recalculateBookingRequiredSkills,
  lockRequiredSkillRecipient,
} from '../src/booking/required-skills/required-skills.persistence';
import { readSavedRequiredSkills } from '../src/booking/required-skills/required-skills.read';

const URL_VALUE = process.env.PYG609_DATABASE_URL;
if (URL_VALUE) {
  const url = new URL(URL_VALUE);
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/pyg609_test' ||
    /supabase/i.test(URL_VALUE)
  ) {
    throw new Error(
      'PYG609_DATABASE_URL must use the disposable localhost pyg609_test database',
    );
  }
} else if (process.env.CI)
  throw new Error('PYG609_DATABASE_URL is required in CI for S17');
const describeDb = URL_VALUE ? describe : describe.skip;

describeDb('PYG-643 Required Skills: Postgres transactions and races', () => {
  let db: PrismaService;
  let sql: Client;
  let assessments: AssessmentService;
  let bookings: BookingService;
  const owners: string[] = [];
  const activityIds: string[] = [];
  const qr = { createForBooking: jest.fn().mockResolvedValue(undefined) };
  beforeAll(async () => {
    db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: URL_VALUE }),
    }) as PrismaService;
    await db.$connect();
    sql = new Client({ connectionString: URL_VALUE });
    await sql.connect();
    // Fixture seed on a strictly local disposable DB; never migrate the real DB.
    await sql.query(
      readFileSync(
        join(
          __dirname,
          '../prisma/migrations/20261009000000_pyg570_seed_required_skills/migration.sql',
        ),
        'utf8',
      ),
    );
    await db.servicePriceCatalog.upsert({
      where: { serviceType: 'elderly_care' },
      create: { serviceType: 'elderly_care', pricePerHour: 100 },
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
      await db.careActivity.deleteMany({ where: { id: { in: activityIds } } });
      await db.$disconnect();
    }
    await sql?.end();
  });
  async function fixture(status = 'unmatched', assessed = true) {
    const uid = randomUUID();
    const owner = await db.user.create({
      data: {
        supabaseUid: uid,
        email: `${uid}@pyg643.test`,
        firstName: 'Test',
        lastName: 'S17',
        role: 1,
      },
    });
    owners.push(owner.id);
    const recipient = await db.careRecipient.create({
      data: {
        patientId: owner.id,
        name: 'S17 test',
        medical_conditions: [],
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
    const booking = await db.booking.create({
      data: {
        patientId: owner.id,
        careRecipientId: recipient.id,
        status,
        serviceType: 'elderly_care',
        timeSlot: 'morning',
        bookingDate: new Date('2035-10-20'),
        locationAddress: 'Test',
        startTime: new Date('1970-01-01T09:00:00Z'),
        durationHours: 4,
      },
    });
    return { owner, recipient, input, booking };
  }
  async function recalc(id: string) {
    await db.$transaction((tx) => recalculateBookingRequiredSkills(tx, id));
  }
  async function stored(id: string) {
    return {
      codes: (await db.booking.findUniqueOrThrow({ where: { id } }))
        .requiredSkills,
      rows: await db.bookingRequiredSkill.findMany({
        where: { bookingId: id },
        orderBy: { skillCode: 'asc' },
      }),
    };
  }
  async function activity(code: string) {
    const found = await db.careActivity.findUnique({ where: { code } });
    if (found) return found;
    const row = await db.careActivity.create({
      data: {
        code,
        nameTh: `S17 ${code}`,
        category: 'S17 test',
        careLevel: 'basic',
      },
    });
    activityIds.push(row.id);
    return row;
  }
  async function selectActivity(
    tx: Prisma.TransactionClient,
    bookingId: string,
    a: Awaited<ReturnType<typeof activity>>,
  ) {
    await tx.bookingActivity.create({
      data: {
        bookingId,
        careActivityId: a.id,
        activityName: a.nameTh,
        category: a.category,
        careLevel: a.careLevel,
      },
    });
  }
  it('persists [] in both locations; reads legacy NULL distinctly without using the S16 timestamp', async () => {
    const { booking } = await fixture();
    await sql.query(
      'UPDATE bookings SET required_skills=NULL, level_calculated_at=now() WHERE id=$1',
      [booking.id],
    );
    expect(
      (await readSavedRequiredSkills(db, [booking.id])).get(booking.id),
    ).toBeNull();
    await recalc(booking.id);
    expect(await stored(booking.id)).toEqual({ codes: [], rows: [] });
    expect(
      (await readSavedRequiredSkills(db, [booking.id])).get(booking.id),
    ).toEqual([]);
  });
  it('assessment edits replace all affected pre-confirmation snapshots; never includes free-text tasks', async () => {
    const { owner, input, booking } = await fixture();
    const second = await db.booking.create({
      data: {
        patientId: owner.id,
        careRecipientId: input.careRecipientId,
        status: 'pending',
        serviceType: 'elderly_care',
        timeSlot: 'morning',
        bookingDate: new Date('2035-10-21'),
        startTime: new Date('1970-01-01T09:00:00Z'),
        durationHours: 4,
        locationAddress: 'Test',
        tasks: ['ฉีดยา', 'กายภาพบำบัด'],
      },
    });
    await assessments.submit(owner.id, {
      ...input,
      answers: input.answers.map((a) => ({
        ...a,
        value: a.code === 'transfers' ? 1 : a.code === 'bathing' ? 0 : a.value,
      })),
    });
    for (const id of [booking.id, second.id])
      expect((await stored(id)).codes).toEqual(['bathing', 'transfer_assist']);
    await assessments.submit(owner.id, input);
    for (const id of [booking.id, second.id])
      expect(await stored(id)).toEqual({ codes: [], rows: [] });
  });
  it('the S15 hook uses the same transaction as activity replacement and unions FLAG/SERVICE', async () => {
    const { owner, input, booking } = await fixture();
    const a = await activity('C04');
    await assessments.submit(owner.id, {
      ...input,
      flags: ['ng_tube'],
      noSpecialConditions: false,
    });
    await db.$transaction(async (tx) => {
      await lockRequiredSkillRecipient(tx, input.careRecipientId);
      await selectActivity(tx, booking.id, a);
      await recalculateBookingRequiredSkills(tx, booking.id);
    });
    expect((await stored(booking.id)).rows).toEqual([
      expect.objectContaining({
        skillCode: 'tube_feeding',
        sources: ['flag', 'service'],
      }),
    ]);
    await db.$transaction(async (tx) => {
      await lockRequiredSkillRecipient(tx, input.careRecipientId);
      await tx.bookingActivity.deleteMany({ where: { bookingId: booking.id } });
      await recalculateBookingRequiredSkills(tx, booking.id);
    });
    expect((await stored(booking.id)).rows).toEqual([
      expect.objectContaining({ skillCode: 'tube_feeding', sources: ['flag'] }),
    ]);
  });
  it('physiotherapy is produced for F03 without any required booking level', async () => {
    const { input, booking } = await fixture();
    const a = await activity('F03');
    await db.$transaction(async (tx) => {
      await lockRequiredSkillRecipient(tx, input.careRecipientId);
      await selectActivity(tx, booking.id, a);
      await recalculateBookingRequiredSkills(tx, booking.id);
    });
    expect((await stored(booking.id)).codes).toEqual(['physiotherapy']);
    expect(
      (await db.booking.findUniqueOrThrow({ where: { id: booking.id } }))
        .requiredLevel,
    ).toBeNull();
  });
  it('the future service-edit hook gives a physiotherapy booking F03 skills without requiring selected activities', async () => {
    const { input, booking } = await fixture();
    await db.$transaction(async (tx) => {
      await lockRequiredSkillRecipient(tx, input.careRecipientId);
      await tx.booking.update({
        where: { id: booking.id },
        data: { serviceType: 'physiotherapy' },
      });
      await recalculateBookingRequiredSkills(tx, booking.id);
    });
    expect((await stored(booking.id)).codes).toEqual(['physiotherapy']);
    expect(
      await db.bookingActivity.count({ where: { bookingId: booking.id } }),
    ).toBe(0);
  });
  it('REST creation returns SKILL_RULE_INVALID/422 and rolls back a new booking when a matched skill is inactive', async () => {
    const { owner, input, booking } = await fixture();
    await assessments.submit(owner.id, {
      ...input,
      flags: ['injection'],
      noSpecialConditions: false,
    });
    await db.booking.delete({ where: { id: booking.id } });
    await db.careSkill.update({
      where: { code: 'injection' },
      data: { isActive: false },
    });
    try {
      const attempt = bookings.createBooking(owner.id, {
        careRecipientId: input.careRecipientId,
        tasks: ['custom'],
        serviceLocations: ['บ้าน'],
        serviceType: 'elderly_care',
        bookingDate: '2035-10-20',
        startTime: '09:00',
        endTime: '13:00',
        locationAddress: 'Test',
      });
      await expect(attempt).rejects.toMatchObject({
        response: { statusCode: 422, code: 'SKILL_RULE_INVALID' },
      });
      expect(await db.booking.count({ where: { patientId: owner.id } })).toBe(
        0,
      );
    } finally {
      await db.careSkill.update({
        where: { code: 'injection' },
        data: { isActive: true },
      });
    }
  });
  it('creation calls the real writer inside its booking/tasks/QR transaction and REST returns the contract', async () => {
    const { owner, input, booking } = await fixture();
    await db.booking.delete({ where: { id: booking.id } });
    await assessments.submit(owner.id, {
      ...input,
      flags: ['injection'],
      noSpecialConditions: false,
    });
    const result = await bookings.createBooking(owner.id, {
      careRecipientId: input.careRecipientId,
      tasks: ['custom'],
      serviceLocations: ['บ้าน'],
      serviceType: 'elderly_care',
      bookingDate: '2035-10-20',
      startTime: '09:00',
      endTime: '13:00',
      durationHours: 4,
      locationAddress: 'Test',
    });
    expect(result.requiredSkills).toHaveLength(1);
    expect(result.requiredSkills?.[0]).toMatchObject({
      skill: { code: 'injection', lockedProfessions: ['nurse'] },
      sources: ['FLAG'],
    });
    expect((await stored(result.id)).codes).toEqual(['injection']);
    expect(
      await db.booking_tasks.count({ where: { booking_id: result.id } }),
    ).toBe(1);
    qr.createForBooking.mockRejectedValueOnce(
      new Error('simulated QR failure'),
    );
    await expect(
      bookings.createBooking(owner.id, {
        careRecipientId: input.careRecipientId,
        tasks: ['custom'],
        serviceLocations: ['บ้าน'],
        serviceType: 'elderly_care',
        bookingDate: '2035-10-22',
        startTime: '09:00',
        endTime: '13:00',
        durationHours: 4,
        locationAddress: 'Test',
      }),
    ).rejects.toThrow('simulated QR failure');
    expect(await db.booking.count({ where: { patientId: owner.id } })).toBe(1);
  });
  it('E11 fails assessment edits atomically, keeping the assessment and both saved skill locations', async () => {
    const { owner, input, booking } = await fixture();
    await recalc(booking.id);
    const previous = await db.careRecipientAssessment.findUnique({
      where: { careRecipientId: input.careRecipientId },
    });
    await db.careSkill.update({
      where: { code: 'injection' },
      data: { isActive: false },
    });
    try {
      await expect(
        assessments.submit(owner.id, {
          ...input,
          flags: ['injection'],
          noSpecialConditions: false,
        }),
      ).rejects.toMatchObject({
        extensions: { code: 'SKILL_RULE_INVALID', statusCode: 422 },
      });
      expect(
        await db.careRecipientAssessment.findUnique({
          where: { careRecipientId: input.careRecipientId },
        }),
      ).toEqual(previous);
      expect(await stored(booking.id)).toEqual({ codes: [], rows: [] });
    } finally {
      await db.careSkill.update({
        where: { code: 'injection' },
        data: { isActive: true },
      });
    }
  });
  it('SQL failure after deleting/reinserting skill rows rolls back the source assessment and both locations', async () => {
    const { owner, input, booking } = await fixture();
    await assessments.submit(owner.id, {
      ...input,
      flags: ['injection'],
      noSpecialConditions: false,
    });
    const before = await stored(booking.id);
    const assessmentBefore = await db.careRecipientAssessment.findUnique({
      where: { careRecipientId: input.careRecipientId },
    });
    const failing = new AssessmentService(
      {
        $transaction: (
          fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
        ) =>
          db.$transaction((tx) =>
            fn(
              new Proxy(tx, {
                get(target, property): unknown {
                  if (property === 'booking')
                    return new Proxy(tx.booking, {
                      get(delegate, key): unknown {
                        return key === 'update'
                          ? () => tx.$executeRaw`SELECT 1 / 0`
                          : Reflect.get(delegate, key);
                      },
                    });
                  return Reflect.get(target, property);
                },
              }),
            ),
          ),
      } as never,
      {} as never,
    );
    await expect(
      failing.submit(owner.id, {
        ...input,
        flags: ['ng_tube'],
        noSpecialConditions: false,
      }),
    ).rejects.toThrow();
    expect(await stored(booking.id)).toEqual(before);
    expect(
      await db.careRecipientAssessment.findUnique({
        where: { careRecipientId: input.careRecipientId },
      }),
    ).toEqual(assessmentBefore);
  });
  it('confirmation refreshes once and freezes skills across later assessment edits and rule changes', async () => {
    const { owner, input, booking } = await fixture('accepted');
    await assessments.submit(owner.id, {
      ...input,
      flags: ['injection'],
      noSpecialConditions: false,
    });
    await bookings.confirmBooking(booking.id, owner.id);
    const frozen = await stored(booking.id);
    await assessments.submit(owner.id, input);
    await db.careSkillRule.updateMany({
      where: { skillCode: 'injection' },
      data: { isActive: false },
    });
    try {
      await recalc(booking.id);
      await db.careSkill.update({
        where: { code: 'injection' },
        data: { isActive: false },
      });
      try {
        expect(
          (await readSavedRequiredSkills(db, [booking.id])).get(booking.id)?.[0]
            .skill.code,
        ).toBe('injection');
      } finally {
        await db.careSkill.update({
          where: { code: 'injection' },
          data: { isActive: true },
        });
      }
      expect(await stored(booking.id)).toEqual(frozen);
      await db.booking.update({
        where: { id: booking.id },
        data: { status: 'cancelled' },
      });
      await recalc(booking.id);
      expect(await stored(booking.id)).toEqual(frozen);
    } finally {
      await db.careSkillRule.updateMany({
        where: { skillCode: 'injection' },
        data: { isActive: true },
      });
    }
  });
  it('concurrent assessment save/confirmation never overwrites the confirmed snapshot', async () => {
    for (let round = 0; round < 5; round++) {
      const { owner, input, booking } = await fixture('accepted');
      await Promise.all([
        assessments.submit(owner.id, {
          ...input,
          flags: ['injection'],
          noSpecialConditions: false,
        }),
        bookings.confirmBooking(booking.id, owner.id),
      ]);
      const frozen = await stored(booking.id);
      expect([[], ['injection']]).toContainEqual(frozen.codes);
      await assessments.submit(owner.id, {
        ...input,
        flags: ['ng_tube'],
        noSpecialConditions: false,
      });
      expect(await stored(booking.id)).toEqual(frozen);
    }
  }, 20000);
  it('no assessment produces ASSESSMENT_REQUIRED, with no mobility/medical fallback or partial writes', async () => {
    const { booking } = await fixture('unmatched', false);
    const before = await stored(booking.id);
    await expect(recalc(booking.id)).rejects.toMatchObject({
      extensions: { code: 'ASSESSMENT_REQUIRED' },
    });
    expect(await stored(booking.id)).toEqual(before);
  });
});
