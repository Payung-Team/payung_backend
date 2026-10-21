/**
 * PYG-636 · QA ของ S15 (PYG-568) — รายการกิจกรรมกลาง การปิดใช้งาน และการเลือกตอนจอง
 *
 * ยิง GraphQL / REST เข้าแอปจริง (harness: test/support/qa-e2e.ts) ต่อ Postgres ทิ้งได้ใน Docker
 * TC_NO = PYG-568_NN ตามรูปแบบของทีม · รายงานผล: docs/qa/pyg-636-care-activities-report.md
 *
 * ข้อมูลเริ่มต้น (AC2): ล้างตาราง care_activities แล้วรัน migration ข้อมูลของ S15 ตามลำดับเดียวกับ production
 *   (seed T-01 → PYG-651 taxonomy → ชื่อย่อ E11) แล้วเทียบกับ "ค่าที่ควรเป็น" ที่คำนวณจาก
 *   docs/pyg568-t01-phase-pilot-20261008.csv + ตารางการเปลี่ยนแปลงของ PYG-651 ด้านล่าง (เขียนแยกจาก SQL)
 *
 * ไม่ครอบ (FE): หน้าจอแอดมิน/หน้าจอง การจัดกลุ่มบนจอ ความกว้างมือถือ การกัน URL — ดูรายงาน §ไม่ได้ทดสอบ
 */
