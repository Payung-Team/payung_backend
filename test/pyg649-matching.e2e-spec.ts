/**
 * PYG-649 · QA ของ S18 (PYG-571) — กรองผู้ดูแลตาม 4 เงื่อนไข (ระดับ · ทักษะ · วิชาชีพ · หลักฐาน)
 *
 * ยิง GraphQL / REST เข้าแอปจริง (harness: test/support/qa-e2e.ts) ต่อ Postgres ทิ้งได้ใน Docker
 * TC_NO = PYG-571_NN · รายงานผล: docs/qa/pyg-649-matching-report.md
 *
 * - eligibleCaregivers คืนผู้ดูแล public ทุกคนที่ผ่าน → ตรวจ "มี/ไม่มี id ที่ seed ในเคสนั้น" ไม่ตรวจจำนวนรวม
 * - ระดับ booking สร้างจาก ADL จริง (20 → ต้น · 5 → กลาง · 4 → สูง ตามตารางของ PYG-640) ไม่เขียนระดับเอง
 *   ยกเว้น PYG-571_14 ที่ต้องการ "กายภาพบำบัดระดับต้น" ซึ่งสร้างผ่าน API ไม่ได้แล้ว (F03 = สูง มติ 9 ต.ค.)
 * - E8 (มติผู้ใช้): เทียบวันหมดอายุกับ "วันให้บริการ" — เที่ยงคืนต้นวัน booking_date เวลาไทย
 */
import {
  bootstrap,
  codeOf,
  describeDb,
  futureDate,
  GqlBody,
  Harness,
  seedProductionMasterData,
  UNLOCKED_SKILLS,
} from './support/qa-e2e';

type Res = { status: number; body: unknown };
type Reason = { reason: string; skillCode: string | null };
type ReportRow = {
  caregiver: { id: string };
  passed: boolean;
  checks: {
    level: boolean;
    skills: boolean;
    profession: boolean;
    evidence: boolean;
  };
  reasons: Reason[];
};
type Eligible = {
  caregivers: { id: string; careLevel: string | null; profession: string }[];
  emptyMessage: string | null;
  adminContact: { label: string; url: string } | null;
};
type Seeded = Awaited<ReturnType<Harness['seedCaregiver']>>;
type CgLevel = 'basic' | 'intermediate' | 'advanced';

const ELIGIBLE = `query($b: ID!) { eligibleCaregivers(bookingId: $b) {
  caregivers { id careLevel profession } emptyMessage adminContact { label url } } }`;
const REPORT = `query($b: ID!) { bookingMatchReport(bookingId: $b) {
  bookingId evaluatedAt evidenceReferenceDate persisted
  results { caregiver { id } passed checks { level skills profession evidence } reasons { reason skillCode } } } }`;

const dataOf = <T>(body: GqlBody, field: string): T =>
  (body.data as Record<string, unknown>)[field] as T;
const bookedId = (res: Res) => (res.body as { id: string }).id;
const restBody = (res: Res) => res.body as Record<string, unknown>;

const LOW = { stairs: 0, grooming: 0, toilet_use: 0, mobility: 0 };
const LOWER = { ...LOW, feeding: 0, dressing: 0, bowels: 0 };
/** ADL → ระดับ booking (ไม่มี Flag · ไม่มีกิจกรรม) */
const ADL_FOR = {
  BASIC: {},
  INTERMEDIATE: { ...LOWER, bladder: 1 },
  ADVANCED: { ...LOWER, bladder: 0 },
} as const;

const DAY = 86_400_000;
const inYears = (n: number) => new Date(Date.now() + n * 365 * DAY);
/** เที่ยงคืนต้นวันให้บริการ เวลาไทย = evidenceReferenceDate ของ S18 */
const serviceStart = (bookingDate: string) =>
  new Date(`${bookingDate}T00:00:00+07:00`);

