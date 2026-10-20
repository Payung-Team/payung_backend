/**
 * PYG-644 · QA ของ S17 (PYG-570) — Required Skills ของ booking
 *
 * ยิง REST/GraphQL เข้าแอปจริง (harness: test/support/qa-e2e.ts) ต่อ Postgres ทิ้งได้ใน Docker
 * TC_NO = PYG-570_NN · รายงานผล: docs/qa/pyg-644-required-skills-report.md
 *
 * ★ ค่าที่คาดไว้มาจาก "กติกาที่การ์ด PYG-644 ยืนยันเอง" เท่านั้น (ตามข้อควรระวังของการ์ด: ห้ามตั้ง
 *   expected จากตารางกติกาใน DB) — 4 ข้อ:
 *     ADL Transfer = 1 → transfer_assist · ADL อาบน้ำ = 0 → bathing
 *     Flag ต้องฉีดยา → injection (ล็อกพยาบาล) · จองกายภาพบำบัด → physiotherapy (ล็อกนักกายภาพเท่านั้น)
 *   กติกาอีก 10 ข้อรอ infographic ฉบับล่าสุด → BLOCKED ในรายงาน
 *   เคสที่ทดสอบ "กลไก" (รวมแหล่งซ้ำ, E11) ใช้คู่กติกาจาก seed และระบุไว้ในชื่อเคส — ตรวจพฤติกรรมของโค้ด
 *   ไม่ได้ยืนยันว่ากติกานั้นถูกตามอาจารย์
 *
 * story นี้ไม่มีหน้าจอ — ตรวจผ่าน API + ค่าในฐานข้อมูล
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

type Source = 'ADL' | 'FLAG' | 'SERVICE';
type ReqSkill = {
  skill: { code: string; nameTh: string; lockedProfessions: string[] };
  sources: Source[];
};
type Res = { status: number; body: unknown };

const REQ =
  'requiredSkills { skill { code nameTh lockedProfessions } sources }';
const MY_BOOKING = `query($id: ID!) { myBooking(id: $id) { id status tasks ${REQ} } }`;
const CG_BOOKING = `query($id: ID!) { caregiverBooking(id: $id) { id ${REQ} } }`;
const ACCEPT = `mutation($id: ID!) { acceptBooking(bookingId: $id) { id status } }`;
const CONFIRM = `mutation($id: ID!) { confirmBooking(bookingId: $id) { id status } }`;

const dataOf = <T>(body: GqlBody, field: string): T =>
  (body.data as Record<string, unknown>)[field] as T;
const bookedId = (res: Res) => (res.body as { id: string }).id;
const restBody = (res: Res) => res.body as Record<string, unknown>;

describeDb('PYG-644 · S17 required skills (PYG-570)', () => {
  let h: Harness;
  let caregiver: Awaited<ReturnType<Harness['seedCaregiver']>>;
  let day = 20;

  beforeAll(async () => {
    h = await bootstrap();
    // master data แบบ production (S15 กิจกรรม + S16 กติการะดับ + S17 ทักษะ) — ดู seedProductionMasterData
    await seedProductionMasterData();
    for (const serviceType of ['elderly_care', 'physiotherapy']) {
      await h.prisma.servicePriceCatalog.upsert({
        where: { serviceType },
        create: { serviceType, pricePerHour: 300 },
        update: { isActive: true },
      });
    }
    caregiver = await h.seedCaregiver();
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  /** ผู้จองใหม่ + ผู้รับบริการที่มีแบบประเมินตามที่กำหนด */
  async function elder(opts: Parameters<Harness['submitAssessment']>[2] = {}) {
    const patient = await h.seedUser('patient');
    const recipientId = await h.seedAssessedRecipient(patient, opts);
    return { patient, recipientId };
  }

  type Elder = Awaited<ReturnType<typeof elder>>;

  const book = (e: Elder, extra: Record<string, unknown> = {}) =>
    // ไม่ระบุผู้ดูแลตอนสร้าง (unmatched) — ตั้งแต่ S18 การระบุผู้ดูแลถูกตรวจสิทธิ์รับงาน ซึ่งไม่ใช่เป้าของ S17
    h.rest(e.patient.token).post('/api/v1/bookings', {
      careRecipientId: e.recipientId,
      tasks: ['ดูแลทั่วไป'],
      serviceLocations: ['at_home'],
      serviceType: 'elderly_care',
      startTime: '09:00',
      endTime: '11:00',
      locationAddress: 'บ้านทดสอบ QA-644',
      bookingDate: futureDate(day++),
      ...extra,
    });

  async function skillsOf(e: Elder, bookingId: string) {
    const body = await h.gql(e.patient.token, MY_BOOKING, { id: bookingId });
    expect(body.errors).toBeUndefined();
    return dataOf<{ requiredSkills: ReqSkill[] | null }>(body, 'myBooking')
      .requiredSkills;
  }

  /** code → sources (ใช้เทียบเฉพาะทักษะที่การ์ดยืนยัน) */
  const asMap = (list: ReqSkill[] | null) =>
    new Map((list ?? []).map((s) => [s.skill.code, s.sources]));

  /** DB สองที่ต้องตรงกัน: bookings.required_skills กับแถว booking_required_skills */
  async function dbSkills(bookingId: string) {
    const [b] = await h.prisma.$queryRaw<
      { required_skills: string[] | null }[]
    >`
      SELECT required_skills FROM bookings WHERE id = ${bookingId}::uuid`;
    const rows = await h.prisma.bookingRequiredSkill.findMany({
      where: { bookingId },
    });
    return { array: b.required_skills, rows };
  }

  async function bookAndRead(e: Elder, extra: Record<string, unknown> = {}) {
    const res = await book(e, extra);
    expect(res.status).toBe(201);
    const id = bookedId(res);
    return { id, skills: await skillsOf(e, id) };
  }

  const activityId = async (code: string) =>
    (await h.prisma.careActivity.findFirstOrThrow({ where: { code } })).id;

  // ───────────────────────────── AC1 · ADL ─────────────────────────────
  describe('AC1 · กติกา ADL (เฉพาะ 2 ข้อที่การ์ดยืนยัน)', () => {
    it('PYG-570_01 Verify that Transfer = 1 gives transfer_assist from ADL', async () => {
      const { skills } = await bookAndRead(
        await elder({ adl: { transfers: 1 } }),
      );
      expect(asMap(skills).get('transfer_assist')).toEqual(['ADL']);
    });

    it('PYG-570_02 Verify that Transfer = 3 (fully independent) gives no transfer_assist', async () => {
      const { skills } = await bookAndRead(
        await elder({ adl: { transfers: 3 } }),
      );
      expect(asMap(skills).has('transfer_assist')).toBe(false);
    });

    it('PYG-570_03 Verify that Bathing = 0 gives bathing from ADL', async () => {
      const { skills } = await bookAndRead(
        await elder({ adl: { bathing: 0 } }),
      );
      expect(asMap(skills).get('bathing')).toEqual(['ADL']);
    });

    it('PYG-570_04 Verify that Bathing = 1 (independent) gives no bathing', async () => {
      const { skills } = await bookAndRead(
        await elder({ adl: { bathing: 1 } }),
      );
      expect(asMap(skills).has('bathing')).toBe(false);
    });
  });

  // ───────────────────────────── AC2 · Flags ─────────────────────────────
  describe('AC2 · กติกา Flags (เฉพาะ "ต้องฉีดยา" ที่การ์ดยืนยัน)', () => {
    it('PYG-570_05 Verify that the "needs injection" flag gives injection from FLAG, locked to nurse', async () => {
      const { skills } = await bookAndRead(
        await elder({ flags: ['injection'] }),
      );
      const injection = (skills ?? []).find(
        (s) => s.skill.code === 'injection',
      );
      expect(injection).toMatchObject({
        sources: ['FLAG'],
        skill: { lockedProfessions: ['nurse'] },
      });
    });

    it('PYG-570_06 Verify that with no flag no skill comes from FLAG', async () => {
      const { skills } = await bookAndRead(await elder());
      expect((skills ?? []).filter((s) => s.sources.includes('FLAG'))).toEqual(
        [],
      );
    });
  });

  // ───────────────────────────── AC3 · บริการ ─────────────────────────────
  describe('AC3 · กติกาบริการ (เฉพาะกายภาพบำบัดที่การ์ดยืนยัน)', () => {
    it('PYG-570_07 Verify that booking physiotherapy (service type) gives physiotherapy from SERVICE', async () => {
      const { skills } = await bookAndRead(await elder(), {
        serviceType: 'physiotherapy',
      });
      expect(asMap(skills).get('physiotherapy')).toEqual(['SERVICE']);
    });

    it('PYG-570_08 Verify that booking the physiotherapy activity (F03) gives physiotherapy from SERVICE', async () => {
      const { skills } = await bookAndRead(await elder(), {
        activityIds: [await activityId('F03')],
      });
      expect(asMap(skills).get('physiotherapy')).toEqual(['SERVICE']);
    });

    it('PYG-570_09 Verify that booking another service without physiotherapy adds no physiotherapy', async () => {
      const { skills } = await bookAndRead(await elder(), {
        activityIds: [await activityId('A04')],
      });
      expect(asMap(skills).has('physiotherapy')).toBe(false);
    });
  });

  // ───────────────────────────── AC4 · รวมแหล่ง ─────────────────────────────
  describe('AC4 · ทักษะเดียวจากหลายแหล่ง (คู่กติกาจาก seed — ตรวจกลไกการรวม)', () => {
    it('PYG-570_10 Verify that one skill from 2 sources appears once with 2 sources (seed: flag injection + activity D05)', async () => {
      const { id, skills } = await bookAndRead(
        await elder({ flags: ['injection'] }),
        {
          activityIds: [await activityId('D05')],
        },
      );
      const rows = (skills ?? []).filter((s) => s.skill.code === 'injection');
      expect(rows).toHaveLength(1);
      expect(rows[0].sources).toEqual(['FLAG', 'SERVICE']);
      const { rows: db } = await dbSkills(id);
      expect(db.filter((r) => r.skillCode === 'injection')).toHaveLength(1);
    });

    it('PYG-570_11 Verify that one skill from 3 sources is not possible with the current rule table (no skill has ADL + FLAG + SERVICE rules)', async () => {
      const rules = await h.prisma.careSkillRule.findMany({
        where: { isActive: true },
      });
      const bySkill = new Map<string, Set<string>>();
      for (const r of rules)
        bySkill.set(
          r.skillCode,
          (bySkill.get(r.skillCode) ?? new Set()).add(r.source),
        );
      expect([...bySkill.values()].filter((set) => set.size === 3)).toEqual([]);
    });

    it('PYG-570_12 Verify that two ADL items giving the same skill list ADL once (seed: bladder 0 + bowels 0 → toileting_care)', async () => {
      const { skills } = await bookAndRead(
        await elder({ adl: { bladder: 0, bowels: 0 } }),
      );
      expect(
        (skills ?? []).filter((s) => s.skill.code === 'toileting_care'),
      ).toEqual([expect.objectContaining({ sources: ['ADL'] })]);
    });
  });

  // ───────────────────────────── AC5 · DB = API ─────────────────────────────
  describe('AC5 · ฐานข้อมูลตรงกับ API', () => {
    it('PYG-570_13 Verify that after booking the DB rows match the API (codes and sources) and both DB stores agree', async () => {
      const e = await elder({
        adl: { transfers: 1, bathing: 0 },
        flags: ['injection'],
      });
      const { id, skills } = await bookAndRead(e, {
        serviceType: 'physiotherapy',
      });
      const { array, rows } = await dbSkills(id);
      const api = (skills ?? []).map((s) => ({
        code: s.skill.code,
        sources: [...s.sources].sort(),
      }));
      const db = rows
        .map((r) => ({
          code: r.skillCode,
          sources: [...r.sources].map((x) => x.toUpperCase()).sort(),
        }))
        .sort((a, b) => a.code.localeCompare(b.code));
      expect(api).toEqual(db);
      expect([...(array ?? [])].sort()).toEqual(
        rows.map((r) => r.skillCode).sort(),
      );
      // REST ตอบ requiredSkills ด้วย
      expect(api.map((x) => x.code)).toEqual(
        expect.arrayContaining([
          'transfer_assist',
          'bathing',
          'injection',
          'physiotherapy',
        ]),
      );
    });

    it('PYG-570_14 Verify that the caregiver sees the same required skills as the booker', async () => {
      const e = await elder({ adl: { transfers: 1 } });
      const { id, skills } = await bookAndRead(e);
      expect(
        (await h.selectCaregiver(e.patient, id, caregiver.caregiverId)).errors,
      ).toBeUndefined();
      const cg = await h.gql(caregiver.token, CG_BOOKING, { id });
      expect(cg.errors).toBeUndefined();
      expect(
        dataOf<{ requiredSkills: ReqSkill[] }>(cg, 'caregiverBooking')
          .requiredSkills,
      ).toEqual(skills);
    });
  });

  // ───────────────────────────── AC6 ─────────────────────────────
  describe('AC6 · Transfer = 1 และอาบน้ำ = 0', () => {
    it('PYG-570_15 Verify that Transfer = 1 and Bathing = 0 give transfer_assist and bathing, both from ADL, not profession-locked', async () => {
      const { skills } = await bookAndRead(
        await elder({ adl: { transfers: 1, bathing: 0 } }),
      );
      for (const code of ['transfer_assist', 'bathing']) {
        expect((skills ?? []).find((s) => s.skill.code === code)).toMatchObject(
          {
            sources: ['ADL'],
            skill: { lockedProfessions: [] },
          },
        );
      }
    });
  });

  // ───────────────────────────── AC7 · กายภาพบำบัดทุกระดับ ─────────────────────────────
  describe('AC7 · กายภาพบำบัดที่ ADL รวม 12 / 5 / 4', () => {
    // ADL รวม: เต็ม = 20 · ลดข้อที่การ์ดยืนยันว่าไม่มีกติกาทักษะไม่ได้ → ลดจากข้อเดียวกันทุกชุด แล้วเทียบแค่ physiotherapy
    // เต็ม 20 · ชุด 12 / 5 / 4 ลดคะแนนจากข้อเดียวกัน แล้วเทียบเฉพาะ physiotherapy (ทักษะอื่นจากข้อที่ลดไม่ใช่เป้าของเคส)
    const LOW = { stairs: 0, grooming: 0, toilet_use: 0, mobility: 0 }; // 20 - 8 = 12
    const LOWER = { ...LOW, feeding: 0, dressing: 0, bowels: 0 }; // 12 - 6 = 6
    it.each([
      ['12', LOW],
      ['5', { ...LOWER, bladder: 1 }], // 6 - 1 = 5
      ['4', { ...LOWER, bladder: 0 }], // 6 - 2 = 4
    ])(
      'PYG-570_16 Verify that ADL total %s + physiotherapy only gives physiotherapy (locked to physiotherapist)',
      async (total, adl) => {
        const e = await elder({ adl });
        const recorded =
          await h.prisma.careRecipientAssessment.findFirstOrThrow({
            where: { careRecipientId: e.recipientId },
          });
        expect(String(recorded.adlTotalScore)).toBe(total);
        const { skills } = await bookAndRead(e, {
          serviceType: 'physiotherapy',
        });
        expect(
          (skills ?? []).find((s) => s.skill.code === 'physiotherapy'),
        ).toMatchObject({
          sources: ['SERVICE'],
          skill: { lockedProfessions: ['physiotherapist'] },
        });
      },
    );
  });

  // ───────────────────────────── AC8 · คำนวณใหม่ ─────────────────────────────
  describe('AC8 · แก้ข้อมูลก่อน/หลังยืนยัน', () => {
    it('PYG-570_17 Verify that editing the assessment before confirmation updates the list and leaves no stale rows', async () => {
      const e = await elder({ adl: { transfers: 1, bathing: 0 } });
      const { id, skills } = await bookAndRead(e);
      expect(asMap(skills).has('transfer_assist')).toBe(true);
      await h.submitAssessment(e.patient, e.recipientId, {
        adl: { transfers: 3, bathing: 0 },
      });
      const after = await skillsOf(e, id);
      expect(asMap(after).has('transfer_assist')).toBe(false);
      expect(asMap(after).get('bathing')).toEqual(['ADL']);
      const { array, rows } = await dbSkills(id);
      expect(rows.map((r) => r.skillCode)).not.toContain('transfer_assist');
      expect([...(array ?? [])].sort()).toEqual(
        rows.map((r) => r.skillCode).sort(),
      );
    });

    it('PYG-570_18 Verify that editing the assessment after confirmation does not change the list', async () => {
      const e = await elder({ adl: { transfers: 1 } });
      const { id } = await bookAndRead(e);
      expect(
        (await h.selectCaregiver(e.patient, id, caregiver.caregiverId)).errors,
      ).toBeUndefined();
      expect(
        (await h.gql(caregiver.token, ACCEPT, { id })).errors,
      ).toBeUndefined();
      const confirmed = await h.gql(e.patient.token, CONFIRM, { id });
      expect(confirmed.errors).toBeUndefined();
      const before = await skillsOf(e, id);
      await h.submitAssessment(e.patient, e.recipientId, {
        adl: { transfers: 3, bathing: 0 },
        flags: ['injection'],
      });
      expect(await skillsOf(e, id)).toEqual(before);
      expect(asMap(before).has('transfer_assist')).toBe(true);
    });

    it('PYG-570_19 Verify that one assessment edit recalculates both unconfirmed bookings of the same elder', async () => {
      const e = await elder();
      const b1 = await bookAndRead(e);
      const b2 = await bookAndRead(e);
      expect(asMap(b1.skills).has('injection')).toBe(false);
      await h.submitAssessment(e.patient, e.recipientId, {
        flags: ['injection'],
      });
      for (const b of [b1, b2])
        expect(asMap(await skillsOf(e, b.id)).get('injection')).toEqual([
          'FLAG',
        ]);
    });
  });

  // ─────────────────────────── ตารางเคสคำนวณ / Edge ───────────────────────────
  describe('Edge cases', () => {
    it('PYG-570_20 (E3) Verify that a fully independent elder, no flag, service without rules gives an empty list, not null', async () => {
      const { id, skills } = await bookAndRead(await elder());
      expect(skills).toEqual([]);
      expect((await dbSkills(id)).array).toEqual([]);
    });

    it('PYG-570_21 (E8) Verify that two assessments with the same total but different items give different lists', async () => {
      const a = await elder({ adl: { transfers: 1, bathing: 1 } }); // 20 - 2 = 18
      const c = await elder({ adl: { transfers: 3, bathing: 0, grooming: 0 } }); // 20 - 1 - 1 = 18
      const totals = await Promise.all(
        [a, c].map(
          async (x) =>
            (
              await h.prisma.careRecipientAssessment.findFirstOrThrow({
                where: { careRecipientId: x.recipientId },
              })
            ).adlTotalScore,
        ),
      );
      expect(totals[0]).toBe(totals[1]);
      const sa = asMap((await bookAndRead(a)).skills);
      const sc = asMap((await bookAndRead(c)).skills);
      expect([sa.has('transfer_assist'), sa.has('bathing')]).toEqual([
        true,
        false,
      ]);
      expect([sc.has('transfer_assist'), sc.has('bathing')]).toEqual([
        false,
        true,
      ]);
    });

    it('PYG-570_22 (E5) Verify that "unsure" on Transfer is treated as 0 and gives transfer_assist (decision 9 Oct 2026)', async () => {
      const { skills } = await bookAndRead(
        await elder({ adl: { transfers: null } }),
      );
      expect(asMap(skills).get('transfer_assist')).toEqual(['ADL']);
    });

    it('PYG-570_23 (E7) Verify that adding typed sub-tasks does not change the list', async () => {
      const e = await elder({ adl: { transfers: 1 } });
      const plain = await bookAndRead(e);
      const typed = await bookAndRead(e, {
        tasks: ['ฉีดยาอินซูลิน', 'กายภาพบำบัดขา', 'ดูดเสมหะ'],
      });
      expect(typed.skills).toEqual(plain.skills);
    });

    it('PYG-570_24 (E10) Verify that a booking made before the feature returns null without error', async () => {
      const e = await elder();
      const { id } = await bookAndRead(e);
      // จำลองแถวเก่า: ยังไม่เคยคำนวณ
      await h.prisma.bookingRequiredSkill.deleteMany({
        where: { bookingId: id },
      });
      await h.prisma
        .$executeRaw`UPDATE bookings SET required_skills = NULL WHERE id = ${id}::uuid`;
      const body = await h.gql(e.patient.token, MY_BOOKING, { id });
      expect(body.errors).toBeUndefined();
      expect(
        dataOf<{ requiredSkills: unknown }>(body, 'myBooking').requiredSkills,
      ).toBeNull();
    });

    it('PYG-570_25 (E11) Verify that a matching rule pointing to an inactive skill gives SKILL_RULE_INVALID and saves nothing', async () => {
      await h.prisma.careSkill.update({
        where: { code: 'transfer_assist' },
        data: { isActive: false },
      });
      try {
        const e = await elder({ adl: { transfers: 1 } });
        const before = await h.prisma.booking.count();
        const rowsBefore = await h.prisma.bookingRequiredSkill.count();
        const res = await book(e);
        expect(res.status).toBe(422);
        expect(restBody(res)).toMatchObject({ code: 'SKILL_RULE_INVALID' });
        expect(await h.prisma.booking.count()).toBe(before);
        expect(await h.prisma.bookingRequiredSkill.count()).toBe(rowsBefore);
        // ไม่เข้าเงื่อนไขกติกานั้น → จองได้ตามปกติ
        expect(
          (await book(await elder({ adl: { transfers: 3 } }))).status,
        ).toBe(201);
      } finally {
        await h.prisma.careSkill.update({
          where: { code: 'transfer_assist' },
          data: { isActive: true },
        });
      }
    });

    it('PYG-570_26 Verify that the client cannot supply required skills when creating a booking', async () => {
      const e = await elder();
      const res = await book(e, {
        requiredSkills: ['injection'],
        required_skills: ['injection'],
      });
      if (res.status === 201) {
        expect(asMap(await skillsOf(e, bookedId(res))).has('injection')).toBe(
          false,
        );
      } else {
        expect(res.status).toBe(400);
      }
      const gql = await h.gql(
        e.patient.token,
        `mutation($i: CreateBookingOnBehalfInput!) { createBookingOnBehalf(input: $i) { id } }`,
        {
          // ช่องบังคับครบ — ปัญหาเดียวคือ requiredSkills ที่ไม่มีใน input
          i: {
            groupId: '00000000-0000-4000-8000-000000000000',
            tasks: ['ดูแลทั่วไป'],
            serviceLocations: ['at_home'],
            serviceType: 'elderly_care',
            startTime: '09:00',
            endTime: '11:00',
            locationAddress: 'บ้านทดสอบ QA-644',
            bookingDate: futureDate(300),
            requiredSkills: ['injection'],
          },
        },
      );
      // ช่องที่ไม่มีใน input ถูก GraphQL ปฏิเสธก่อนถึง resolver
      expect(codeOf(gql)).toBe('BAD_USER_INPUT');
      expect(gql.errors![0].message).toContain('requiredSkills');
    });

    it('PYG-570_27 Verify that a user without access to the booking cannot read its required skills', async () => {
      const e = await elder({ flags: ['injection'] });
      const { id } = await bookAndRead(e);
      const stranger = await h.seedUser('stranger');
      const other = await h.seedCaregiver();
      const s = await h.gql(stranger.token, MY_BOOKING, { id });
      expect(s.data).toBeNull();
      expect(s.errors).toBeDefined();
      const c = await h.gql(other.token, CG_BOOKING, { id });
      const cgData = c.data as { caregiverBooking: unknown } | null;
      expect(cgData?.caregiverBooking ?? null).toBeNull();
      const anon = await h.gql(null, MY_BOOKING, { id });
      expect(codeOf(anon)).toBe('UNAUTHENTICATED');
    });

    it('PYG-570_28 Verify that general skills are not profession-locked (transfer_assist, bathing)', async () => {
      const body = await h.gql(
        caregiver.token,
        `query { careSkills(profession: "nurse") { code lockedProfessions } }`,
      );
      const list = dataOf<{ code: string; lockedProfessions: string[] }[]>(
        body,
        'careSkills',
      );
      for (const code of ['transfer_assist', 'bathing']) {
        expect(list.find((x) => x.code === code)?.lockedProfessions).toEqual(
          [],
        );
      }
    });
  });
});
