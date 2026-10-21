/**
 * PYG-611 · QA ของ S08 (PYG-563) — แบบประเมิน ADL และ Flags
 *
 * ยิง GraphQL / REST เข้าแอปจริง (harness: test/support/qa-e2e.ts) ต่อ Postgres ทิ้งได้ใน Docker
 * TC_NO = PYG-563_NN · รายงานผล: docs/qa/pyg-611-assessment-report.md
 *
 * expected ของคะแนน: คำนวณมือจากตาราง Barthel ADL ฉบับไทย 10 ข้อ เต็ม 20 (ช่วงคะแนนรายข้อตาม contract §2)
 *   ไม่อ่านจากโค้ดของระบบ · "ไม่แน่ใจ" = null นับเป็น 0 (มติ Sammy 9 ต.ค. 2026)
 * กติกาที่ contract PYG-607 ยังเป็น "ข้อเสนอ D4" (บังคับยืนยันไม่มีเงื่อนไข · บังคับระบุความรุนแรง) ระบุในชื่อเคสว่า (D4)
 * ไม่ครอบ (FE): ขั้นในหน้า onboarding, การกันบนจอ, ข้อความ AC7, การพาไปประเมิน AC10, ความกว้างมือถือ
 */
import {
  bootstrap,
  codeOf,
  describeDb,
  futureDate,
  GqlBody,
  Harness,
  seedProductionMasterData,
} from './support/qa-e2e';

type Answers = Record<string, number | null>;
type Assessment = {
  careRecipientId: string;
  answers: { code: string; value: number | null }[];
  adlTotalScore: number;
  unsureCount: number;
  flags: string[];
  noSpecialConditions: boolean;
  hasUnsureFlag: boolean;
  dementiaSevere: boolean | null;
  assessedAt: string;
};
type Res = { status: number; body: unknown };

/** ลำดับตามตาราง contract §2 */
const CODES = [
  'feeding',
  'grooming',
  'transfers',
  'toilet_use',
  'mobility',
  'dressing',
  'stairs',
  'bathing',
  'bowels',
  'bladder',
];
/** คะแนนเต็มรายข้อของ Barthel ADL (ไทย) — รวม 20 */
const MAX: Answers = {
  feeding: 2,
  grooming: 1,
  transfers: 3,
  toilet_use: 2,
  mobility: 3,
  dressing: 2,
  stairs: 2,
  bathing: 1,
  bowels: 2,
  bladder: 2,
};
const ZERO: Answers = Object.fromEntries(CODES.map((c) => [c, 0]));

const FIELDS =
  'careRecipientId answers { code value } adlTotalScore unsureCount flags noSpecialConditions hasUnsureFlag dementiaSevere assessedAt';
const SUBMIT = `mutation($input: SubmitCareRecipientAssessmentInput!) { submitCareRecipientAssessment(input: $input) { ${FIELDS} } }`;
const READ = `query($id: ID!) { careRecipientAssessment(careRecipientId: $id) { ${FIELDS} } }`;

const dataOf = <T>(body: GqlBody, field: string): T =>
  (body.data as Record<string, unknown>)[field] as T;
const restBody = (res: Res) => res.body as Record<string, unknown>;
const ext = (body: GqlBody) => body.errors?.[0]?.extensions ?? {};

