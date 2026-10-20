/**
 * PYG-640 · QA ของ S16 (PYG-569) — ระดับ booking จาก 3 เกณฑ์ (ADL · Flags · บริการ)
 *
 * ยิง REST/GraphQL เข้าแอปจริง (harness: test/support/qa-e2e.ts) ต่อ Postgres ทิ้งได้ใน Docker
 * TC_NO = PYG-569_NN · รายงานผล: docs/qa/pyg-640-booking-level-report.md
 *
 * ต้นทางของ expected (การ์ดห้ามใช้ตารางกติกาใน DB):
 *   - ADL 0/4/5/11/12/20 → ระดับ: ตารางค่าขอบในการ์ด
 *   - สมองเสื่อมรุนแรง → สูง: AC3 ของการ์ด
 *   - ระดับบริการ: care_level ของกิจกรรมตาม T-01 + PYG-651 (test/support/t01-catalog.ts) — S16 ใช้ค่านี้เมื่อไม่มี override
 *   - กายภาพบำบัด F03 → สูง: **มติ Sammy 9 ต.ค.** (contract PYG-637 §1) ซึ่งแทนแถว "กายภาพบำบัดไม่ดันระดับ" ในการ์ด
 *   - ระดับของ Flag อื่น: infographic ยังไม่มี → เคสที่ต้องใช้ระบุ "(seed)" ในชื่อ = ตรวจกลไก max ไม่รับรองระดับของ Flag
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
import { expectedCatalog, LEVEL_API } from './support/t01-catalog';

type Level = 'BASIC' | 'INTERMEDIATE' | 'ADVANCED';
type Breakdown = {
  adl: Level;
  flags: Level | null;
  services: Level | null;
  calculatedAt: string;
};
type LevelView = {
  requiredLevel: Level | null;
  levelBreakdown: Breakdown | null;
};
type Res = { status: number; body: unknown };

const LEVEL =
  'requiredLevel levelBreakdown { adl flags services calculatedAt }';
const MY_BOOKING = `query($id: ID!) { myBooking(id: $id) { id ${LEVEL} } }`;
const CG_BOOKING = `query($id: ID!) { caregiverBooking(id: $id) { id ${LEVEL} } }`;
const ACCEPT = `mutation($id: ID!) { acceptBooking(bookingId: $id) { id } }`;
const CONFIRM = `mutation($id: ID!) { confirmBooking(bookingId: $id) { id status ${LEVEL} } }`;

const dataOf = <T>(body: GqlBody, field: string): T =>
  (body.data as Record<string, unknown>)[field] as T;
const bookedId = (res: Res) => (res.body as { id: string }).id;
const restBody = (res: Res) => res.body as Record<string, unknown>;

/** คะแนน ADL (เต็ม 20) — ลดจากข้อเดียวกันทุกชุด */
const LOW = { stairs: 0, grooming: 0, toilet_use: 0, mobility: 0 }; // 12
const LOWER = { ...LOW, feeding: 0, dressing: 0, bowels: 0 }; // 6
const ADL: Record<number, Partial<Record<string, number>>> = {
  20: {},
  12: LOW,
  11: { ...LOW, feeding: 1 },
  5: { ...LOWER, bladder: 1 },
  4: { ...LOWER, bladder: 0 },
};

