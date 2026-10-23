/**
 * PYG-615 · QA ของ S09 (PYG-564) — จัดกลุ่มผู้สูงอายุ ติดสังคม / ติดบ้าน / ติดเตียง จากคะแนน ADL รวม
 *
 * ยิง GraphQL / REST เข้าแอปจริง (harness: test/support/qa-e2e.ts) ต่อ Postgres ทิ้งได้ใน Docker
 * TC_NO = PYG-564_NN · รายงานผล: docs/qa/pyg-615-care-group-report.md
 *
 * - expected ของกลุ่มตามคะแนน: ตาราง AC1–AC4 ในการ์ด (0/2/4 ติดเตียง · 5/8/11 ติดบ้าน · 12/16/20 ติดสังคม)
 * - คะแนนสร้างผ่านแบบประเมินจริงเท่านั้น (การ์ดห้ามเขียน adl_total_score / care_group ตรง ๆ)
 *   ชุดคำตอบ: เติมคะแนนตามลำดับข้อ Barthel ทีละข้อจนครบยอด (คำนวณมือได้)
 * - "ไม่แน่ใจ": การ์ดให้ Blocked จนกว่า S08 เคาะ — S08 เคาะแล้ว (null = 0 · มติ 9 ต.ค.) จึงทดสอบ _15 / _16
 */
import {
  bootstrap,
  codeOf,
  describeDb,
  GqlBody,
  Harness,
} from './support/qa-e2e';

type Group = 'SOCIAL' | 'HOMEBOUND' | 'BEDRIDDEN';
type Res = { status: number; body: unknown };

/** ลำดับและคะแนนเต็มของ Barthel ADL ฉบับไทย (รวม 20) */
const ORDER: [string, number][] = [
  ['feeding', 2],
  ['grooming', 1],
  ['transfers', 3],
  ['toilet_use', 2],
  ['mobility', 3],
  ['dressing', 2],
  ['stairs', 2],
  ['bathing', 1],
  ['bowels', 2],
  ['bladder', 2],
];
/** ชุดคำตอบที่รวมได้ total: เติมเต็มทีละข้อตามลำดับ ข้อสุดท้ายรับเศษ ที่เหลือ 0 */
function adlFor(total: number): Record<string, number> {
  let left = total;
  return Object.fromEntries(
    ORDER.map(([code, max]) => {
      const v = Math.min(max, left);
      left -= v;
      return [code, v];
    }),
  );
}

const SUBMIT = `mutation($input: SubmitCareRecipientAssessmentInput!) {
  submitCareRecipientAssessment(input: $input) { careRecipientId adlTotalScore careGroup } }`;
const READ = `query($id: ID!) { careRecipientAssessment(careRecipientId: $id) { adlTotalScore careGroup } }`;
const GROUP_LIST = `query($g: ID!) { groupCareRecipients(groupId: $g) { id careGroup hasAssessment } }`;

const dataOf = <T>(body: GqlBody, field: string): T =>
  (body.data as Record<string, unknown>)[field] as T;
type Rest = { id: string; careGroup: Group | null; hasAssessment: boolean };