describeDb('PYG-611 · S08 ADL & Flags assessment (PYG-563)', () => {
  let h: Harness;
  let day = 10;

  beforeAll(async () => {
    h = await bootstrap();
    await seedProductionMasterData();
    await h.prisma.servicePriceCatalog.upsert({
      where: { serviceType: 'elderly_care' },
      create: { serviceType: 'elderly_care', pricePerHour: 300 },
      update: { isActive: true },
    });
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  /** ญาติ + โปรไฟล์ผู้สูงอายุที่ยังไม่มีแบบประเมิน (เหมือนบัญชีเดิมก่อนฟีเจอร์) */
  async function owner() {
    const user = await h.seedUser('relative');
    const recipient = await h.prisma.careRecipient.create({
      data: {
        patientId: user.id,
        name: `ผู้สูงอายุทดสอบ ${user.id.slice(0, 4)}`,
        is_self: false,
      },
      select: { id: true },
    });
    return { user, recipientId: recipient.id };
  }
  type Owner = Awaited<ReturnType<typeof owner>>;

  const answersOf = (a: Answers) =>
    CODES.filter((c) => c in a).map((code) => ({ code, value: a[code] }));
  const input = (
    o: Owner,
    a: Answers,
    extra: Record<string, unknown> = {},
  ) => ({
    careRecipientId: o.recipientId,
    answers: answersOf(a),
    flags: [],
    noSpecialConditions: true,
    ...extra,
  });
  const submit = (
    who: { token: string } | null,
    inp: Record<string, unknown>,
  ) => h.gql(who ? who.token : null, SUBMIT, { input: inp });
  const rows = (o: Owner) =>
    h.prisma.careRecipientAssessment.count({
      where: { careRecipientId: o.recipientId },
    });

  async function submitOk(
    o: Owner,
    a: Answers,
    extra: Record<string, unknown> = {},
  ) {
    const body = await submit(o.user, input(o, a, extra));
    expect(body.errors).toBeUndefined();
    return dataOf<Assessment>(body, 'submitCareRecipientAssessment');
  }

  const book = (o: Owner) =>
    h.rest(o.user.token).post('/api/v1/bookings', {
      careRecipientId: o.recipientId,
      tasks: ['ดูแลทั่วไป'],
      serviceLocations: ['at_home'],
      serviceType: 'elderly_care',
      startTime: '09:00',
      endTime: '11:00',
      locationAddress: 'บ้านทดสอบ QA-611',
      bookingDate: futureDate(day++),
    });

  // ───────────────────────────── AC1 ─────────────────────────────
  describe('AC1 · ต้องตอบครบ', () => {
    it('PYG-563_01 Verify that a submission missing one ADL item returns ASSESSMENT_INCOMPLETE and writes nothing', async () => {
      const o = await owner();
      const { bladder: _drop, ...nine } = MAX;
      void _drop;
      const body = await submit(o.user, input(o, nine));
      expect(codeOf(body)).toBe('ASSESSMENT_INCOMPLETE');
      expect(ext(body)).toMatchObject({ missingAnswerCodes: ['bladder'] });
      expect(await rows(o)).toBe(0);
    });

    it('PYG-563_02 Verify that an item sent without a value property is treated as unanswered, not as "unsure"', async () => {
      const o = await owner();
      const answers = answersOf(MAX).map((x) =>
        x.code === 'stairs' ? { code: 'stairs' } : x,
      );
      const body = await submit(o.user, { ...input(o, MAX), answers });
      expect(codeOf(body)).toBe('ASSESSMENT_INCOMPLETE');
      expect(ext(body)).toMatchObject({ missingAnswerCodes: ['stairs'] });
      expect(await rows(o)).toBe(0);
    });
  });

  // ───────────────────────────── AC2 · คะแนน ─────────────────────────────
  describe('AC2 · คะแนนรวม (คำนวณมือจาก Barthel)', () => {
    it.each<[string, Answers, number, number]>([
      ['all 0', ZERO, 0, 0],
      ['all maximum', MAX, 20, 0],
      [
        'mid 1+1+2+1+2+1+1+0+1+1',
        {
          feeding: 1,
          grooming: 1,
          transfers: 2,
          toilet_use: 1,
          mobility: 2,
          dressing: 1,
          stairs: 1,
          bathing: 0,
          bowels: 1,
          bladder: 1,
        },
        11,
        0,
      ],
      [
        'contract example with 2 unsure (2+·+1+2+·+1+0+0+2+2)',
        {
          feeding: 2,
          grooming: null,
          transfers: 1,
          toilet_use: 2,
          mobility: null,
          dressing: 1,
          stairs: 0,
          bathing: 0,
          bowels: 2,
          bladder: 2,
        },
        10,
        2,
      ],
    ])(
      'PYG-563_03 Verify that answers "%s" give the hand-computed total and it is stored',
      async (_l, a, total, unsure) => {
        const o = await owner();
        const r = await submitOk(o, a);
        expect([r.adlTotalScore, r.unsureCount]).toEqual([total, unsure]);
        const row = await h.prisma.careRecipientAssessment.findFirstOrThrow({
          where: { careRecipientId: o.recipientId },
        });
        expect([row.adlTotalScore, row.unsureCount]).toEqual([total, unsure]);
        // คำตอบที่เก็บ: null คงเป็น null ไม่แทนด้วย 0
        expect(row.adlAnswers).toEqual(
          Object.fromEntries(CODES.map((c) => [c, a[c]])),
        );
      },
    );

    it('PYG-563_04 Verify that a total score sent by the client is rejected by the schema and not used', async () => {
      const o = await owner();
      const body = await submit(o.user, {
        ...input(o, ZERO),
        adlTotalScore: 20,
        unsureCount: 0,
        hasUnsureFlag: false,
      });
      expect(codeOf(body)).toBe('BAD_USER_INPUT');
      expect(await rows(o)).toBe(0);
    });
  });

  // ───────────────────────────── AC3 · Flags ─────────────────────────────
  describe('AC3 · Flags', () => {
    it('PYG-563_05 Verify that one flag and several flags are saved in full (returned in contract order)', async () => {
      const o1 = await owner();
      expect(
        (
          await submitOk(o1, MAX, {
            flags: ['diabetes'],
            noSpecialConditions: false,
          })
        ).flags,
      ).toEqual(['diabetes']);
      const o2 = await owner();
      const r = await submitOk(o2, MAX, {
        flags: ['fall_risk', 'oxygen', 'ng_tube'],
        noSpecialConditions: false,
      });
      expect(r.flags).toEqual(['ng_tube', 'oxygen', 'fall_risk']);
      const row = await h.prisma.careRecipientAssessment.findFirstOrThrow({
        where: { careRecipientId: o2.recipientId },
      });
      expect([...row.flags].sort()).toEqual(['fall_risk', 'ng_tube', 'oxygen']);
    });

    it('PYG-563_06 Verify that "no special conditions" alone is saved', async () => {
      const o = await owner();
      expect(await submitOk(o, MAX)).toMatchObject({
        flags: [],
        noSpecialConditions: true,
      });
    });

    it.each([
      ['an unknown code', ['heart_disease']],
      ['the system flag "unsure"', ['unsure']],
      ['a duplicated flag', ['oxygen', 'oxygen']],
    ])(
      'PYG-563_07 Verify that %s returns ASSESSMENT_FLAG_INVALID and writes nothing',
      async (_l, flags) => {
        const o = await owner();
        const body = await submit(
          o.user,
          input(o, MAX, { flags, noSpecialConditions: false }),
        );
        expect(codeOf(body)).toBe('ASSESSMENT_FLAG_INVALID');
        expect(await rows(o)).toBe(0);
      },
    );

    it('PYG-563_08 (D4) Verify that no flag and "no special conditions" = false returns ASSESSMENT_INCOMPLETE', async () => {
      const o = await owner();
      const body = await submit(
        o.user,
        input(o, MAX, { flags: [], noSpecialConditions: false }),
      );
      expect(codeOf(body)).toBe('ASSESSMENT_INCOMPLETE');
      expect(await rows(o)).toBe(0);
    });
  });

  // ───────────────────────────── AC4 ─────────────────────────────
  describe('AC4 · ไม่มีเงื่อนไขพิเศษ + Flag ขัดกัน', () => {
    it('PYG-563_09 Verify that "no special conditions" together with a flag returns ASSESSMENT_FLAGS_CONFLICT', async () => {
      const o = await owner();
      const body = await submit(
        o.user,
        input(o, MAX, { flags: ['oxygen'], noSpecialConditions: true }),
      );
      expect(codeOf(body)).toBe('ASSESSMENT_FLAGS_CONFLICT');
      expect(await rows(o)).toBe(0);
    });
  });

  // ───────────────────────────── AC5 · ไม่แน่ใจ ─────────────────────────────
  describe('AC5 · ไม่แน่ใจ', () => {
    it('PYG-563_10 Verify that every item accepts "unsure" (all 10 null is a complete assessment: score 0, unsure 10, flag on)', async () => {
      const o = await owner();
      const r = await submitOk(
        o,
        Object.fromEntries(CODES.map((c) => [c, null])),
      );
      expect(r).toMatchObject({
        adlTotalScore: 0,
        unsureCount: 10,
        hasUnsureFlag: true,
      });
      expect(r.answers.every((x) => x.value === null)).toBe(true);
    });

    it.each([
      [2, false],
      [3, true],
      [5, true],
    ])(
      'PYG-563_11 Verify that %i "unsure" answers set the unsure flag = %s',
      async (n, flag) => {
        const o = await owner();
        const a = { ...MAX };
        CODES.slice(0, n).forEach((c) => (a[c] = null));
        const r = await submitOk(o, a);
        expect([r.unsureCount, r.hasUnsureFlag]).toEqual([n, flag]);
        expect(r.flags).not.toContain('unsure');
      },
    );

    it('PYG-563_12 Verify that editing from 3 to 2 "unsure" answers removes the flag', async () => {
      const o = await owner();
      expect(
        (
          await submitOk(o, {
            ...MAX,
            feeding: null,
            grooming: null,
            transfers: null,
          })
        ).hasUnsureFlag,
      ).toBe(true);
      expect(
        (await submitOk(o, { ...MAX, feeding: null, grooming: null }))
          .hasUnsureFlag,
      ).toBe(false);
    });
  });

  // ───────────────────────────── AC6 · สมองเสื่อม ─────────────────────────────
  describe('AC6 · ความรุนแรงของสมองเสื่อม', () => {
    it.each([true, false])(
      'PYG-563_13 Verify that dementia with severity = %s is saved',
      async (severe) => {
        const o = await owner();
        const r = await submitOk(o, MAX, {
          flags: ['dementia'],
          noSpecialConditions: false,
          dementiaSevere: severe,
        });
        expect(r.dementiaSevere).toBe(severe);
      },
    );

    it('PYG-563_14 (D4) Verify that dementia without a severity returns ASSESSMENT_INCOMPLETE (dementiaSevere)', async () => {
      const o = await owner();
      const body = await submit(
        o.user,
        input(o, MAX, { flags: ['dementia'], noSpecialConditions: false }),
      );
      expect(codeOf(body)).toBe('ASSESSMENT_INCOMPLETE');
      expect(ext(body)).toMatchObject({ fields: ['dementiaSevere'] });
    });

    it.each([true, false])(
      'PYG-563_15 Verify that a severity (%s) without the dementia flag returns ASSESSMENT_FLAGS_CONFLICT',
      async (severe) => {
        const o = await owner();
        const body = await submit(
          o.user,
          input(o, MAX, {
            flags: ['oxygen'],
            noSpecialConditions: false,
            dementiaSevere: severe,
          }),
        );
        expect(codeOf(body)).toBe('ASSESSMENT_FLAGS_CONFLICT');
      },
    );

    it('PYG-563_16 Verify that removing the dementia flag clears the stored severity', async () => {
      const o = await owner();
      await submitOk(o, MAX, {
        flags: ['dementia'],
        noSpecialConditions: false,
        dementiaSevere: true,
      });
      const r = await submitOk(o, MAX, {
        flags: ['oxygen'],
        noSpecialConditions: false,
      });
      expect(r.dementiaSevere).toBeNull();
      const row = await h.prisma.careRecipientAssessment.findFirstOrThrow({
        where: { careRecipientId: o.recipientId },
      });
      expect(row.dementiaSevere).toBeNull();
    });
  });

  // ───────────────────────────── AC8 · แก้ไข ─────────────────────────────
  describe('AC8 · แก้ไขจากโปรไฟล์', () => {
    it('PYG-563_17 Verify that reading returns previous answers, editing updates score/flags/assessedAt, and there is still one row', async () => {
      const o = await owner();
      const first = await submitOk(o, MAX, {
        flags: ['diabetes'],
        noSpecialConditions: false,
      });
      const read = dataOf<Assessment>(
        await h.gql(o.user.token, READ, { id: o.recipientId }),
        'careRecipientAssessment',
      );
      expect(read).toEqual(first);
      expect(read.answers.map((x) => x.code)).toEqual(CODES);
      await new Promise((r) => setTimeout(r, 20));
      const second = await submitOk(o, ZERO, {
        flags: ['oxygen', 'fall_risk'],
        noSpecialConditions: false,
      });
      expect(second).toMatchObject({
        adlTotalScore: 0,
        flags: ['oxygen', 'fall_risk'],
      });
      expect(new Date(second.assessedAt).getTime()).toBeGreaterThan(
        new Date(first.assessedAt).getTime(),
      );
      expect(await rows(o)).toBe(1);
    });

    it('PYG-563_18 Verify that two rapid submissions do not create a duplicate row', async () => {
      const o = await owner();
      const results = await Promise.all([
        submit(o.user, input(o, MAX)),
        submit(o.user, input(o, ZERO)),
      ]);
      expect(results.filter((b) => !b.errors)).not.toHaveLength(0);
      expect(await rows(o)).toBe(1);
    });
  });

  // ───────────────────────────── AC9 · ด่านจอง ─────────────────────────────
  describe('AC9 · ไม่มีแบบประเมินจองไม่ได้', () => {
    it('PYG-563_19 Verify that booking (REST) for an elder without an assessment returns 422 ASSESSMENT_REQUIRED and creates nothing', async () => {
      const o = await owner();
      const before = await h.prisma.booking.count();
      const res = await book(o);
      expect(res.status).toBe(422);
      expect(restBody(res)).toMatchObject({ code: 'ASSESSMENT_REQUIRED' });
      expect(await h.prisma.booking.count()).toBe(before);
    });

    it('PYG-563_20 Verify that booking on behalf (GraphQL) for a member without an assessment returns ASSESSMENT_REQUIRED', async () => {
      const { groupId, owner: booker, members } = await h.seedGroup(1);
      const rec = await h.prisma.careRecipient.create({
        data: {
          patientId: members[0].id,
          name: members[0].accountName,
          is_self: true,
          familyGroupId: groupId,
        },
        select: { id: true },
      });
      const before = await h.prisma.booking.count();
      const body = await h.gql(
        booker.token,
        `mutation($i: CreateBookingOnBehalfInput!) { createBookingOnBehalf(input: $i) { id } }`,
        {
          i: {
            groupId,
            memberUserId: members[0].id,
            careRecipientId: rec.id,
            tasks: ['ดูแลทั่วไป'],
            serviceLocations: ['at_home'],
            serviceType: 'elderly_care',
            startTime: '13:00',
            endTime: '15:00',
            locationAddress: 'บ้านทดสอบ QA-611',
            bookingDate: futureDate(day++),
          },
        },
      );
      expect(codeOf(body)).toBe('ASSESSMENT_REQUIRED');
      expect(await h.prisma.booking.count()).toBe(before);
    });

    it('PYG-563_21 Verify that an elder with an assessment can book normally', async () => {
      const o = await owner();
      await submitOk(o, MAX);
      expect((await book(o)).status).toBe(201);
    });
  });

  // ───────────────────────────── AC10 · บัญชีเดิม ─────────────────────────────
  describe('AC10 · บัญชีเดิม (API)', () => {
    it('PYG-563_22 Verify that an existing profile shows hasAssessment=false, other APIs work, and after assessing it becomes true', async () => {
      const o = await owner();
      const list = async () =>
        (
          (await h.rest(o.user.token).get('/api/v1/patient/care-recipients'))
            .body as { id: string; hasAssessment: boolean }[]
        ).find((r) => r.id === o.recipientId);
      expect((await list())?.hasAssessment).toBe(false);
      // ใช้ส่วนอื่นได้โดยไม่ถูกบังคับประเมิน
      expect(
        (await h.gql(o.user.token, 'query { careActivities { id } }')).errors,
      ).toBeUndefined();
      expect((await book(o)).status).toBe(422);
      await submitOk(o, MAX);
      expect((await list())?.hasAssessment).toBe(true);
      expect((await book(o)).status).toBe(201);
    });

    it('PYG-563_23 Verify that group profiles expose hasAssessment (and nothing else from the assessment)', async () => {
      const { groupId, owner: o, members } = await h.seedGroup(1);
      const assessed = await h.seedAssessedRecipient(members[0]);
      await h.prisma.careRecipient.update({
        where: { id: assessed },
        data: { familyGroupId: groupId },
      });
      const body = await h.gql(
        o.token,
        `query($g: ID!) { groupCareRecipients(groupId: $g) { id hasAssessment } }`,
        { g: groupId },
      );
      expect(body.errors).toBeUndefined();
      const row = dataOf<{ id: string; hasAssessment: boolean }[]>(
        body,
        'groupCareRecipients',
      ).find((r) => r.id === assessed);
      expect(row?.hasAssessment).toBe(true);
    });
  });

  // ─────────────────────────── Edge cases ───────────────────────────
  describe('Edge cases', () => {
    it('PYG-563_24 (E1) Verify that abandoning half-way saves nothing and booking stays blocked (no draft in v1)', async () => {
      const o = await owner();
      const half = Object.fromEntries(
        CODES.slice(0, 5).map((c) => [c, MAX[c]]),
      );
      expect(codeOf(await submit(o.user, input(o, half)))).toBe(
        'ASSESSMENT_INCOMPLETE',
      );
      expect(await rows(o)).toBe(0);
      expect((await book(o)).status).toBe(422);
    });

    it('PYG-563_25 (E2) Verify that "no special conditions" with 3 "unsure" answers is saved and has the unsure flag', async () => {
      const o = await owner();
      const r = await submitOk(o, {
        ...MAX,
        stairs: null,
        bathing: null,
        grooming: null,
      });
      expect(r).toMatchObject({
        noSpecialConditions: true,
        flags: [],
        hasUnsureFlag: true,
        unsureCount: 3,
      });
    });

    it.each<
      [
        string,
        { code: string; value: number | null }[],
        Record<string, unknown>,
      ]
    >([
      [
        'a value outside the options (grooming = 2)',
        answersOf({ ...MAX, grooming: 2 }),
        { invalidAnswerCodes: ['grooming'] },
      ],
      [
        'an unknown item code',
        [
          ...answersOf(MAX).filter((x) => x.code !== 'feeding'),
          { code: 'eating', value: 2 },
        ],
        {},
      ],
      [
        'a duplicated item code',
        [...answersOf(MAX), { code: 'bathing', value: 0 }],
        {},
      ],
      [
        'an item code in the wrong case',
        [
          ...answersOf(MAX).filter((x) => x.code !== 'bladder'),
          { code: 'Bladder', value: 2 },
        ],
        {},
      ],
    ])(
      'PYG-563_26 (E7) Verify that %s returns ASSESSMENT_ANSWER_INVALID and leaves the existing result untouched',
      async (_l, answers, meta) => {
        const o = await owner();
        const before = await submitOk(o, MAX, {
          flags: ['diabetes'],
          noSpecialConditions: false,
        });
        const body = await submit(o.user, {
          ...input(o, MAX, { flags: ['oxygen'], noSpecialConditions: false }),
          answers,
        });
        expect(codeOf(body)).toBe('ASSESSMENT_ANSWER_INVALID');
        expect(ext(body)).toMatchObject(meta);
        const after = dataOf<Assessment>(
          await h.gql(o.user.token, READ, { id: o.recipientId }),
          'careRecipientAssessment',
        );
        expect(after).toEqual(before);
      },
    );

    it('PYG-563_27 (E9) Verify that with 2 elders only the assessed one can be booked', async () => {
      const o = await owner();
      await submitOk(o, MAX);
      const other = await h.prisma.careRecipient.create({
        data: {
          patientId: o.user.id,
          name: 'ผู้สูงอายุคนที่สอง',
          is_self: false,
        },
        select: { id: true },
      });
      expect((await book(o)).status).toBe(201);
      const res = await book({ ...o, recipientId: other.id });
      expect(res.status).toBe(422);
      expect(restBody(res)).toMatchObject({ code: 'ASSESSMENT_REQUIRED' });
    });

    it('PYG-563_28 (E10) Verify that a booking made before the feature (elder without assessment) can still be opened', async () => {
      const o = await owner();
      await submitOk(o, MAX);
      const res = await book(o);
      const id = (res.body as { id: string }).id;
      await h.prisma.careRecipientAssessment.deleteMany({
        where: { careRecipientId: o.recipientId },
      });
      const body = await h.gql(
        o.user.token,
        `query($id: ID!) { myBooking(id: $id) { id status } }`,
        { id },
      );
      expect(body.errors).toBeUndefined();
      expect(dataOf<{ id: string }>(body, 'myBooking').id).toBe(id);
    });

    it("PYG-563_29 Verify that relative A cannot read or save the assessment of relative B's elder (same error as a missing id)", async () => {
      const b = await owner();
      await submitOk(b, MAX, {
        flags: ['diabetes'],
        noSpecialConditions: false,
      });
      const a = await owner();
      const read = await h.gql(a.user.token, READ, { id: b.recipientId });
      expect(codeOf(read)).toBe('ASSESSMENT_ACCESS_DENIED');
      expect(JSON.stringify(read)).not.toMatch(/diabetes|adlTotalScore":\d/);
      const write = await submit(a.user, input(b, ZERO));
      expect(codeOf(write)).toBe('ASSESSMENT_ACCESS_DENIED');
      expect(
        (
          await h.prisma.careRecipientAssessment.findFirstOrThrow({
            where: { careRecipientId: b.recipientId },
          })
        ).adlTotalScore,
      ).toBe(20);
      const ghost = await h.gql(a.user.token, READ, {
        id: '00000000-0000-4000-8000-000000000000',
      });
      const notUuid = await h.gql(a.user.token, READ, { id: 'not-a-uuid' });
      for (const x of [ghost, notUuid]) {
        expect(codeOf(x)).toBe('ASSESSMENT_ACCESS_DENIED');
        expect(x.errors![0].message).toBe(read.errors![0].message);
      }
    });

    it('PYG-563_30 Verify that a caregiver role cannot read or save an elder assessment', async () => {
      const o = await owner();
      await submitOk(o, MAX);
      const cg = await h.seedCaregiver();
      expect(codeOf(await h.gql(cg.token, READ, { id: o.recipientId }))).toBe(
        'ASSESSMENT_ACCESS_DENIED',
      );
      expect(codeOf(await submit(cg, input(o, ZERO)))).toBe(
        'ASSESSMENT_ACCESS_DENIED',
      );
    });

    it('PYG-563_31 Verify that calls without login are refused', async () => {
      const o = await owner();
      expect(codeOf(await h.gql(null, READ, { id: o.recipientId }))).toBe(
        'UNAUTHENTICATED',
      );
      expect(codeOf(await submit(null, input(o, MAX)))).toBe('UNAUTHENTICATED');
    });

    it('PYG-563_32 Verify that assessment fields are not exposed on any other GraphQL type (public, list, profile, booking)', async () => {
      const body = await h.gql(
        null,
        `query { __schema { types { name fields { name } } } }`,
      );
      const types = (
        body.data as {
          __schema: {
            types: { name: string; fields: { name: string }[] | null }[];
          };
        }
      ).__schema.types;
      const leaking = types
        .filter(
          (t) =>
            t.name !== 'CareRecipientAssessment' && !t.name.startsWith('__'),
        )
        .flatMap((t) =>
          (t.fields ?? [])
            .filter((f) =>
              [
                'adlAnswers',
                'adlTotalScore',
                'unsureCount',
                'hasUnsureFlag',
                'dementiaSevere',
                'noSpecialConditions',
              ].includes(f.name),
            )
            .map((f) => `${t.name}.${f.name}`),
        );
      expect(leaking).toEqual([]);
    });

    // เคยเป็นบั๊ก PYG-666 (แก้ใน #156): contract PYG-607 §8 ต้องบอกรหัสข้อที่ผิด
    it.each<
      [
        string,
        { code: string; value: number | null }[],
        Record<string, unknown>,
      ]
    >([
      [
        'an unknown item code',
        [
          ...answersOf(MAX).filter((x) => x.code !== 'feeding'),
          { code: 'eating', value: 2 },
        ],
        { invalidAnswerCodes: ['eating'] },
      ],
      [
        'a duplicated item code',
        [...answersOf(MAX), { code: 'bathing', value: 0 }],
        { duplicateAnswerCodes: ['bathing'] },
      ],
      [
        'an item code in the wrong case',
        [
          ...answersOf(MAX).filter((x) => x.code !== 'bladder'),
          { code: 'Bladder', value: 2 },
        ],
        { invalidAnswerCodes: ['Bladder'] },
      ],
    ])(
      'PYG-563_33 (E7) Verify that %s names the offending code in the error metadata',
      async (_l, answers, meta) => {
        const o = await owner();
        const body = await submit(o.user, { ...input(o, MAX), answers });
        expect(codeOf(body)).toBe('ASSESSMENT_ANSWER_INVALID');
        expect(ext(body)).toMatchObject(meta);
      },
    );
  });
});