describeDb('PYG-649 · S18 caregiver matching (PYG-571)', () => {
  let h: Harness;
  let admin: Awaited<ReturnType<Harness['seedAdmin']>>;
  let day = 25;

  beforeAll(async () => {
    delete process.env.MATCHING_ADMIN_CONTACT_URL;
    h = await bootstrap();
    await seedProductionMasterData();
    for (const serviceType of ['elderly_care', 'physiotherapy']) {
      await h.prisma.servicePriceCatalog.upsert({
        where: { serviceType },
        create: { serviceType, pricePerHour: 300 },
        update: { isActive: true },
      });
    }
    admin = await h.seedAdmin();
  }, 60_000);

  afterAll(async () => {
    delete process.env.MATCHING_ADMIN_CONTACT_URL;
    await h?.close();
  });

  async function elder(opts: Parameters<Harness['submitAssessment']>[2] = {}) {
    const patient = await h.seedUser('patient');
    const recipientId = await h.seedAssessedRecipient(patient, opts);
    return { patient, recipientId };
  }
  type Elder = Awaited<ReturnType<typeof elder>>;

  /** booking แบบ unmatched + วันให้บริการ */
  async function booking(e: Elder, extra: Record<string, unknown> = {}) {
    const bookingDate = futureDate(day++);
    const res = await h.rest(e.patient.token).post('/api/v1/bookings', {
      careRecipientId: e.recipientId,
      tasks: ['ดูแลทั่วไป'],
      serviceLocations: ['at_home'],
      serviceType: 'elderly_care',
      startTime: '09:00',
      endTime: '11:00',
      locationAddress: 'บ้านทดสอบ QA-649',
      bookingDate,
      ...extra,
    });
    expect(res.status).toBe(201);
    return { id: bookedId(res), bookingDate, body: restBody(res) };
  }

  const caregiver = (opts: Parameters<Harness['seedCaregiver']>[0] = {}) =>
    h.seedCaregiver(opts);
  const nurse = (
    level: CgLevel = 'advanced',
    license: { status: string; expiresAt: Date | null } | null = {
      status: 'approved',
      expiresAt: inYears(1),
    },
  ) =>
    caregiver({
      profession: 'nurse',
      careLevel: level,
      skills: [
        ...UNLOCKED_SKILLS,
        'injection',
        'tube_feeding',
        'suction',
        'tracheostomy_care',
        'abdominal_wound_care',
      ],
      license,
    });
  const physio = (
    level: CgLevel = 'advanced',
    license: { status: string; expiresAt: Date | null } | null = {
      status: 'approved',
      expiresAt: inYears(1),
    },
  ) =>
    caregiver({
      profession: 'physiotherapist',
      careLevel: level,
      skills: [...UNLOCKED_SKILLS, 'physiotherapy'],
      license,
    });

  async function eligibleIds(e: Elder, bookingId: string) {
    const body = await h.gql(e.patient.token, ELIGIBLE, { b: bookingId });
    expect(body.errors).toBeUndefined();
    return new Set(
      dataOf<Eligible>(body, 'eligibleCaregivers').caregivers.map((c) => c.id),
    );
  }

  async function reportFor(bookingId: string, cg: Seeded) {
    const body = await h.gql(admin.token, REPORT, { b: bookingId });
    expect(body.errors).toBeUndefined();
    return dataOf<{ results: ReportRow[] }>(
      body,
      'bookingMatchReport',
    ).results.find((r) => r.caregiver.id === cg.caregiverId);
  }

  /** ผล + เหตุผลของผู้ดูแลหนึ่งคน ทั้งฝั่งญาติ (มี/ไม่มีในรายชื่อ) และฝั่งแอดมิน (reasons) */
  async function verdict(e: Elder, bookingId: string, cg: Seeded) {
    const listed = (await eligibleIds(e, bookingId)).has(cg.caregiverId);
    const row = await reportFor(bookingId, cg);
    expect(row?.passed).toBe(listed);
    return {
      listed,
      reasons: (row?.reasons ?? []).map((r) => r.reason),
      raw: row,
    };
  }

  // ───────────────────────────── AC1 · ระดับ 9 คู่ ─────────────────────────────
  describe('AC1 · ระดับ booking × ระดับผู้ดูแล', () => {
    const PASS: Record<string, CgLevel[]> = {
      BASIC: ['basic', 'intermediate', 'advanced'],
      INTERMEDIATE: ['intermediate', 'advanced'],
      ADVANCED: ['advanced'],
    };
    it.each(['BASIC', 'INTERMEDIATE', 'ADVANCED'] as const)(
      'PYG-571_01 Verify that a %s booking lists only caregivers at that level or higher (3 pairs)',
      async (bookingLevel) => {
        const e = await elder({ adl: ADL_FOR[bookingLevel] });
        const b = await booking(e);
        expect(b.body.requiredLevel).toBe(bookingLevel);
        for (const level of ['basic', 'intermediate', 'advanced'] as const) {
          const cg = await caregiver({ careLevel: level });
          const v = await verdict(e, b.id, cg);
          expect([level, v.listed]).toEqual([
            level,
            PASS[bookingLevel].includes(level),
          ]);
          if (!v.listed) expect(v.reasons).toEqual(['LEVEL_TOO_LOW']);
        }
      },
    );

    it('PYG-571_02 Verify that a caregiver without a level is never listed (LEVEL_NOT_SET)', async () => {
      const e = await elder();
      const b = await booking(e);
      const cg = await caregiver({ careLevel: null });
      const v = await verdict(e, b.id, cg);
      expect(v.listed).toBe(false);
      expect(v.reasons).toEqual(['LEVEL_NOT_SET']);
    });
  });

  // ───────────────────────────── ADL ต่อเนื่องถึงรายชื่อ ─────────────────────────────
  describe('ค่าขอบ ADL ต่อเนื่องถึงรายชื่อ', () => {
    it.each([
      [12, { ...LOW }, 'BASIC', [true, true, true]],
      [11, { ...LOW, feeding: 1 }, 'INTERMEDIATE', [false, true, true]],
      [5, { ...LOWER, bladder: 1 }, 'INTERMEDIATE', [false, true, true]],
      [4, { ...LOWER, bladder: 0 }, 'ADVANCED', [false, false, true]],
    ] as const)(
      'PYG-571_03 Verify that ADL total %i → booking %s → caregivers basic/intermediate/advanced listed as expected',
      async (_t, adl, level, expected) => {
        const e = await elder({ adl });
        const b = await booking(e);
        expect(b.body.requiredLevel).toBe(level);
        const got: boolean[] = [];
        for (const l of ['basic', 'intermediate', 'advanced'] as const)
          got.push(
            (await verdict(e, b.id, await caregiver({ careLevel: l }))).listed,
          );
        expect(got).toEqual(expected);
      },
    );
  });

  // ───────────────────────────── AC2 · ทักษะ ─────────────────────────────
  describe('AC2 · ทักษะ', () => {
    it('PYG-571_04 Verify that exact skills, extra skills and missing one skill behave as expected (needs transfer_assist)', async () => {
      const e = await elder({ adl: { transfers: 1 } });
      const b = await booking(e);
      const needed = (
        b.body.requiredSkills as { skill: { code: string } }[]
      ).map((s) => s.skill.code);
      expect(needed).toContain('transfer_assist');
      const exact = await caregiver({ skills: needed });
      const extra = await caregiver({ skills: UNLOCKED_SKILLS });
      const missing = await caregiver({
        skills: UNLOCKED_SKILLS.filter((s) => s !== 'transfer_assist'),
      });
      expect((await verdict(e, b.id, exact)).listed).toBe(true);
      expect((await verdict(e, b.id, extra)).listed).toBe(true);
      const m = await verdict(e, b.id, missing);
      expect(m.listed).toBe(false);
      expect(m.raw?.reasons).toEqual([
        { reason: 'SKILL_MISSING', skillCode: 'transfer_assist' },
      ]);
    });

    it('PYG-571_05 Verify that an empty Required Skills list passes the skill condition', async () => {
      const e = await elder();
      const b = await booking(e);
      expect(b.body.requiredSkills).toEqual([]);
      const none = await caregiver({ skills: [] });
      expect((await verdict(e, b.id, none)).listed).toBe(true);
    });
  });

  // ───────────────────────────── AC3 · วิชาชีพ ─────────────────────────────
  describe('AC3 · ทักษะล็อกวิชาชีพ', () => {
    it('PYG-571_06 Verify that an injection booking lists the nurse and not the general caregiver or physiotherapist', async () => {
      const e = await elder({ flags: ['injection'] });
      const b = await booking(e);
      const n = await nurse();
      const g = await caregiver({ skills: [...UNLOCKED_SKILLS, 'injection'] });
      const p = await physio();
      expect((await verdict(e, b.id, n)).listed).toBe(true);
      expect((await verdict(e, b.id, g)).reasons).toContain(
        'PROFESSION_MISMATCH',
      );
      expect((await verdict(e, b.id, p)).reasons).toContain(
        'PROFESSION_MISMATCH',
      );
    });

    it('PYG-571_07 Verify that a physiotherapy booking lists the physiotherapist and not the nurse or general caregiver', async () => {
      const e = await elder();
      const b = await booking(e, { serviceType: 'physiotherapy' });
      const p = await physio();
      const n = await nurse();
      const g = await caregiver({
        skills: [...UNLOCKED_SKILLS, 'physiotherapy'],
      });
      expect((await verdict(e, b.id, p)).listed).toBe(true);
      expect((await verdict(e, b.id, n)).reasons).toContain(
        'PROFESSION_MISMATCH',
      );
      expect((await verdict(e, b.id, g)).reasons).toContain(
        'PROFESSION_MISMATCH',
      );
    });

    it('PYG-571_08 Verify that injection + physiotherapy cannot be met by either profession alone', async () => {
      const e = await elder({ flags: ['injection'] });
      const b = await booking(e, { serviceType: 'physiotherapy' });
      const n = await nurse();
      const p = await physio();
      const vn = await verdict(e, b.id, n);
      const vp = await verdict(e, b.id, p);
      expect(vn.listed || vp.listed).toBe(false);
      expect(vn.raw?.reasons).toEqual(
        expect.arrayContaining([
          { reason: 'PROFESSION_MISMATCH', skillCode: 'physiotherapy' },
        ]),
      );
      expect(vp.raw?.reasons).toEqual(
        expect.arrayContaining([
          { reason: 'PROFESSION_MISMATCH', skillCode: 'injection' },
        ]),
      );
    });

    it('PYG-571_09 Verify that a nurse with a level below the booking is not listed (LEVEL_TOO_LOW)', async () => {
      const e = await elder({ flags: ['injection'] });
      const b = await booking(e);
      expect(b.body.requiredLevel).toBe('ADVANCED');
      const v = await verdict(e, b.id, await nurse('intermediate'));
      expect(v.listed).toBe(false);
      expect(v.reasons).toEqual(['LEVEL_TOO_LOW']);
    });

    it('PYG-571_10 Verify that the 4 nurse-locked skills (tube feeding, tracheostomy, suction, abdominal wound) list a nurse but not a general caregiver', async () => {
      const e = await elder();
      const b = await booking(e, {
        activityIds: await Promise.all(
          ['C04', 'E05', 'E04', 'E07'].map(
            async (code) =>
              (
                await h.prisma.careActivity.findFirstOrThrow({
                  where: { code },
                })
              ).id,
          ),
        ),
      });
      const needed = (b.body.requiredSkills as { skill: { code: string } }[])
        .map((s) => s.skill.code)
        .sort();
      expect(needed).toEqual([
        'abdominal_wound_care',
        'suction',
        'tracheostomy_care',
        'tube_feeding',
      ]);
      expect((await verdict(e, b.id, await nurse())).listed).toBe(true);
      const g = await verdict(
        e,
        b.id,
        await caregiver({ skills: [...UNLOCKED_SKILLS, ...needed] }),
      );
      expect(g.listed).toBe(false);
      expect(
        g.raw?.reasons
          .filter((r) => r.reason === 'PROFESSION_MISMATCH')
          .map((r) => r.skillCode)
          .sort(),
      ).toEqual(needed);
    });
  });

  // ───────────────────────────── AC4 · หลักฐาน ─────────────────────────────
  describe('AC4 · หลักฐาน (ใบประกอบฯ) — injection/พยาบาล และ physiotherapy/นักกายภาพฯ', () => {
    const cases: [
      string,
      (date: string) => { status: string; expiresAt: Date | null } | null,
      string | null,
    ][] = [
      [
        'approved, valid',
        () => ({ status: 'approved', expiresAt: inYears(1) }),
        null,
      ],
      [
        'pending',
        () => ({ status: 'pending', expiresAt: inYears(1) }),
        'EVIDENCE_NOT_APPROVED',
      ],
      [
        'rejected',
        () => ({ status: 'rejected', expiresAt: inYears(1) }),
        'EVIDENCE_NOT_APPROVED',
      ],
      ['no document', () => null, 'EVIDENCE_NOT_APPROVED'],
      [
        'approved, expired yesterday',
        () => ({ status: 'approved', expiresAt: new Date(Date.now() - DAY) }),
        'EVIDENCE_EXPIRED',
      ],
      // E8 (มติผู้ใช้): เทียบวันให้บริการ — หมดอายุ "สิ้นวันก่อนวันบริการ" ไม่ผ่าน · "สิ้นวันบริการ" ผ่าน
      [
        'approved, still valid today but expires the day before service',
        (d) => ({
          status: 'approved',
          expiresAt: new Date(serviceStart(d).getTime() - 1),
        }),
        'EVIDENCE_EXPIRED',
      ],
      [
        'approved, expires at the end of the service day',
        (d) => ({
          status: 'approved',
          expiresAt: new Date(serviceStart(d).getTime() + DAY - 1),
        }),
        null,
      ],
    ];

    it.each(cases)(
      'PYG-571_11 Verify the injection/nurse result when the license is %s',
      async (_label, license, reason) => {
        const e = await elder({ flags: ['injection'] });
        const b = await booking(e);
        const v = await verdict(
          e,
          b.id,
          await nurse('advanced', license(b.bookingDate)),
        );
        expect(v.listed).toBe(reason === null);
        if (reason) expect(v.reasons).toEqual([reason]);
      },
    );

    it.each(cases)(
      'PYG-571_12 Verify the physiotherapy/physiotherapist result when the license is %s',
      async (_label, license, reason) => {
        const e = await elder();
        const b = await booking(e, { serviceType: 'physiotherapy' });
        const v = await verdict(
          e,
          b.id,
          await physio('advanced', license(b.bookingDate)),
        );
        expect(v.listed).toBe(reason === null);
        if (reason) expect(v.reasons).toEqual([reason]);
      },
    );

    it('PYG-571_13 Verify that an unlocked-skill booking does not require a license', async () => {
      const e = await elder({ adl: { transfers: 1 } });
      const b = await booking(e);
      expect(
        (await verdict(e, b.id, await caregiver({ license: null }))).listed,
      ).toBe(true);
    });
  });

  // ───────────────────────────── AC5 ─────────────────────────────
  describe('AC5 · กายภาพบำบัดระดับต้น', () => {
    it('PYG-571_14 Verify that a BASIC physiotherapy booking lists a basic physiotherapist and not an advanced nurse (level forced to BASIC — see header)', async () => {
      const e = await elder();
      const b = await booking(e, { serviceType: 'physiotherapy' });
      await h.prisma.booking.update({
        where: { id: b.id },
        data: { requiredLevel: 'basic' },
      });
      expect((await verdict(e, b.id, await physio('basic'))).listed).toBe(true);
      const n = await verdict(e, b.id, await nurse('advanced'));
      expect(n.listed).toBe(false);
      expect(n.reasons).toContain('PROFESSION_MISMATCH');
    });
  });

  // ───────────────────────────── AC6 · เหตุผลของแอดมิน ─────────────────────────────
  describe('AC6 · รายงานเหตุผลของแอดมิน', () => {
    it('PYG-571_15 Verify that the admin report lists every failed condition in order with the right skill codes', async () => {
      const e = await elder({ flags: ['injection'] });
      const b = await booking(e, { serviceType: 'physiotherapy' });
      const g = await caregiver({ careLevel: 'basic', skills: [] });
      const row = await reportFor(b.id, g);
      expect(row?.passed).toBe(false);
      expect(row?.checks).toEqual({
        level: false,
        skills: false,
        profession: false,
        evidence: false,
      });
      expect(row?.reasons).toEqual([
        { reason: 'LEVEL_TOO_LOW', skillCode: null },
        { reason: 'SKILL_MISSING', skillCode: 'injection' },
        { reason: 'SKILL_MISSING', skillCode: 'physiotherapy' },
        { reason: 'PROFESSION_MISMATCH', skillCode: 'injection' },
        { reason: 'PROFESSION_MISMATCH', skillCode: 'physiotherapy' },
        { reason: 'EVIDENCE_NOT_APPROVED', skillCode: 'injection' },
        { reason: 'EVIDENCE_NOT_APPROVED', skillCode: 'physiotherapy' },
      ]);
    });

    it('PYG-571_16 Verify that a caregiver failing 2 conditions (low level + wrong profession) has exactly those 2 reasons', async () => {
      const e = await elder();
      const b = await booking(e, { serviceType: 'physiotherapy' });
      const n = await nurse('basic', {
        status: 'approved',
        expiresAt: inYears(1),
      });
      await h.prisma.caregiver.update({
        where: { id: n.caregiverId },
        data: { skills: [...UNLOCKED_SKILLS, 'physiotherapy'] },
      });
      const v = await verdict(e, b.id, n);
      expect(
        v.reasons.filter((r) =>
          ['LEVEL_TOO_LOW', 'PROFESSION_MISMATCH'].includes(r),
        ),
      ).toEqual(['LEVEL_TOO_LOW', 'PROFESSION_MISMATCH']);
    });

    it('PYG-571_17 Verify that the report is a live result (persisted=false) with the service-day reference date', async () => {
      const e = await elder();
      const b = await booking(e);
      const body = await h.gql(admin.token, REPORT, { b: b.id });
      const r = dataOf<{ persisted: boolean; evidenceReferenceDate: string }>(
        body,
        'bookingMatchReport',
      );
      expect(r.persisted).toBe(false);
      expect(new Date(r.evidenceReferenceDate).toISOString()).toBe(
        serviceStart(b.bookingDate).toISOString(),
      );
    });
  });

  // ───────────────────────────── AC7 · ไม่มีใครผ่าน ─────────────────────────────
  describe('AC7 · ไม่มีผู้ดูแลที่ผ่าน', () => {
    it('PYG-571_18 Verify that with no eligible caregiver the elder gets an empty list, a message and the admin contact', async () => {
      const e = await elder({ flags: ['injection'] });
      const b = await booking(e, { serviceType: 'physiotherapy' }); // ไม่มีวิชาชีพเดียวที่ผ่านได้
      const body = await h.gql(e.patient.token, ELIGIBLE, { b: b.id });
      const r = dataOf<Eligible>(body, 'eligibleCaregivers');
      expect(r.caregivers).toEqual([]);
      expect(r.emptyMessage).toBe(
        'ยังไม่มีผู้ดูแลที่ตรงตามความต้องการ กรุณาติดต่อทีมงาน Payung',
      );
      expect(r.adminContact).toBeNull(); // ยังไม่ตั้ง MATCHING_ADMIN_CONTACT_URL
      process.env.MATCHING_ADMIN_CONTACT_URL =
        'https://line.me/R/ti/p/@qa-test-only';
      try {
        const withUrl = dataOf<Eligible>(
          await h.gql(e.patient.token, ELIGIBLE, { b: b.id }),
          'eligibleCaregivers',
        );
        expect(withUrl.adminContact).toMatchObject({
          url: 'https://line.me/R/ti/p/@qa-test-only',
        });
        expect(withUrl.adminContact?.label).toEqual(expect.any(String));
      } finally {
        delete process.env.MATCHING_ADMIN_CONTACT_URL;
      }
    });
  });

  // ─────────────────────────── Edge cases ───────────────────────────
  describe('Edge cases', () => {
    it('PYG-571_19 (E2) Verify that a booking without a calculated level or skills is not matchable and lists nobody', async () => {
      const e = await elder();
      const b = await booking(e);
      await h.prisma
        .$executeRaw`UPDATE bookings SET required_level = NULL, level_calculated_at = NULL, required_skills = NULL WHERE id = ${b.id}::uuid`;
      const body = await h.gql(e.patient.token, ELIGIBLE, { b: b.id });
      expect(codeOf(body)).toBe('BOOKING_NOT_MATCHABLE');
      expect(body.data).toBeNull();
    });

    it('PYG-571_20 (E9) Verify that selecting a caregiver whose license became invalid after listing is refused', async () => {
      const e = await elder({ flags: ['injection'] });
      const b = await booking(e);
      const n = await nurse();
      expect((await eligibleIds(e, b.id)).has(n.caregiverId)).toBe(true);
      await h.prisma.kycDocument.updateMany({
        where: { caregiverId: n.caregiverId },
        data: { reviewStatus: 'rejected' },
      });
      const sel = await h.selectCaregiver(e.patient, b.id, n.caregiverId);
      expect(codeOf(sel)).toBe('CAREGIVER_NOT_ELIGIBLE');
      expect(JSON.stringify(sel)).not.toContain('EVIDENCE');
      const row = await h.prisma.booking.findUniqueOrThrow({
        where: { id: b.id },
      });
      expect([row.caregiverId, row.status]).toEqual([null, 'unmatched']);
    });

    it('PYG-571_21 (E10) Verify that a caregiver with a pending profession change is filtered by the approved profession', async () => {
      const e = await elder({ flags: ['injection'] });
      const b = await booking(e);
      // ผู้ดูแลทั่วไปยื่นขอเป็นพยาบาลพร้อมใบที่ "อนุมัติแล้ว" — แต่คำขอยังรอ → ยังเป็นผู้ดูแลทั่วไป
      const g = await caregiver({
        skills: [...UNLOCKED_SKILLS, 'injection'],
        license: { status: 'approved', expiresAt: inYears(1) },
      });
      const doc = await h.prisma.kycDocument.findFirstOrThrow({
        where: { caregiverId: g.caregiverId },
      });
      await h.prisma.caregiver_edit_logs.create({
        data: {
          caregiver_id: g.caregiverId,
          edited_by: g.id,
          action: 'profession_change_request',
          field_changes: [
            {
              field: 'profession',
              oldValue: 'general_caregiver',
              newValue: 'nurse',
              licenseDocumentId: doc.id,
            },
          ],
        },
      });
      const v = await verdict(e, b.id, g);
      expect(v.listed).toBe(false);
      expect(v.reasons).toEqual(
        expect.arrayContaining([
          'PROFESSION_MISMATCH',
          'EVIDENCE_NOT_APPROVED',
        ]),
      );
    });

    it.each([
      ['not searchable', { searchable: false }],
      ['KYC not verified', { kycStatus: 'pending' }],
    ])(
      'PYG-571_22 (E12) Verify that a caregiver who is %s is not listed nor in the admin report even if all 4 conditions pass',
      async (_l, opts) => {
        const e = await elder();
        const b = await booking(e);
        const cg = await caregiver(opts);
        expect((await eligibleIds(e, b.id)).has(cg.caregiverId)).toBe(false);
        expect(await reportFor(b.id, cg)).toBeUndefined();
      },
    );

    it('PYG-571_23 Verify that editing the assessment before confirmation changes the list', async () => {
      const e = await elder();
      const b = await booking(e);
      const basic = await caregiver({ careLevel: 'basic' });
      expect((await eligibleIds(e, b.id)).has(basic.caregiverId)).toBe(true);
      await h.submitAssessment(e.patient, e.recipientId, {
        adl: ADL_FOR.ADVANCED,
      });
      expect((await eligibleIds(e, b.id)).has(basic.caregiverId)).toBe(false);
    });

    it("PYG-571_24 Verify that an elder cannot list caregivers for someone else's booking", async () => {
      const e = await elder();
      const b = await booking(e);
      const other = await h.seedUser('other');
      const body = await h.gql(other.token, ELIGIBLE, { b: b.id });
      expect(body.errors).toBeDefined();
      expect(body.data).toBeNull();
    });

    it('PYG-571_25 Verify that elders and caregivers cannot call the admin report', async () => {
      const e = await elder();
      const b = await booking(e);
      const cg = await caregiver();
      for (const token of [e.patient.token, cg.token])
        expect(codeOf(await h.gql(token, REPORT, { b: b.id }))).toBe(
          'FORBIDDEN',
        );
      expect(codeOf(await h.gql(null, REPORT, { b: b.id }))).toBe(
        'UNAUTHENTICATED',
      );
    });

    it('PYG-571_26 Verify that the elder response has no rejected caregivers, reasons or counts (raw response + schema)', async () => {
      const e = await elder({ flags: ['injection'] });
      const b = await booking(e);
      const g = await caregiver();
      const raw = JSON.stringify(
        await h.gql(e.patient.token, ELIGIBLE, { b: b.id }),
      );
      expect(raw).not.toContain(g.caregiverId);
      expect(raw).not.toMatch(
        /PROFESSION_MISMATCH|SKILL_MISSING|LEVEL_TOO_LOW|EVIDENCE_|reasons|excluded|filtered/i,
      );
      const t = await h.gql(
        e.patient.token,
        `query { __type(name: "EligibleCaregivers") { fields { name } } }`,
      );
      const fields = (
        t.data as { __type: { fields: { name: string }[] } }
      ).__type.fields
        .map((f) => f.name)
        .sort();
      expect(fields).toEqual(['adminContact', 'caregivers', 'emptyMessage']);
    });

    it('PYG-571_27 Verify that selecting an ineligible caregiver directly by id is refused and the booking is unchanged', async () => {
      const e = await elder({ flags: ['injection'] });
      const b = await booking(e);
      const g = await caregiver();
      const sel = await h.selectCaregiver(e.patient, b.id, g.caregiverId);
      expect(codeOf(sel)).toBe('CAREGIVER_NOT_ELIGIBLE');
      const row = await h.prisma.booking.findUniqueOrThrow({
        where: { id: b.id },
      });
      expect([row.caregiverId, row.status]).toEqual([null, 'unmatched']);
      // ผู้ที่ผ่านเลือกได้ → pending
      const n = await nurse();
      const ok = await h.selectCaregiver(e.patient, b.id, n.caregiverId);
      expect(
        dataOf<{ status: string }>(ok, 'selectBookingCaregiver').status,
      ).toBe('pending');
    });

    it('PYG-571_28 Verify that creating a booking with an ineligible caregiver id is refused (422) and nothing is created', async () => {
      const e = await elder({ flags: ['injection'] });
      const g = await caregiver();
      const before = await h.prisma.booking.count();
      const res = await h.rest(e.patient.token).post('/api/v1/bookings', {
        caregiverId: g.caregiverId,
        careRecipientId: e.recipientId,
        tasks: ['ดูแลทั่วไป'],
        serviceLocations: ['at_home'],
        serviceType: 'elderly_care',
        startTime: '09:00',
        endTime: '11:00',
        locationAddress: 'บ้านทดสอบ QA-649',
        bookingDate: futureDate(day++),
      });
      expect(res.status).toBe(422);
      expect(restBody(res)).toMatchObject({ code: 'CAREGIVER_NOT_ELIGIBLE' });
      expect(await h.prisma.booking.count()).toBe(before);
    });

    it('PYG-571_29 Verify that only the booking owner can select a caregiver', async () => {
      const e = await elder();
      const b = await booking(e);
      const cg = await caregiver();
      const other = await h.seedUser('other');
      const sel = await h.selectCaregiver(other, b.id, cg.caregiverId);
      expect(sel.errors).toBeDefined();
      expect(
        (await h.prisma.booking.findUniqueOrThrow({ where: { id: b.id } }))
          .caregiverId,
      ).toBeNull();
    });
  });
});