describeDb('PYG-615 · S09 care group (PYG-564)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await bootstrap();
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  /** ญาติ + โปรไฟล์ผ่าน REST จริง (POST /patient/care-recipients) */
  async function owner(details?: Record<string, unknown>) {
    const user = await h.seedUser('relative');
    const res: Res = await h
      .rest(user.token)
      .post('/api/v1/patient/care-recipients', {
        name: `ผู้สูงอายุทดสอบ ${user.id.slice(0, 4)}`,
        ...(details ? { details } : {}),
      });
    expect(res.status).toBe(201);
    return { user, created: res.body as Rest };
  }
  type Owner = Awaited<ReturnType<typeof owner>>;

  async function assess(
    o: Owner,
    total: number,
    extra: Partial<{
      adl: Record<string, number | null>;
      flags: string[];
    }> = {},
  ) {
    const adl = extra.adl ?? adlFor(total);
    const flags = extra.flags ?? [];
    const body = await h.gql(o.user.token, SUBMIT, {
      input: {
        careRecipientId: o.created.id,
        answers: ORDER.map(([code]) => ({ code, value: adl[code] })),
        flags,
        noSpecialConditions: flags.length === 0,
      },
    });
    expect(body.errors).toBeUndefined();
    return dataOf<{ adlTotalScore: number; careGroup: Group }>(
      body,
      'submitCareRecipientAssessment',
    );
  }

  async function restProfile(o: Owner) {
    const list = (
      await h.rest(o.user.token).get('/api/v1/patient/care-recipients')
    ).body as Rest[];
    return list.find((r) => r.id === o.created.id);
  }

  // ───────────────────────────── AC1–AC4 ─────────────────────────────
  describe('AC1–AC4 · กลุ่มตามคะแนน (รวมค่าขอบ)', () => {
    it.each<[number, Group]>([
      [20, 'SOCIAL'],
      [16, 'SOCIAL'],
      [12, 'SOCIAL'],
      [11, 'HOMEBOUND'],
      [8, 'HOMEBOUND'],
      [5, 'HOMEBOUND'],
      [4, 'BEDRIDDEN'],
      [2, 'BEDRIDDEN'],
      [0, 'BEDRIDDEN'],
    ])(
      'PYG-564_01 Verify that ADL total %i gives the %s group (submit response, profile and DB agree)',
      async (total, group) => {
        const o = await owner();
        const r = await assess(o, total);
        expect([r.adlTotalScore, r.careGroup]).toEqual([total, group]);
        expect((await restProfile(o))?.careGroup).toBe(group);
        const row = await h.prisma.careRecipientAssessment.findFirstOrThrow({
          where: { careRecipientId: o.created.id },
        });
        expect(row.careGroup).toBe(group.toLowerCase());
      },
    );
  });

  // ───────────────────────────── AC5 · แก้ไข ─────────────────────────────
  describe('AC5 · คำนวณใหม่เมื่อแก้แบบประเมิน', () => {
    it.each<[number, number, Group]>([
      [12, 11, 'HOMEBOUND'],
      [5, 4, 'BEDRIDDEN'],
      [4, 12, 'SOCIAL'],
      [16, 13, 'SOCIAL'],
      [8, 6, 'HOMEBOUND'],
    ])(
      'PYG-564_02 Verify that editing from %i to %i gives %s, readable right after saving',
      async (from, to, group) => {
        const o = await owner();
        await assess(o, from);
        expect((await assess(o, to)).careGroup).toBe(group);
        expect((await restProfile(o))?.careGroup).toBe(group);
        expect(
          dataOf<{ careGroup: Group }>(
            await h.gql(o.user.token, READ, { id: o.created.id }),
            'careRecipientAssessment',
          ).careGroup,
        ).toBe(group);
      },
    );
  });

  // ───────────────────────────── AC6 · ทุก operation ─────────────────────────────
  describe('AC6 · ทุก operation ที่คืนโปรไฟล์', () => {
    it('PYG-564_03 Verify that REST GET / POST / PUT care-recipients always carry careGroup (null before assessment, kept after editing details)', async () => {
      const o = await owner();
      expect(o.created).toMatchObject({
        careGroup: null,
        hasAssessment: false,
      });
      await assess(o, 8);
      const put: Res = await h
        .rest(o.user.token)
        .put(`/api/v1/patient/care-recipients/${o.created.id}`, {
          nickname: 'ชื่อเล่นใหม่',
          details: { supportLevel: 'ช่วยเหลือตัวเองได้ดี' },
        });
      expect(put.status).toBe(200);
      expect(put.body).toMatchObject({
        careGroup: 'HOMEBOUND',
        hasAssessment: true,
      });
      expect(await restProfile(o)).toMatchObject({ careGroup: 'HOMEBOUND' });
    });

    it('PYG-564_04 Verify that groupCareRecipients / addGroupCareRecipient / updateGroupCareRecipient carry careGroup for all 3 groups', async () => {
      const { groupId, owner: g } = await h.seedGroup(0);
      const add = await h.gql(
        g.token,
        `mutation($i: AddGroupCareRecipientInput!) { addGroupCareRecipient(input: $i) { id careGroup } }`,
        {
          i: { groupId, name: 'ผู้สูงอายุในกลุ่ม' },
        },
      );
      expect(add.errors).toBeUndefined();
      const added = dataOf<{ id: string; careGroup: Group | null }>(
        add,
        'addGroupCareRecipient',
      );
      expect(added.careGroup).toBeNull();
      const asOwner = {
        user: g,
        created: { id: added.id, careGroup: null, hasAssessment: false },
      };
      for (const [total, group] of [
        [20, 'SOCIAL'],
        [8, 'HOMEBOUND'],
        [0, 'BEDRIDDEN'],
      ] as const) {
        await assess(asOwner, total);
        const list = dataOf<{ id: string; careGroup: Group }[]>(
          await h.gql(g.token, GROUP_LIST, { g: groupId }),
          'groupCareRecipients',
        );
        expect(list.find((r) => r.id === added.id)?.careGroup).toBe(group);
      }
      const upd = await h.gql(
        g.token,
        `mutation($i: UpdateGroupCareRecipientInput!) { updateGroupCareRecipient(input: $i) { id careGroup } }`,
        {
          i: { groupId, recipientId: added.id, nickname: 'ยาย' },
        },
      );
      expect(upd.errors).toBeUndefined();
      expect(
        dataOf<{ careGroup: Group }>(upd, 'updateGroupCareRecipient').careGroup,
      ).toBe('BEDRIDDEN');
    });

    it('PYG-564_05 Verify that the assessment read query carries careGroup', async () => {
      const o = await owner();
      await assess(o, 12);
      expect(
        dataOf<{ careGroup: Group }>(
          await h.gql(o.user.token, READ, { id: o.created.id }),
          'careRecipientAssessment',
        ).careGroup,
      ).toBe('SOCIAL');
    });
  });

  // ───────────────────────────── AC7 · ไม่มีแบบประเมิน ─────────────────────────────
  describe('AC7 · ยังไม่มีแบบประเมิน', () => {
    it.each([
      ['ช่วยเหลือตัวเองได้ดี'],
      ['ช่วยเหลือตัวเองได้เล็กน้อย / ต้องการการช่วยพยุงเดิน'],
      ['ช่วยเหลือตัวเองไม่ได้ / ติดเตียง'],
      ['ใช้รถเข็น'],
    ])(
      'PYG-564_06 Verify that a profile without assessment has careGroup null for mobility level "%s", without error',
      async (supportLevel) => {
        const o = await owner({ supportLevel });
        expect(o.created).toMatchObject({
          careGroup: null,
          hasAssessment: false,
        });
        expect((await restProfile(o))?.careGroup).toBeNull();
        const read = await h.gql(o.user.token, READ, { id: o.created.id });
        expect(read.errors).toBeUndefined();
        expect(dataOf<unknown>(read, 'careRecipientAssessment')).toBeNull();
      },
    );
  });

  // ─────────────────────────── Edge cases ───────────────────────────
  describe('Edge cases', () => {
    it('PYG-564_07 (E7) Verify that the group comes from ADL even when mobility level says otherwise, and mobility level is not changed', async () => {
      const o = await owner({
        supportLevel: 'ช่วยเหลือตัวเองไม่ได้ / ติดเตียง',
      });
      expect((await assess(o, 20)).careGroup).toBe('SOCIAL');
      const row = await h.prisma.careRecipient.findUniqueOrThrow({
        where: { id: o.created.id },
        select: { mobility_level: true },
      });
      expect(row.mobility_level).toBe('bedridden');
    });

    it('PYG-564_08 Verify that editing only the flags keeps the group', async () => {
      const o = await owner();
      await assess(o, 8);
      expect(
        (
          await assess(o, 8, {
            flags: ['oxygen', 'pressure_ulcer', 'end_of_life'],
          })
        ).careGroup,
      ).toBe('HOMEBOUND');
    });

    it('PYG-564_09 Verify that a group sent in the assessment or profile input is rejected and the group still comes from the score', async () => {
      const o = await owner();
      await assess(o, 4);
      const viaGql = await h.gql(o.user.token, SUBMIT, {
        input: {
          careRecipientId: o.created.id,
          answers: ORDER.map(([code]) => ({ code, value: adlFor(4)[code] })),
          flags: [],
          noSpecialConditions: true,
          careGroup: 'SOCIAL',
        },
      });
      expect(codeOf(viaGql)).toBe('BAD_USER_INPUT');
      const viaRest: Res = await h
        .rest(o.user.token)
        .put(`/api/v1/patient/care-recipients/${o.created.id}`, {
          careGroup: 'SOCIAL',
        });
      expect(viaRest.status).toBe(400);
      expect((await restProfile(o))?.careGroup).toBe('BEDRIDDEN');
    });

    it('PYG-564_10 Verify that two elders of one account in different groups each keep their own group', async () => {
      const o = await owner();
      const second: Res = await h
        .rest(o.user.token)
        .post('/api/v1/patient/care-recipients', {
          name: 'ผู้สูงอายุคนที่สอง',
        });
      const o2 = { user: o.user, created: second.body as Rest };
      await assess(o, 20);
      await assess(o2, 3);
      const list = (
        await h.rest(o.user.token).get('/api/v1/patient/care-recipients')
      ).body as Rest[];
      expect(list.find((r) => r.id === o.created.id)?.careGroup).toBe('SOCIAL');
      expect(list.find((r) => r.id === o2.created.id)?.careGroup).toBe(
        'BEDRIDDEN',
      );
    });

    it("PYG-564_11 Verify that relative A cannot read relative B's elder group", async () => {
      const b = await owner();
      await assess(b, 2);
      const a = await owner();
      const list = (
        await h.rest(a.user.token).get('/api/v1/patient/care-recipients')
      ).body as Rest[];
      expect(list.map((r) => r.id)).not.toContain(b.created.id);
      const read = await h.gql(a.user.token, READ, { id: b.created.id });
      expect(codeOf(read)).toBe('ASSESSMENT_ACCESS_DENIED');
      expect(JSON.stringify(read)).not.toContain('BEDRIDDEN');
    });

    it('PYG-564_12 Verify that a caregiver role gets no group (assessment read denied, booking patient profile has no careGroup field)', async () => {
      const o = await owner();
      await assess(o, 2);
      const cg = await h.seedCaregiver();
      expect(codeOf(await h.gql(cg.token, READ, { id: o.created.id }))).toBe(
        'ASSESSMENT_ACCESS_DENIED',
      );
      const t = await h.gql(
        cg.token,
        `query { __type(name: "CaregiverBookingSummary") { fields { name } } }`,
      );
      expect(JSON.stringify(t)).not.toContain('careGroup');
    });

    it('PYG-564_13 Verify that careGroup appears only on the allowed types and calls without login are refused', async () => {
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
      const withGroup = types
        .filter((t) => (t.fields ?? []).some((f) => f.name === 'careGroup'))
        .map((t) => t.name)
        .sort();
      // S14 (PR #163): RecommendedServicePackages ตอบกลุ่มที่ใช้เลือกชุด — อนุญาตตาม src/common/care-group-contract.spec.ts
      expect(withGroup).toEqual([
        'CareRecipientAssessment',
        'GroupCareRecipient',
        'RecommendedServicePackages',
      ]);
      const o = await owner();
      expect(codeOf(await h.gql(null, READ, { id: o.created.id }))).toBe(
        'UNAUTHENTICATED',
      );
      const anon = await h
        .rest('no-such-token')
        .get('/api/v1/patient/care-recipients');
      expect(anon.status).toBe(401);
    });

    it('PYG-564_14 Verify that a client not asking for careGroup still gets the profile list as before (regression)', async () => {
      const { groupId, owner: g } = await h.seedGroup(0);
      const body = await h.gql(
        g.token,
        `query($g: ID!) { groupCareRecipients(groupId: $g) { id name } }`,
        { g: groupId },
      );
      expect(body.errors).toBeUndefined();
      const o = await owner();
      const res: Res = await h
        .rest(o.user.token)
        .get('/api/v1/patient/care-recipients');
      expect(res.status).toBe(200);
    });

    it('PYG-564_15 Verify that "unsure" on every item (S08: null = 0) gives BEDRIDDEN, not null', async () => {
      const o = await owner();
      const r = await assess(o, 0, {
        adl: Object.fromEntries(ORDER.map(([c]) => [c, null])),
      });
      expect([r.adlTotalScore, r.careGroup]).toEqual([0, 'BEDRIDDEN']);
      expect((await restProfile(o))?.careGroup).toBe('BEDRIDDEN');
    });

    it('PYG-564_16 Verify that "unsure" answers count as 0 at the 11/12 boundary (12 - 1 unsure on a 1-point item = 11 → HOMEBOUND)', async () => {
      const o = await owner();
      const adl: Record<string, number | null> = adlFor(12);
      const onePointItem = Object.entries(adl).find(
        ([code, v]) => v === 1 && ORDER.find(([c]) => c === code)![1] === 1,
      )![0];
      adl[onePointItem] = null;
      expect((await assess(o, 11, { adl })).careGroup).toBe('HOMEBOUND');
    });
  });
});