import { createHash, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import {
  bootstrap,
  codeOf,
  DB_URL,
  describeDb,
  futureDate,
  GqlBody,
  Harness,
} from './support/qa-e2e';

const ROOT = join(__dirname, '..');
const MIGRATIONS = [
  '20261008040000_pyg568_seed_care_activities',
  '20261008080000_pyg651_care_activities_align_taxonomy',
  '20261008090000_pyg651_care_activity_e11_short_name',
];

const LEVEL_TH: Record<string, string> = {
  ต้น: 'basic',
  กลาง: 'intermediate',
  สูง: 'advanced',
};
const LEVEL_API: Record<string, string> = {
  basic: 'BASIC',
  intermediate: 'INTERMEDIATE',
  advanced: 'ADVANCED',
};

type Row = { code: string; name: string; category: string; level: string };

/** T-01 ร่าง 8 ต.ค. 2026 (43 แถว) — อ่านจาก CSV ต้นทาง */
function readT01(): Row[] {
  const lines = readFileSync(
    join(ROOT, 'docs/pyg568-t01-phase-pilot-20261008.csv'),
    'utf8',
  )
    .trim()
    .split('\n')
    .slice(1);
  return lines.map((line) => {
    const [code, name, category, level] = line.split(',');
    return { code, name, category, level: LEVEL_TH[level] };
  });
}

/**
 * PYG-651 — ปรับตาม Caregiver Service Taxonomy (Sammy อนุมัติ 8 ต.ค. 2026)
 * เขียนจากคอมเมนต์/ตารางของการ์ด ไม่ได้คัดจาก SQL ทีละบรรทัด เพื่อให้เทียบกับ migration ได้จริง
 */
const TAXONOMY_LEVEL: Record<string, string> = {
  A01: 'intermediate',
  A02: 'basic',
  A03: 'intermediate',
  D02: 'basic',
  E01: 'intermediate',
  E03: 'advanced',
  E06: 'intermediate',
  F04: 'intermediate',
};
const TAXONOMY_RENAME: Record<string, string> = {
  E01: 'วัดสัญญาณชีพครบชุด (ความดัน ชีพจร อุณหภูมิ การหายใจ) และบันทึก',
  E06: 'ทำแผลทั่วไป (แผลเล็ก แผลตื้น ไม่ติดเชื้อ)',
  G02: 'ดูแลผู้มีภาวะสมองเสื่อม ป้องกันการพลัดหลง',
};
const TAXONOMY_ADDED: Row[] = [
  {
    code: 'A10',
    name: 'โกนหนวด',
    category: 'สุขอนามัยส่วนบุคคล',
    level: 'basic',
  },
  {
    code: 'C05',
    name: 'ดูแลโภชนาการ วางแผนมื้ออาหารตามโรค',
    category: 'อาหารและโภชนาการ',
    level: 'intermediate',
  },
  {
    code: 'E08',
    name: 'ปฐมพยาบาลเบื้องต้นและ CPR / AED',
    category: 'การเฝ้าระวังสุขภาพ',
    level: 'intermediate',
  },
  {
    code: 'E09',
    name: 'ป้องกันการติดเชื้อ (ล้างมือ จัดการของปนเปื้อน)',
    category: 'การเฝ้าระวังสุขภาพ',
    level: 'intermediate',
  },
  {
    code: 'E10',
    name: 'ทำแผลถลอก ล้างแผลด้วยน้ำเกลือ ประคบร้อนเย็น',
    category: 'การพยาบาลเฉพาะ',
    level: 'basic',
  },
  // ชื่อย่อตามมติ 8 ต.ค. (migration 20261008090000)
  {
    code: 'E11',
    name: 'ทำแผลกดทับรุนแรง',
    category: 'การพยาบาลเฉพาะ',
    level: 'advanced',
  },
  {
    code: 'G04',
    name: 'รับมือพฤติกรรมผู้ป่วยสมองเสื่อม',
    category: 'ความปลอดภัยและการเฝ้าดู',
    level: 'advanced',
  },
  {
    code: 'H04',
    name: 'สอนใช้มือถือ วิดีโอคอลกับครอบครัว',
    category: 'เพื่อนและสังคม',
    level: 'basic',
  },
  {
    code: 'H05',
    name: 'ดูแลอารมณ์ (เหงา ซึม)',
    category: 'เพื่อนและสังคม',
    level: 'intermediate',
  },
  {
    code: 'H06',
    name: 'จัดการเอกสารและสิทธิการรักษา',
    category: 'เพื่อนและสังคม',
    level: 'intermediate',
  },
  {
    code: 'J01',
    name: 'ประเมินความเสี่ยงตาม checklist',
    category: 'ประเมินและประสานงาน',
    level: 'intermediate',
  },
  {
    code: 'J02',
    name: 'สอนญาติทำกิจวัตรพื้นฐาน',
    category: 'ประเมินและประสานงาน',
    level: 'intermediate',
  },
  {
    code: 'J03',
    name: 'ประเมินอาการและทำ care plan',
    category: 'ประเมินและประสานงาน',
    level: 'advanced',
  },
  {
    code: 'J04',
    name: 'สอนญาติงานทางคลินิก',
    category: 'ประเมินและประสานงาน',
    level: 'advanced',
  },
  {
    code: 'J05',
    name: 'ประสานแพทย์หรือนักกายภาพ',
    category: 'ประเมินและประสานงาน',
    level: 'advanced',
  },
];

function expectedCatalog(): Row[] {
  const rows = readT01().map((r) => ({
    ...r,
    level: TAXONOMY_LEVEL[r.code] ?? r.level,
    name: TAXONOMY_RENAME[r.code] ?? r.name,
  }));
  return [...rows, ...TAXONOMY_ADDED].sort((a, b) =>
    a.code.localeCompare(b.code),
  );
}

/** md5 ของ code|name|category|level เรียงตาม code — ใช้เทียบกับ production แบบอ่านอย่างเดียวในรายงาน */
export const catalogMd5 = (rows: Row[]) =>
  createHash('md5')
    .update(
      rows
        .map((r) => `${r.code}|${r.name}|${r.category}|${r.level}`)
        .join('\n'),
    )
    .digest('hex');

type Act = {
  id: string;
  code: string | null;
  nameTh: string;
  nameEn: string | null;
  category: string;
  careLevel: string;
  isActive: boolean;
  sortOrder: number;
};
type BookingAct = {
  activityId: string;
  name: string;
  category: string;
  careLevel: string;
};
type BookingDetail = { id: string; tasks: string[]; activities: BookingAct[] };

/** อ่านผลของ field เดียวจาก GraphQL พร้อมชนิด (data เป็น any ใน harness) */
const dataOf = <T>(body: GqlBody, field: string): T =>
  (body.data as Record<string, unknown>)[field] as T;

const FIELDS = 'id code nameTh nameEn category careLevel isActive sortOrder';
const LIST = `query { careActivities { ${FIELDS} } }`;
const ADMIN_LIST = `query($f: AdminCareActivitiesFilter) { adminCareActivities(filter: $f) { ${FIELDS} } }`;
const CREATE = `mutation($i: CreateCareActivityInput!) { createCareActivity(input: $i) { ${FIELDS} } }`;
const UPDATE = `mutation($id: ID!, $i: UpdateCareActivityInput!) { updateCareActivity(id: $id, input: $i) { ${FIELDS} } }`;
const SET_ACTIVE = `mutation($id: ID!, $a: Boolean!) { setCareActivityActive(id: $id, isActive: $a) { ${FIELDS} } }`;
const ACTIVITIES = 'activities { activityId name category careLevel }';
const MY_BOOKING = `query($id: ID!) { myBooking(id: $id) { id tasks ${ACTIVITIES} } }`;
const CG_BOOKING = `query($id: ID!) { caregiverBooking(id: $id) { id tasks ${ACTIVITIES} } }`;

/** ชื่อกิจกรรมทดสอบทุกตัวขึ้นต้นด้วย [QA-636] (การ์ดสั่งให้ระบุว่าเป็นข้อมูลทดสอบ) */
const qaName = (label: string) =>
  `[QA-636] ${label} ${randomUUID().slice(0, 6)}`;
const QA_CATEGORY = '[QA-636] หมวดทดสอบ';

describeDb('PYG-636 · S15 care activities (PYG-568)', () => {
  let h: Harness;
  let admin: Awaited<ReturnType<Harness['seedAdmin']>>;
  let patient: Awaited<ReturnType<Harness['seedUser']>>;
  let recipientId: string;
  let caregiver: Awaited<ReturnType<Harness['seedCaregiver']>>;

  beforeAll(async () => {
    h = await bootstrap();
    // ข้อมูลเริ่มต้นแบบเดียวกับ production — รันซ้ำได้ (ล้างก่อน)
    // migration มีหลายคำสั่ง + BEGIN/COMMIT → รันผ่าน pg (simple query) ไม่ใช่ Prisma
    const sql = new Client({ connectionString: DB_URL });
    await sql.connect();
    try {
      await sql.query('TRUNCATE care_activities CASCADE');
      for (const m of MIGRATIONS) {
        await sql.query(
          readFileSync(
            join(ROOT, 'prisma/migrations', m, 'migration.sql'),
            'utf8',
          ),
        );
      }
    } finally {
      await sql.end();
    }
    await h.prisma.servicePriceCatalog.upsert({
      where: { serviceType: 'elderly_care' },
      create: { serviceType: 'elderly_care', pricePerHour: 300 },
      update: { isActive: true },
    });
    admin = await h.seedAdmin();
    patient = await h.seedUser('patient');
    recipientId = await h.seedAssessedRecipient(patient);
    caregiver = await h.seedCaregiver();
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  // วันละใบ — ผู้จอง/ผู้ดูแลคนเดิมจองเวลาเดียวกันซ้ำจะได้ 409 (เวลาชน) ไม่ใช่ผลที่ต้องการทดสอบ
  let day = 30;
  const book = (
    extra: Record<string, unknown> = {},
    who = patient,
    rid = recipientId,
  ) =>
    h.rest(who.token).post('/api/v1/bookings', {
      caregiverId: caregiver.caregiverId,
      careRecipientId: rid,
      tasks: ['ดูแลทั่วไป'],
      serviceLocations: ['at_home'],
      serviceType: 'elderly_care',
      startTime: '09:00',
      endTime: '11:00',
      locationAddress: 'บ้านทดสอบ QA-636',
      bookingDate: futureDate(day++),
      ...extra,
    });

  const create = async (input: Record<string, unknown>) =>
    h.gql(admin.token, CREATE, { i: input });
  type Res = { status: number; body: unknown };
  const bookedId = (res: Res) => (res.body as { id: string }).id;
  const restBody = (res: Res) => res.body as Record<string, unknown>;
  const createAct = async (input: Record<string, unknown>) =>
    dataOf<Act>(await create(input), 'createCareActivity');
  const activeList = async () =>
    dataOf<Act[]>(await h.gql(patient.token, LIST), 'careActivities');
  const myBooking = async (id: string) =>
    dataOf<BookingDetail>(
      await h.gql(patient.token, MY_BOOKING, { id }),
      'myBooking',
    );
  const byCode = async (code: string) =>
    h.prisma.careActivity.findFirstOrThrow({ where: { code } });

  // ───────────────────────────── AC1 ─────────────────────────────
  describe('AC1 · หมวดและระดับ', () => {
    it('PYG-568_01 Verify that every activity in the list has a category and one of the 3 levels', async () => {
      const list = await activeList();
      expect(list.length).toBeGreaterThan(0);
      for (const a of list) {
        expect(a.category).toEqual(expect.any(String));
        expect(a.category.trim()).not.toBe('');
        expect(['BASIC', 'INTERMEDIATE', 'ADVANCED']).toContain(a.careLevel);
      }
    });

    it.each(['BASIC', 'INTERMEDIATE', 'ADVANCED'])(
      'PYG-568_02 Verify that an admin can add an activity at level %s',
      async (level) => {
        const body = await create({
          nameTh: qaName(`ระดับ ${level}`),
          category: QA_CATEGORY,
          careLevel: level,
        });
        expect(body.errors).toBeUndefined();
        expect(dataOf<Act>(body, 'createCareActivity')).toMatchObject({
          careLevel: level,
          category: QA_CATEGORY,
          isActive: true,
          code: null,
        });
      },
    );

    it('PYG-568_03 Verify that a level outside the 3 values is rejected with CARE_ACTIVITY_INVALID and nothing is written', async () => {
      const before = await h.prisma.careActivity.count();
      for (const bad of ['EXPERT', 'basic ', '', 'ระดับสูง']) {
        const body = await create({
          nameTh: qaName('ระดับผิด'),
          category: QA_CATEGORY,
          careLevel: bad,
        });
        expect(codeOf(body)).toBe('CARE_ACTIVITY_INVALID');
        expect(body.errors![0].extensions).toMatchObject({
          field: 'careLevel',
        });
      }
      expect(await h.prisma.careActivity.count()).toBe(before);
    });
  });

  // ───────────────────────────── AC2 ─────────────────────────────
  describe('AC2 · ข้อมูลเริ่มต้นตรงกับ T-01', () => {
    it('PYG-568_04 Verify that the T-01 source file matches the checksum recorded in the seed migration', () => {
      const t01 = readT01().sort((a, b) => a.code.localeCompare(b.code));
      expect(t01).toHaveLength(43);
      expect(catalogMd5(t01)).toBe('360b8f341d0e9f0371d0b518f49111a4');
    });

    it('PYG-568_05 Verify that every seeded activity matches T-01 (+ PYG-651) by name, category and level, with nothing extra or missing', async () => {
      const expected = expectedCatalog();
      const seeded = (
        await h.prisma.careActivity.findMany({
          where: { code: { not: null } },
          orderBy: { code: 'asc' },
        })
      ).map((r) => ({
        code: r.code!,
        name: r.nameTh,
        category: r.category,
        level: r.careLevel,
      }));
      expect(seeded).toEqual(expected);
      expect(seeded).toHaveLength(58);
    });

    it('PYG-568_06 Verify that the total and per-category counts match the expected catalog', async () => {
      const expected = expectedCatalog();
      const count = (rows: { category: string }[]) =>
        rows.reduce<Record<string, number>>(
          (acc, r) => ({ ...acc, [r.category]: (acc[r.category] ?? 0) + 1 }),
          {},
        );
      const seeded = await h.prisma.careActivity.findMany({
        where: { code: { not: null } },
      });
      expect(count(seeded)).toEqual(count(expected));
      expect(Object.keys(count(expected))).toHaveLength(12);
    });
  });

  // ───────────────────────────── AC3 ─────────────────────────────
  describe('AC3 · แอดมินจัดการรายการ', () => {
    it('PYG-568_07 Verify that an admin can add an activity and it appears in the booking list', async () => {
      const name = qaName('เพิ่มใหม่');
      const body = await create({
        nameTh: name,
        nameEn: 'QA added',
        category: QA_CATEGORY,
        careLevel: 'BASIC',
      });
      expect(body.errors).toBeUndefined();
      expect((await activeList()).map((a) => a.nameTh)).toContain(name);
    });

    it('PYG-568_08 Verify that an admin can edit the name, category and level', async () => {
      const made = await createAct({
        nameTh: qaName('ก่อนแก้'),
        category: QA_CATEGORY,
        careLevel: 'BASIC',
      });
      const newName = qaName('หลังแก้');
      const body = await h.gql(admin.token, UPDATE, {
        id: made.id,
        i: {
          nameTh: newName,
          category: `${QA_CATEGORY} 2`,
          careLevel: 'ADVANCED',
        },
      });
      expect(body.errors).toBeUndefined();
      expect(dataOf<Act>(body, 'updateCareActivity')).toMatchObject({
        nameTh: newName,
        category: `${QA_CATEGORY} 2`,
        careLevel: 'ADVANCED',
      });
      const row = await h.prisma.careActivity.findUniqueOrThrow({
        where: { id: made.id },
      });
      expect(row).toMatchObject({
        nameTh: newName,
        category: `${QA_CATEGORY} 2`,
        careLevel: 'advanced',
      });
    });

    it('PYG-568_09 Verify that an admin can deactivate and reactivate an activity', async () => {
      const made = await createAct({
        nameTh: qaName('ปิดเปิด'),
        category: QA_CATEGORY,
        careLevel: 'BASIC',
      });
      const off = await h.gql(admin.token, SET_ACTIVE, {
        id: made.id,
        a: false,
      });
      expect(dataOf<Act>(off, 'setCareActivityActive').isActive).toBe(false);
      const on = await h.gql(admin.token, SET_ACTIVE, { id: made.id, a: true });
      expect(dataOf<Act>(on, 'setCareActivityActive').isActive).toBe(true);
    });

    it('PYG-568_10 Verify that adding a duplicate name in the same category returns CARE_ACTIVITY_DUPLICATE', async () => {
      const name = qaName('ซ้ำ');
      expect(
        (
          await create({
            nameTh: name,
            category: QA_CATEGORY,
            careLevel: 'BASIC',
          })
        ).errors,
      ).toBeUndefined();
      const before = await h.prisma.careActivity.count();
      const dup = await create({
        nameTh: name,
        category: QA_CATEGORY,
        careLevel: 'ADVANCED',
      });
      expect(codeOf(dup)).toBe('CARE_ACTIVITY_DUPLICATE');
      expect(dup.errors![0].extensions).toMatchObject({
        category: QA_CATEGORY,
        nameTh: name,
      });
      expect(await h.prisma.careActivity.count()).toBe(before);
      // ต่างหมวดใช้ชื่อเดียวกันได้
      expect(
        (
          await create({
            nameTh: name,
            category: `${QA_CATEGORY} อื่น`,
            careLevel: 'BASIC',
          })
        ).errors,
      ).toBeUndefined();
    });

    it('PYG-568_11 Verify that renaming into an existing name in the same category returns CARE_ACTIVITY_DUPLICATE', async () => {
      const a = await createAct({
        nameTh: qaName('ก'),
        category: QA_CATEGORY,
        careLevel: 'BASIC',
      });
      const b = await createAct({
        nameTh: qaName('ข'),
        category: QA_CATEGORY,
        careLevel: 'BASIC',
      });
      const body = await h.gql(admin.token, UPDATE, {
        id: b.id,
        i: { nameTh: a.nameTh },
      });
      expect(codeOf(body)).toBe('CARE_ACTIVITY_DUPLICATE');
    });

    it.each([
      ['nameTh', { nameTh: '   ', category: QA_CATEGORY, careLevel: 'BASIC' }],
      [
        'category',
        { nameTh: qaName('ไม่มีหมวด'), category: '', careLevel: 'BASIC' },
      ],
    ])(
      'PYG-568_12 Verify that a blank required field (%s) is rejected and nothing is written',
      async (field, input) => {
        const before = await h.prisma.careActivity.count();
        const body = await create(input);
        expect(codeOf(body)).toBe('CARE_ACTIVITY_INVALID');
        expect(body.errors![0].extensions).toMatchObject({
          field,
          reason: 'required',
        });
        expect(await h.prisma.careActivity.count()).toBe(before);
      },
    );

    it('PYG-568_13 Verify that a missing required field is rejected by the API schema', async () => {
      const body = await create({
        nameTh: qaName('ไม่ส่งระดับ'),
        category: QA_CATEGORY,
      });
      expect(body.errors).toBeDefined();
      expect(body.data ?? null).toBeNull();
    });

    it('PYG-568_14 Verify that a name longer than 200 characters is rejected with CARE_ACTIVITY_INVALID too_long', async () => {
      const body = await create({
        nameTh: 'ก'.repeat(201),
        category: QA_CATEGORY,
        careLevel: 'BASIC',
      });
      expect(codeOf(body)).toBe('CARE_ACTIVITY_INVALID');
      expect(body.errors![0].extensions).toMatchObject({
        field: 'nameTh',
        reason: 'too_long',
        max: 200,
      });
    });

    it('PYG-568_15 Verify that editing an unknown id returns CARE_ACTIVITY_NOT_FOUND', async () => {
      const body = await h.gql(admin.token, UPDATE, {
        id: randomUUID(),
        i: { nameTh: qaName('ไม่มี') },
      });
      expect(codeOf(body)).toBe('CARE_ACTIVITY_NOT_FOUND');
    });

    it('PYG-568_16 Verify that the admin list filters by category, level, status and search', async () => {
      const name = qaName('กรอง');
      const made = await createAct({
        nameTh: name,
        category: QA_CATEGORY,
        careLevel: 'INTERMEDIATE',
      });
      await h.gql(admin.token, SET_ACTIVE, { id: made.id, a: false });
      const list = async (f: Record<string, unknown>) =>
        dataOf<Act[]>(
          await h.gql(admin.token, ADMIN_LIST, { f }),
          'adminCareActivities',
        ).map((a) => a.id);
      expect(await list({ search: name })).toEqual([made.id]);
      expect(
        await list({
          category: QA_CATEGORY,
          careLevel: 'INTERMEDIATE',
          isActive: false,
        }),
      ).toContain(made.id);
      expect(
        await list({ category: QA_CATEGORY, isActive: true }),
      ).not.toContain(made.id);
      expect(await list({ search: 'A01' })).toEqual([(await byCode('A01')).id]);
    });
  });

  // ───────────────────────────── AC4 ─────────────────────────────
  describe('AC4 · ปิดใช้งาน', () => {
    it('PYG-568_17 Verify that a deactivated activity is not offered for new bookings', async () => {
      const made = await createAct({
        nameTh: qaName('จะปิด'),
        category: QA_CATEGORY,
        careLevel: 'BASIC',
      });
      expect((await activeList()).map((a) => a.id)).toContain(made.id);
      await h.gql(admin.token, SET_ACTIVE, { id: made.id, a: false });
      expect((await activeList()).map((a) => a.id)).not.toContain(made.id);
      // แอดมินยังเห็น
      const all = dataOf<Act[]>(
        await h.gql(admin.token, ADMIN_LIST, { f: { search: made.nameTh } }),
        'adminCareActivities',
      );
      expect(all).toEqual([
        expect.objectContaining({ id: made.id, isActive: false }),
      ]);
    });

    it('PYG-568_18 Verify that a booking made before deactivation still shows the original name and level', async () => {
      const made = await createAct({
        nameTh: qaName('ใช้แล้วปิด'),
        category: QA_CATEGORY,
        careLevel: 'INTERMEDIATE',
      });
      const res = await book({ activityIds: [made.id] });
      expect(res.status).toBe(201);
      await h.gql(admin.token, SET_ACTIVE, { id: made.id, a: false });
      const detail = await myBooking(bookedId(res));
      expect(detail.activities).toEqual([
        {
          activityId: made.id,
          name: made.nameTh,
          category: QA_CATEGORY,
          careLevel: 'INTERMEDIATE',
        },
      ]);
    });

    it('PYG-568_19 Verify that booking with a deactivated activity (REST) returns 422 CARE_ACTIVITY_INACTIVE and creates no booking', async () => {
      const made = await createAct({
        nameTh: qaName('ปิดแล้วจอง'),
        category: QA_CATEGORY,
        careLevel: 'BASIC',
      });
      await h.gql(admin.token, SET_ACTIVE, { id: made.id, a: false });
      const before = await h.prisma.booking.count();
      const res = await book({ activityIds: [made.id] });
      expect(res.status).toBe(422);
      expect(restBody(res)).toMatchObject({
        code: 'CARE_ACTIVITY_INACTIVE',
        activityIds: [made.id],
      });
      expect(await h.prisma.booking.count()).toBe(before);
    });

    it('PYG-568_20 Verify that booking with an unknown activity id returns CARE_ACTIVITY_NOT_FOUND and creates no booking', async () => {
      const ghost = randomUUID();
      const before = await h.prisma.booking.count();
      const res = await book({ activityIds: [ghost] });
      expect(res.status).toBe(422);
      expect(restBody(res)).toMatchObject({
        code: 'CARE_ACTIVITY_NOT_FOUND',
        activityIds: [ghost],
      });
      expect(await h.prisma.booking.count()).toBe(before);
    });

    it('PYG-568_21 Verify that booking on behalf (GraphQL) with a deactivated activity returns CARE_ACTIVITY_INACTIVE and creates no booking', async () => {
      const made = await createAct({
        nameTh: qaName('ปิดแล้วจองแทน'),
        category: QA_CATEGORY,
        careLevel: 'BASIC',
      });
      await h.gql(admin.token, SET_ACTIVE, { id: made.id, a: false });
      const { groupId, owner, members } = await h.seedGroup(1);
      const member = members[0];
      const memberRecipient = await h.seedAssessedRecipient(member);
      await h.prisma.careRecipient.update({
        where: { id: memberRecipient },
        data: { familyGroupId: groupId },
      });
      const before = await h.prisma.booking.count();
      const body = await h.gql(
        owner.token,
        `mutation($i: CreateBookingOnBehalfInput!) { createBookingOnBehalf(input: $i) { id } }`,
        {
          i: {
            groupId,
            memberUserId: member.id,
            careRecipientId: memberRecipient,
            caregiverId: caregiver.caregiverId,
            tasks: ['ดูแลทั่วไป'],
            serviceLocations: ['at_home'],
            serviceType: 'elderly_care',
            startTime: '13:00',
            endTime: '15:00',
            locationAddress: 'บ้านทดสอบ QA-636',
            bookingDate: futureDate(200),
            activityIds: [made.id],
          },
        },
      );
      expect(codeOf(body)).toBe('CARE_ACTIVITY_INACTIVE');
      expect(await h.prisma.booking.count()).toBe(before);
    });
  });

  // ───────────────────────────── AC5 ─────────────────────────────
  describe('AC5 · เลือกตอนจอง', () => {
    it('PYG-568_22 Verify that the booking list contains only active activities, grouped by category with sort order ascending inside each group', async () => {
      const list = await activeList();
      expect(list.every((a) => a.isActive)).toBe(true);
      // จัดกลุ่ม: แต่ละหมวดอยู่ติดกันเป็นก้อนเดียว (ลำดับระหว่างหมวดเป็นไปตาม collation ของ DB — การ์ดไม่ได้กำหนด)
      const blocks: string[] = [];
      for (const a of list)
        if (blocks[blocks.length - 1] !== a.category) blocks.push(a.category);
      expect(new Set(blocks).size).toBe(blocks.length);
      // ภายในหมวด: sortOrder ไม่ลดลง
      for (let i = 1; i < list.length; i++) {
        if (list[i].category === list[i - 1].category) {
          expect(list[i].sortOrder).toBeGreaterThanOrEqual(
            list[i - 1].sortOrder,
          );
        }
      }
    });

    it('PYG-568_23 Verify that a booking with several activities saves all of them with name, category and level', async () => {
      const [a1, a2, a3] = await Promise.all(['A04', 'E04', 'H01'].map(byCode));
      const res = await book({ activityIds: [a1.id, a2.id, a3.id] });
      expect(res.status).toBe(201);
      const rows = await h.prisma.bookingActivity.findMany({
        where: { bookingId: bookedId(res) },
      });
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.careActivityId).sort()).toEqual(
        [a1.id, a2.id, a3.id].sort(),
      );
      for (const r of rows) {
        const src = [a1, a2, a3].find((a) => a.id === r.careActivityId)!;
        expect(r).toMatchObject({
          activityName: src.nameTh,
          category: src.category,
          careLevel: src.careLevel,
        });
      }
      // REST ตอบ activities กลับมาด้วย
      expect(restBody(res).activities).toHaveLength(3);
    });

    it('PYG-568_24 Verify that the booking detail shows the chosen activities to both the booker and the caregiver', async () => {
      const a = await byCode('B01');
      const res = await book({ activityIds: [a.id] });
      const expected = [
        {
          activityId: a.id,
          name: a.nameTh,
          category: a.category,
          careLevel: LEVEL_API[a.careLevel],
        },
      ];
      const mine = await myBooking(bookedId(res));
      expect(mine.activities).toEqual(expected);
      const cg = await h.gql(caregiver.token, CG_BOOKING, {
        id: bookedId(res),
      });
      expect(cg.errors).toBeUndefined();
      expect(dataOf<BookingDetail>(cg, 'caregiverBooking').activities).toEqual(
        expected,
      );
    });
  });

  // ───────────────────────────── AC6 ─────────────────────────────
  describe('AC6 · งานพิมพ์เอง', () => {
    it('PYG-568_25 Verify that a booking with typed tasks only succeeds and saves no activity', async () => {
      const res = await book({ tasks: ['พาเดินเล่นหลังอาหารเย็น'] });
      expect(res.status).toBe(201);
      expect(
        await h.prisma.bookingActivity.count({
          where: { bookingId: bookedId(res) },
        }),
      ).toBe(0);
      const detail = await myBooking(bookedId(res));
      expect(detail).toMatchObject({
        tasks: ['พาเดินเล่นหลังอาหารเย็น'],
        activities: [],
      });
    });

    it('PYG-568_26 Verify that a booking with both activities and typed tasks keeps them separate', async () => {
      const a = await byCode('A04');
      const res = await book({
        tasks: ['อ่านหนังสือพิมพ์ให้ฟัง'],
        activityIds: [a.id],
      });
      expect(res.status).toBe(201);
      const detail = await myBooking(bookedId(res));
      expect(detail.tasks).toEqual(['อ่านหนังสือพิมพ์ให้ฟัง']);
      expect(detail.activities.map((x) => x.name)).toEqual([a.nameTh]);
      // งานพิมพ์เองไม่กลายเป็นกิจกรรม (ไม่มีระดับ)
      const rows = await h.prisma.bookingActivity.findMany({
        where: { bookingId: bookedId(res) },
      });
      expect(rows.map((r) => r.activityName)).not.toContain(
        'อ่านหนังสือพิมพ์ให้ฟัง',
      );
    });

    it('PYG-568_27 Verify that typed tasks do not set a booking level (S16 not implemented → only checks required_level stays empty)', async () => {
      const res = await book({ tasks: ['ฉีดยา (พิมพ์เอง)'] });
      const row = await h.prisma.booking.findUniqueOrThrow({
        where: { id: bookedId(res) },
      });
      expect(row.requiredLevel).toBeNull();
    });
  });

  // ─────────────────────────── Edge cases ───────────────────────────
  describe('Edge cases', () => {
    it('PYG-568_28 (E1) Verify that renaming or re-levelling an activity in use does not change existing bookings', async () => {
      const made = await createAct({
        nameTh: qaName('ก่อนเปลี่ยน'),
        category: QA_CATEGORY,
        careLevel: 'BASIC',
      });
      const res = await book({ activityIds: [made.id] });
      await h.gql(admin.token, UPDATE, {
        id: made.id,
        i: { nameTh: qaName('หลังเปลี่ยน'), careLevel: 'ADVANCED' },
      });
      const detail = await myBooking(bookedId(res));
      expect(detail.activities[0]).toMatchObject({
        name: made.nameTh,
        careLevel: 'BASIC',
      });
    });

    it('PYG-568_29 (E2) Verify that deactivating an activity after it was picked rejects the confirm and keeps the rest of the request usable', async () => {
      const made = await createAct({
        nameTh: qaName('ปิดระหว่างจอง'),
        category: QA_CATEGORY,
        careLevel: 'BASIC',
      });
      const keep = await byCode('A04');
      // หน้าจองโหลดรายการ (ตอนนั้นยังเปิดอยู่) แล้วแอดมินปิด
      expect((await activeList()).map((a) => a.id)).toContain(made.id);
      await h.gql(admin.token, SET_ACTIVE, { id: made.id, a: false });
      const payload = {
        activityIds: [keep.id, made.id],
        tasks: ['ข้อมูลอื่นต้องไม่หาย'],
      };
      const res = await book(payload);
      expect(res.status).toBe(422);
      expect(restBody(res)).toMatchObject({
        code: 'CARE_ACTIVITY_INACTIVE',
        activityIds: [made.id],
      });
      // FE ตัด id ที่ถูกปฏิเสธออกแล้วส่งซ้ำด้วยข้อมูลเดิม → ผ่าน
      const retry = await book({ ...payload, activityIds: [keep.id] });
      expect(retry.status).toBe(201);
      expect(restBody(retry).tasks).toEqual(['ข้อมูลอื่นต้องไม่หาย']);
    });

    it('PYG-568_30 (E4) Verify that a reactivated activity is offered again for new bookings', async () => {
      const made = await createAct({
        nameTh: qaName('เปิดกลับ'),
        category: QA_CATEGORY,
        careLevel: 'BASIC',
      });
      await h.gql(admin.token, SET_ACTIVE, { id: made.id, a: false });
      await h.gql(admin.token, SET_ACTIVE, { id: made.id, a: true });
      expect((await activeList()).map((a) => a.id)).toContain(made.id);
      expect((await book({ activityIds: [made.id] })).status).toBe(201);
    });

    it('PYG-568_31 (E8) Verify that duplicated activityIds are saved once', async () => {
      const a = await byCode('C01');
      const res = await book({ activityIds: [a.id, a.id, a.id] });
      expect(res.status).toBe(201);
      expect(
        await h.prisma.bookingActivity.count({
          where: { bookingId: bookedId(res) },
        }),
      ).toBe(1);
    });

    it('PYG-568_32 (E9) Verify that a booking without activityIds still succeeds', async () => {
      const res = await book();
      expect(res.status).toBe(201);
      expect(restBody(res).activities).toEqual([]);
    });

    it('PYG-568_33 Verify that an elder and a caregiver cannot add, edit or deactivate activities', async () => {
      const target = await byCode('A04');
      for (const who of [patient, caregiver]) {
        const before = await h.prisma.careActivity.count();
        const c = await h.gql(who.token, CREATE, {
          i: {
            nameTh: qaName('แอบเพิ่ม'),
            category: QA_CATEGORY,
            careLevel: 'BASIC',
          },
        });
        const u = await h.gql(who.token, UPDATE, {
          id: target.id,
          i: { nameTh: 'แอบแก้' },
        });
        const s = await h.gql(who.token, SET_ACTIVE, {
          id: target.id,
          a: false,
        });
        const l = await h.gql(who.token, ADMIN_LIST, {});
        for (const body of [c, u, s, l]) expect(codeOf(body)).toBe('FORBIDDEN');
        expect(await h.prisma.careActivity.count()).toBe(before);
      }
      expect(await byCode('A04')).toMatchObject({
        nameTh: target.nameTh,
        isActive: true,
      });
    });

    it('PYG-568_34 Verify that an unauthenticated caller cannot use the admin API or the booking list', async () => {
      const target = await byCode('A04');
      const c = await h.gql(null, CREATE, {
        i: {
          nameTh: qaName('ไม่ล็อกอิน'),
          category: QA_CATEGORY,
          careLevel: 'BASIC',
        },
      });
      const s = await h.gql(null, SET_ACTIVE, { id: target.id, a: false });
      const l = await h.gql(null, ADMIN_LIST, {});
      const pub = await h.gql(null, LIST);
      for (const body of [c, s, l, pub])
        expect(codeOf(body)).toBe('UNAUTHENTICATED');
      expect(await byCode('A04')).toMatchObject({ isActive: true });
    });

    it('PYG-568_35 (E5) Verify that with no active activity the list is empty and a typed-task booking still works', async () => {
      const active = await h.prisma.careActivity.findMany({
        where: { isActive: true },
        select: { id: true },
      });
      await h.prisma.careActivity.updateMany({
        where: { id: { in: active.map((a) => a.id) } },
        data: { isActive: false },
      });
      try {
        expect(await activeList()).toEqual([]);
        const res = await book({ tasks: ['งานพิมพ์เองอย่างเดียว'] });
        expect(res.status).toBe(201);
      } finally {
        await h.prisma.careActivity.updateMany({
          where: { id: { in: active.map((a) => a.id) } },
          data: { isActive: true },
        });
      }
    });
  });
});