describeDb('PYG-640 · S16 booking level (PYG-569)', () => {
  let h: Harness;
  let day = 15;
  /** ระดับบริการของกิจกรรมตาม T-01 + PYG-651 (ไม่อ่านจาก DB) */
  const t01Level = (code: string) =>
    LEVEL_API[expectedCatalog().find((r) => r.code === code)!.level] as Level;

  beforeAll(async () => {
    h = await bootstrap();
    await seedProductionMasterData();
    for (const serviceType of ['elderly_care', 'physiotherapy']) {
      await h.prisma.servicePriceCatalog.upsert({
        where: { serviceType },
        create: { serviceType, pricePerHour: 300 },
        update: { isActive: true },
      });
    }
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  async function elder(opts: Parameters<Harness['submitAssessment']>[2] = {}) {
    const patient = await h.seedUser('patient');
    const recipientId = await h.seedAssessedRecipient(patient, opts);
    const total = (
      await h.prisma.careRecipientAssessment.findFirstOrThrow({
        where: { careRecipientId: recipientId },
      })
    ).adlTotalScore;
    return { patient, recipientId, total };
  }
  type Elder = Awaited<ReturnType<typeof elder>>;

  const activityId = async (code: string) =>
    (await h.prisma.careActivity.findFirstOrThrow({ where: { code } })).id;

  async function book(e: Elder, extra: Record<string, unknown> = {}) {
    const res = await h.rest(e.patient.token).post('/api/v1/bookings', {
      careRecipientId: e.recipientId,
      tasks: ['ดูแลทั่วไป'],
      serviceLocations: ['at_home'],
      serviceType: 'elderly_care',
      startTime: '09:00',
      endTime: '11:00',
      locationAddress: 'บ้านทดสอบ QA-640',
      bookingDate: futureDate(day++),
      ...extra,
    });
    return res;
  }

  async function bookOk(e: Elder, extra: Record<string, unknown> = {}) {
    const res = await book(e, extra);
    expect(res.status).toBe(201);
    return { id: bookedId(res), rest: restBody(res) as unknown as LevelView };
  }

  async function levelOf(e: Elder, id: string) {
    const body = await h.gql(e.patient.token, MY_BOOKING, { id });
    expect(body.errors).toBeUndefined();
    return dataOf<LevelView>(body, 'myBooking');
  }

  const services = async (...codes: string[]) => ({
    activityIds: await Promise.all(codes.map(activityId)),
  });

  // ───────────────────────────── AC1 · ADL ─────────────────────────────
  describe('AC1 · ค่าขอบ ADL (ไม่มี Flag · บริการไม่ดันระดับ)', () => {
    it.each([
      [0, 'ADVANCED'],
      [4, 'ADVANCED'],
      [5, 'INTERMEDIATE'],
      [11, 'INTERMEDIATE'],
      [12, 'BASIC'],
      [20, 'BASIC'],
    ] as const)(
      'PYG-569_01 Verify that ADL total %i gives ADL level %s and booking level %s',
      async (total, level) => {
        const e = await elder(
          total === 0 ? { score: 'zero' } : { adl: ADL[total] },
        );
        expect(e.total).toBe(total);
        const { rest } = await bookOk(e);
        expect(rest.requiredLevel).toBe(level);
        expect(rest.levelBreakdown).toMatchObject({
          adl: level,
          flags: null,
          services: null,
        });
      },
    );
  });

  // ───────────────────────────── AC2 · Flags ─────────────────────────────
  describe('AC2 · Flags', () => {
    it('PYG-569_02 Verify that one flag gives its own level (severe dementia → ADVANCED)', async () => {
      const { rest } = await bookOk(
        await elder({ flags: ['dementia'], dementiaSevere: true }),
      );
      expect(rest.levelBreakdown?.flags).toBe('ADVANCED');
      expect(rest.requiredLevel).toBe('ADVANCED');
    });

    it('PYG-569_03 Verify that several flags with different levels give the highest one (seed: diabetes + injection)', async () => {
      const { rest } = await bookOk(
        await elder({ flags: ['diabetes', 'injection'] }),
      );
      expect(rest.levelBreakdown?.flags).toBe('ADVANCED');
    });

    it('PYG-569_04 Verify that with no flag the flag criterion has no effect (null)', async () => {
      const { rest } = await bookOk(await elder());
      expect(rest.levelBreakdown?.flags).toBeNull();
      expect(rest.requiredLevel).toBe('BASIC');
    });
  });

  // ───────────────────────────── AC3 · สมองเสื่อม ─────────────────────────────
  describe('AC3 · สมองเสื่อม', () => {
    it('PYG-569_05 Verify that dementia marked severe gives ADVANCED from flags', async () => {
      const { rest } = await bookOk(
        await elder({ flags: ['dementia'], dementiaSevere: true }),
      );
      expect(rest.levelBreakdown?.flags).toBe('ADVANCED');
    });

    it('PYG-569_06 Verify that dementia not marked severe uses the general dementia rule (seed: INTERMEDIATE) and not the severe one', async () => {
      const { rest } = await bookOk(
        await elder({ flags: ['dementia'], dementiaSevere: false }),
      );
      expect(rest.levelBreakdown?.flags).toBe('INTERMEDIATE');
    });
  });

  // ───────────────────────────── AC4 · บริการ ─────────────────────────────
  describe('AC4 · บริการ (ระดับตาม T-01 · F03 ตามมติ 9 ต.ค.)', () => {
    it.each(['A04', 'A01', 'E04'])(
      'PYG-569_07 Verify that service %s gives its T-01 level',
      async (code) => {
        const { rest } = await bookOk(await elder(), await services(code));
        expect(rest.levelBreakdown?.services).toBe(t01Level(code));
        expect(rest.requiredLevel).toBe(t01Level(code)); // ADL เต็ม (BASIC) → ระดับสุดท้ายมาจากบริการ
      },
    );

    it('PYG-569_08 Verify that physiotherapy only gives ADVANCED from services (decision 9 Oct; card said "no effect")', async () => {
      const viaType = await bookOk(await elder(), {
        serviceType: 'physiotherapy',
      });
      expect(viaType.rest.levelBreakdown?.services).toBe('ADVANCED');
      const viaActivity = await bookOk(await elder(), await services('F03'));
      expect(viaActivity.rest.levelBreakdown?.services).toBe('ADVANCED');
    });

    it('PYG-569_09 Verify that physiotherapy plus another service gives the highest of the two (F03 ADVANCED + A01)', async () => {
      const { rest } = await bookOk(
        await elder(),
        await services('F03', 'A01'),
      );
      expect(rest.levelBreakdown?.services).toBe('ADVANCED');
    });

    it('PYG-569_10 Verify that a plain service type without activities has no service effect', async () => {
      const { rest } = await bookOk(await elder());
      expect(rest.levelBreakdown?.services).toBeNull();
    });
  });

  // ───────────────────────────── AC5 · รวม 3 เกณฑ์ ─────────────────────────────
  describe('AC5 · ระดับสุดท้าย = สูงสุดของ 3 เกณฑ์', () => {
    type Row = [
      string,
      number,
      Parameters<Harness['submitAssessment']>[2],
      string[],
      { serviceType?: string },
      Level,
    ];
    it.each<Row>([
      [
        'ADL 12 + physio only (card: BASIC → decision 9 Oct: ADVANCED)',
        12,
        {},
        [],
        { serviceType: 'physiotherapy' },
        'ADVANCED',
      ],
      [
        'ADL 5 + physio only (card: INTERMEDIATE → decision 9 Oct: ADVANCED)',
        5,
        {},
        [],
        { serviceType: 'physiotherapy' },
        'ADVANCED',
      ],
      [
        'ADL 4 + physio only',
        4,
        {},
        [],
        { serviceType: 'physiotherapy' },
        'ADVANCED',
      ],
      [
        'ADL 20 + severe dementia + basic service (A04)',
        20,
        { flags: ['dementia'], dementiaSevere: true },
        ['A04'],
        {},
        'ADVANCED',
      ],
      [
        'ADL 20 + intermediate flag (seed: diabetes) + basic service',
        20,
        { flags: ['diabetes'] },
        ['A04'],
        {},
        'INTERMEDIATE',
      ],
      ['ADL 12 + advanced service (E04)', 12, {}, ['E04'], {}, 'ADVANCED'],
      [
        'ADL 12 + physio + intermediate service (A01) (card: INTERMEDIATE → decision 9 Oct: ADVANCED)',
        12,
        {},
        ['F03', 'A01'],
        {},
        'ADVANCED',
      ],
      [
        'ADL 4 + intermediate flag (seed) + basic service',
        4,
        { flags: ['diabetes'] },
        ['A04'],
        {},
        'ADVANCED',
      ],
      [
        'ADL 5 + intermediate + advanced flags (seed) + basic service',
        5,
        { flags: ['diabetes', 'injection'] },
        ['A04'],
        {},
        'ADVANCED',
      ],
      [
        'ADL 11 + basic service, no flag (ADL wins, others do not lower)',
        11,
        {},
        ['A04'],
        {},
        'INTERMEDIATE',
      ],
    ])(
      'PYG-569_11 Verify that %s gives the highest level',
      async (_label, total, opts, codes, extra, expected) => {
        const e = await elder({ ...opts, adl: ADL[total] });
        expect(e.total).toBe(total);
        const { rest } = await bookOk(e, {
          ...(codes.length ? await services(...codes) : {}),
          ...extra,
        });
        expect(rest.requiredLevel).toBe(expected);
        const b = rest.levelBreakdown!;
        const rank = { BASIC: 1, INTERMEDIATE: 2, ADVANCED: 3 } as const;
        const max = [b.adl, b.flags, b.services]
          .filter((x): x is Level => !!x)
          .sort((x, y) => rank[y] - rank[x])[0];
        expect(rest.requiredLevel).toBe(max);
      },
    );
  });

  // ───────────────────────────── AC6 · DB = API ─────────────────────────────
  describe('AC6 · ฐานข้อมูลตรงกับ API', () => {
    it('PYG-569_12 Verify that the stored final and per-criterion levels match REST and GraphQL', async () => {
      const e = await elder({
        adl: ADL[5],
        flags: ['dementia'],
        dementiaSevere: true,
      });
      const { id, rest } = await bookOk(e, await services('A01'));
      const row = await h.prisma.booking.findUniqueOrThrow({ where: { id } });
      const gql = await levelOf(e, id);
      expect(gql).toMatchObject({
        requiredLevel: rest.requiredLevel,
        levelBreakdown: rest.levelBreakdown,
      });
      expect({
        requiredLevel: row.requiredLevel,
        adl: row.levelFromAdl,
        flags: row.levelFromFlags,
        services: row.levelFromServices,
      }).toEqual({
        requiredLevel: 'advanced',
        adl: 'intermediate',
        flags: 'advanced',
        services: 'intermediate',
      });
      expect(new Date(rest.levelBreakdown!.calculatedAt).toISOString()).toBe(
        row.levelCalculatedAt!.toISOString(),
      );
    });
  });

  // ───────────────────────────── AC7 · คำนวณใหม่ ─────────────────────────────
  describe('AC7 · แก้ข้อมูลก่อน/หลังยืนยัน', () => {
    it('PYG-569_13 Verify that editing the assessment before confirmation changes the level', async () => {
      const e = await elder({ adl: ADL[12] });
      const { id, rest } = await bookOk(e);
      expect(rest.requiredLevel).toBe('BASIC');
      await h.submitAssessment(e.patient, e.recipientId, { adl: ADL[4] });
      expect(await levelOf(e, id)).toMatchObject({
        requiredLevel: 'ADVANCED',
        levelBreakdown: { adl: 'ADVANCED' },
      });
    });

    it('PYG-569_14 Verify that editing the assessment after confirmation does not change the level', async () => {
      const e = await elder({ adl: ADL[12] });
      const { id } = await bookOk(e);
      const cg = await h.seedCaregiver();
      expect(
        (await h.selectCaregiver(e.patient, id, cg.caregiverId)).errors,
      ).toBeUndefined();
      expect((await h.gql(cg.token, ACCEPT, { id })).errors).toBeUndefined();
      const confirmed = await h.gql(e.patient.token, CONFIRM, { id });
      expect(confirmed.errors).toBeUndefined();
      const before = await levelOf(e, id);
      await h.submitAssessment(e.patient, e.recipientId, {
        adl: ADL[4],
        flags: ['injection'],
      });
      expect(await levelOf(e, id)).toEqual(before);
      expect(before.requiredLevel).toBe('BASIC');
    });
  });

  // ─────────────────────────── Edge cases ───────────────────────────
  describe('Edge cases', () => {
    it('PYG-569_15 (E6) Verify that 3 "unsure" ADL answers raise the system unsure flag (seed: INTERMEDIATE)', async () => {
      const e = await elder({
        adl: { grooming: null, bathing: null, stairs: null },
      }); // null = 0 → 16
      const a = await h.prisma.careRecipientAssessment.findFirstOrThrow({
        where: { careRecipientId: e.recipientId },
      });
      expect(a.hasUnsureFlag).toBe(true);
      const { rest } = await bookOk(e);
      expect(rest.levelBreakdown).toMatchObject({
        adl: 'BASIC',
        flags: 'INTERMEDIATE',
      });
      expect(rest.requiredLevel).toBe('INTERMEDIATE');
    });

    it('PYG-569_16 (E6) Verify that 2 "unsure" answers do not raise the unsure flag', async () => {
      const e = await elder({ adl: { grooming: null, bathing: null } });
      const { rest } = await bookOk(e);
      expect(rest.levelBreakdown?.flags).toBeNull();
    });

    it('PYG-569_17 (E7) Verify that a flag without an active rule gives BOOKING_LEVEL_RULE_MISSING and saves nothing', async () => {
      await h.prisma.bookingLevelRule.updateMany({
        where: { source: 'flag', code: 'fall_risk' },
        data: { isActive: false },
      });
      try {
        const e = await elder({ flags: ['fall_risk'] });
        const before = await h.prisma.booking.count();
        const res = await book(e);
        expect(res.status).toBe(422);
        expect(restBody(res)).toMatchObject({
          code: 'BOOKING_LEVEL_RULE_MISSING',
        });
        expect(await h.prisma.booking.count()).toBe(before);
      } finally {
        await h.prisma.bookingLevelRule.updateMany({
          where: { source: 'flag', code: 'fall_risk' },
          data: { isActive: true },
        });
      }
    });

    it('PYG-569_18 (E9) Verify that adding typed sub-tasks does not change the level', async () => {
      const e = await elder({ adl: ADL[12] });
      const plain = await bookOk(e);
      const typed = await bookOk(e, {
        tasks: ['ฉีดยา', 'ดูดเสมหะ', 'กายภาพบำบัด'],
      });
      expect(typed.rest.requiredLevel).toBe(plain.rest.requiredLevel);
      expect(typed.rest.levelBreakdown).toMatchObject({
        services: null,
        flags: null,
      });
    });

    it('PYG-569_19 (E10) Verify that one assessment edit recalculates both unconfirmed bookings', async () => {
      const e = await elder({ adl: ADL[20] });
      const b1 = await bookOk(e);
      const b2 = await bookOk(e);
      await h.submitAssessment(e.patient, e.recipientId, { adl: ADL[5] });
      for (const b of [b1, b2])
        expect((await levelOf(e, b.id)).requiredLevel).toBe('INTERMEDIATE');
    });

    it('PYG-569_20 (E11) Verify that a booking made before the feature returns null level without error', async () => {
      const e = await elder();
      const { id } = await bookOk(e);
      await h.prisma
        .$executeRaw`UPDATE bookings SET required_level = NULL, level_from_adl = NULL,
        level_from_flags = NULL, level_from_services = NULL, level_calculated_at = NULL WHERE id = ${id}::uuid`;
      expect(await levelOf(e, id)).toMatchObject({
        requiredLevel: null,
        levelBreakdown: null,
      });
    });

    it('PYG-569_21 Verify that the client cannot supply a level when creating a booking', async () => {
      const e = await elder();
      const res = await book(e, {
        requiredLevel: 'BASIC',
        levelBreakdown: { adl: 'BASIC' },
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('requiredLevel');
    });

    it('PYG-569_22 Verify that a user without access cannot read the level', async () => {
      const e = await elder();
      const { id } = await bookOk(e);
      const stranger = await h.seedUser('stranger');
      const s = await h.gql(stranger.token, MY_BOOKING, { id });
      expect(s.data).toBeNull();
      const other = await h.seedCaregiver();
      const c = await h.gql(other.token, CG_BOOKING, { id });
      expect(
        (c.data as { caregiverBooking: unknown } | null)?.caregiverBooking ??
          null,
      ).toBeNull();
      expect(codeOf(await h.gql(null, MY_BOOKING, { id }))).toBe(
        'UNAUTHENTICATED',
      );
    });

    it('PYG-569_23 Verify that the assigned caregiver sees the same level as the booker', async () => {
      const e = await elder({ adl: ADL[5] });
      const { id, rest } = await bookOk(e);
      const cg = await h.seedCaregiver();
      expect(
        (await h.selectCaregiver(e.patient, id, cg.caregiverId)).errors,
      ).toBeUndefined();
      const view = await h.gql(cg.token, CG_BOOKING, { id });
      expect(dataOf<LevelView>(view, 'caregiverBooking')).toMatchObject({
        requiredLevel: rest.requiredLevel,
        levelBreakdown: rest.levelBreakdown,
      });
    });
  });
});
