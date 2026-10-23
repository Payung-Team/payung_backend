/**
 * PYG-630 · QA ของ S14 (PYG-567) — ชุดบริการที่แนะนำตามกลุ่มผู้สูงอายุ (recommendedServicePackages)
 *
 * ยิง GraphQL / REST เข้าแอปจริง (harness: test/support/qa-e2e.ts) ต่อ Postgres ทิ้งได้ใน Docker
 * TC_NO = PYG-567_NN · รายงานผล: docs/qa/pyg-630-service-packages-report.md
 *
 * ต้นทางของ expected (ไม่อ่านจาก DB):
 *   - ตารางชุดที่อนุมัติ: PYG-627 (Sammy อนุมัติ 9 ต.ค. 2026) → APPROVED ข้างล่าง
 *   - กลุ่มตามคะแนน ADL: S09 (0–4 ติดเตียง · 5–11 ติดบ้าน · 12–20 ติดสังคม)
 * ข้อมูลชุดตั้งต้น = migration seed จริง (20261009030000) รันบน DB ทิ้งได้
 * AC4 "ผู้ gate แก้ข้อมูล" จำลองด้วยการแก้แถวตรงใน DB ทิ้งได้ (ไม่แตะ production)
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { ADL_ITEMS } from '../src/assessment/assessment.constants';
import {
  bootstrap,
  codeOf,
  DB_URL,
  describeDb,
  futureDate,
  Harness,
} from './support/qa-e2e';

type Group = 'SOCIAL' | 'HOMEBOUND' | 'BEDRIDDEN';
type Pkg = {
  id: string;
  code: string;
  nameTh: string;
  nameEn: string;
  descriptionTh: string | null;
  containsSelectedServiceType: boolean | null;
  items: { serviceType: string; nameTh: string; nameEn: string }[];
};
type Rec = { careGroup: Group | null; packages: Pkg[] };
type Seeded = Awaited<ReturnType<Harness['seedUser']>>;

/** PYG-627 · ตารางชุดที่อนุมัติ (ลำดับตาม sort_order ของการจับคู่) */
const APPROVED: Record<Group, [string, string[]][]> = {
  SOCIAL: [
    ['companion_care', ['companion', 'general_care']],
    ['daily_care', ['general_care', 'medication', 'companion']],
  ],
  HOMEBOUND: [
    ['daily_care', ['general_care', 'medication', 'companion']],
    ['rehab_care', ['physiotherapy', 'general_care']],
  ],
  BEDRIDDEN: [
    ['bedridden_full', ['bedridden_care', 'medication']],
    ['rehab_care', ['physiotherapy', 'general_care']],
  ],
};
const SERVICE_TYPES = [
  'general_care',
  'bedridden_care',
  'companion',
  'medication',
  'physiotherapy',
];

const REC = `query($id: ID!, $s: String) {
  recommendedServicePackages(careRecipientId: $id, selectedServiceType: $s) {
    careGroup
    packages { id code nameTh nameEn descriptionTh containsSelectedServiceType
      items { serviceType nameTh nameEn } }
  } }`;

const shape = (r: Rec) =>
  r.packages.map((p) => [p.code, p.items.map((i) => i.serviceType)]);

/** คะแนนรายข้อที่รวมได้ total: เติมเต็มทีละข้อตามลำดับ Barthel ที่เหลือ 0 */
function adlFor(total: number): Record<string, number> {
  let left = total;
  return Object.fromEntries(
    ADL_ITEMS.map(({ code, maxScore }) => {
      const v = Math.min(maxScore, left);
      left -= v;
      return [code, v];
    }),
  );
}

/** ล้างตารางชุดแล้วรัน migration seed จริง (สภาพเดียวกับ production หลัง PYG-627) */
async function seedPackages() {
  const sql = new Client({ connectionString: DB_URL });
  await sql.connect();
  try {
    await sql.query(
      'TRUNCATE care_group_service_packages, service_package_items, service_packages CASCADE',
    );
    await sql.query(
      readFileSync(
        join(
          __dirname,
          '..',
          'prisma/migrations/20261009030000_pyg567_seed_service_packages/migration.sql',
        ),
        'utf8',
      ),
    );
  } finally {
    await sql.end();
  }
}

describeDb('PYG-630 · S14 recommended service packages (PYG-567)', () => {
  let h: Harness;
  let day = 20;

  beforeAll(async () => {
    h = await bootstrap();
    await seedPackages();
    for (const serviceType of SERVICE_TYPES) {
      await h.prisma.servicePriceCatalog.upsert({
        where: { serviceType },
        create: { serviceType, pricePerHour: 300 },
        update: { isActive: true, pricePerHour: 300 },
      });
    }
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  /** ญาติที่มีโปรไฟล์ตัวเอง + ประเมิน ADL ผ่าน API จริง */
  async function elder(total: number) {
    const patient = await h.seedUser('patient');
    const recipientId = await h.seedAssessedRecipient(patient, {
      adl: adlFor(total),
    });
    return { patient, recipientId };
  }
  type Elder = Awaited<ReturnType<typeof elder>>;

  async function rec(token: string | null, id: string, s?: string | null) {
    return h.gql(token, REC, { id, s: s ?? null });
  }
  async function recOk(e: Elder, s?: string | null): Promise<Rec> {
    const body = await rec(e.patient.token, e.recipientId, s);
    expect(body.errors).toBeUndefined();
    return (body.data as { recommendedServicePackages: Rec })
      .recommendedServicePackages;
  }

  async function book(owner: Seeded, recipientId: string, serviceType: string) {
    return h.rest(owner.token).post('/api/v1/bookings', {
      careRecipientId: recipientId,
      tasks: ['ดูแลทั่วไป'],
      serviceLocations: ['at_home'],
      serviceType,
      startTime: '09:00',
      endTime: '11:00',
      locationAddress: 'บ้านทดสอบ QA-630',
      bookingDate: futureDate(day++),
    });
  }
  async function bookOk(owner: Seeded, recipientId: string, type: string) {
    const res = await book(owner, recipientId, type);
    expect(res.status).toBe(201);
    return h.prisma.booking.findUniqueOrThrow({
      where: { id: (res.body as { id: string }).id },
      select: {
        id: true,
        serviceType: true,
        careRecipientId: true,
        estimatedCost: true,
      },
    });
  }

  // ───────────────────────────── AC1 · AC2 ─────────────────────────────
  describe('AC1 · AC2 · ชุดตามกลุ่ม (ค่าขอบ ADL)', () => {
    it('PYG-567_01 Verify that an elder with a group gets that group with named packages and labelled items', async () => {
      const r = await recOk(await elder(20));
      expect(r.careGroup).toBe('SOCIAL');
      expect(r.packages.length).toBeGreaterThan(0);
      for (const p of r.packages) {
        expect(p.nameTh).toBeTruthy();
        expect(p.nameEn).toBeTruthy();
        expect(p.descriptionTh).toBeTruthy();
        expect(p.containsSelectedServiceType).toBeNull();
        for (const i of p.items) {
          expect(i.nameTh).toBeTruthy();
          expect(i.nameEn).toBeTruthy();
        }
      }
    });

    it.each<[string, number, Group]>([
      ['PYG-567_02', 20, 'SOCIAL'],
      ['PYG-567_03', 12, 'SOCIAL'],
      ['PYG-567_04', 11, 'HOMEBOUND'],
      ['PYG-567_05', 5, 'HOMEBOUND'],
      ['PYG-567_06', 4, 'BEDRIDDEN'],
      ['PYG-567_07', 0, 'BEDRIDDEN'],
    ])(
      '%s Verify that ADL %i gets exactly the approved %s packages in order',
      async (_tc, total, group) => {
        const r = await recOk(await elder(total));
        expect(r.careGroup).toBe(group);
        expect(shape(r)).toEqual(APPROVED[group]);
      },
    );

    it('PYG-567_08 Verify that no group sees another group-only package', async () => {
      const social = shape(await recOk(await elder(20))).map(([c]) => c);
      const bed = shape(await recOk(await elder(0))).map(([c]) => c);
      expect(social).not.toContain('bedridden_full');
      expect(social).not.toContain('rehab_care');
      expect(bed).not.toContain('companion_care');
      expect(bed).not.toContain('daily_care');
    });

    it('PYG-567_09 Verify that bedridden_full has no physiotherapy (rehab is a separate package)', async () => {
      const r = await recOk(await elder(0));
      const full = r.packages.find((p) => p.code === 'bedridden_full')!;
      expect(full.items.map((i) => i.serviceType)).not.toContain(
        'physiotherapy',
      );
    });

    it('PYG-567_10 Verify that containsSelectedServiceType flags each package for the chosen service', async () => {
      const e = await elder(5);
      const r = await recOk(e, 'physiotherapy');
      expect(
        r.packages.map((p) => [p.code, p.containsSelectedServiceType]),
      ).toEqual([
        ['daily_care', false],
        ['rehab_care', true],
      ]);
    });

    it('PYG-567_11 Verify that an unknown selectedServiceType is rejected with BAD_USER_INPUT', async () => {
      const e = await elder(20);
      const body = await rec(e.patient.token, e.recipientId, 'elderly_care');
      expect(codeOf(body)).toBe('BAD_USER_INPUT');
    });
  });

  // ───────────────────────────── AC3 ─────────────────────────────
  describe('AC3 · ชุดเป็นคำแนะนำ เลือกนอกชุดได้', () => {
    it('PYG-567_12 Verify that booking without any package (service picked freely) succeeds', async () => {
      const e = await elder(20);
      const b = await bookOk(e.patient, e.recipientId, 'medication');
      expect(b.serviceType).toBe('medication');
      expect(b.careRecipientId).toBe(e.recipientId);
    });

    it('PYG-567_13 Verify that booking a service outside every package of the group succeeds', async () => {
      const e = await elder(20); // ติดสังคม: ไม่มี physiotherapy / bedridden_care ในชุด
      const r = await recOk(e);
      const inPackages = r.packages.flatMap((p) =>
        p.items.map((i) => i.serviceType),
      );
      expect(inPackages).not.toContain('bedridden_care');
      const b = await bookOk(e.patient, e.recipientId, 'bedridden_care');
      expect(b.serviceType).toBe('bedridden_care');
    });

    it('PYG-567_14 Verify that a package with one item removed can still be booked with the remaining item', async () => {
      const e = await elder(0); // bedridden_full = bedridden_care + medication → เอา medication ออก
      const b = await bookOk(e.patient, e.recipientId, 'bedridden_care');
      expect(b.serviceType).toBe('bedridden_care');
    });

    // BUG PYG-690: booking รับ serviceType ได้ค่าเดียว · FE ส่งแค่ serviceTypes[0]
    //   เลือกชุด daily_care (3 บริการ) แล้วจอง → booking เหลือบริการแรกบริการเดียว
    //   — แก้แล้วเปลี่ยน it.failing → it
    it.failing(
      'PYG-567_15 Verify that booking a whole multi-service package keeps every picked service',
      async () => {
        const e = await elder(20);
        const daily = (await recOk(e)).packages.find(
          (p) => p.code === 'daily_care',
        )!;
        const picked = daily.items.map((i) => i.serviceType);
        expect(picked).toHaveLength(3);
        // payload เดียวกับที่ FE ส่งจริง (buildBookingPayload: serviceType = serviceTypes[0])
        //   API ไม่มีช่องรับหลายบริการ — ส่ง field เพิ่มจะโดน 400 (forbidNonWhitelisted)
        const b = await bookOk(e.patient, e.recipientId, picked[0]);
        const stored = [b.serviceType]; // bookings.service_type เก็บได้ค่าเดียว
        expect(stored.sort()).toEqual([...picked].sort());
      },
    );
  });

  // ───────────────────────────── AC4 ─────────────────────────────
  describe('AC4 · แก้การจับคู่ในข้อมูล ไม่ต้อง deploy', () => {
    afterEach(seedPackages);

    const pkgId = async (code: string) =>
      (await h.prisma.servicePackage.findUniqueOrThrow({ where: { code } })).id;

    it('PYG-567_16 Verify that adding a mapping row changes the recommendation immediately', async () => {
      const e = await elder(20);
      await h.prisma.careGroupServicePackage.create({
        data: {
          careGroup: 'social',
          packageId: await pkgId('rehab_care'),
          sortOrder: 5,
        },
      });
      expect(shape(await recOk(e)).map(([c]) => c)).toEqual([
        'rehab_care',
        'companion_care',
        'daily_care',
      ]);
    });

    it('PYG-567_17 Verify that a disabled mapping is no longer recommended for that group only', async () => {
      const social = await elder(20);
      const home = await elder(8);
      await h.prisma.careGroupServicePackage.updateMany({
        where: { careGroup: 'social', packageId: await pkgId('daily_care') },
        data: { isActive: false },
      });
      expect(shape(await recOk(social)).map(([c]) => c)).toEqual([
        'companion_care',
      ]);
      expect(shape(await recOk(home)).map(([c]) => c)).toEqual([
        'daily_care',
        'rehab_care',
      ]);
    });

    it('PYG-567_18 Verify that a disabled package disappears from every group', async () => {
      const home = await elder(8);
      const bed = await elder(0);
      await h.prisma.servicePackage.update({
        where: { code: 'rehab_care' },
        data: { isActive: false },
      });
      expect(shape(await recOk(home)).map(([c]) => c)).toEqual(['daily_care']);
      expect(shape(await recOk(bed)).map(([c]) => c)).toEqual([
        'bedridden_full',
      ]);
    });

    it('PYG-567_19 Verify that changing package items changes the listed items', async () => {
      const e = await elder(0);
      await h.prisma.servicePackageItem.create({
        data: {
          packageId: await pkgId('bedridden_full'),
          serviceType: 'companion',
          sortOrder: 30,
        },
      });
      const full = (await recOk(e)).packages.find(
        (p) => p.code === 'bedridden_full',
      )!;
      expect(full.items.map((i) => i.serviceType)).toEqual([
        'bedridden_care',
        'medication',
        'companion',
      ]);
    });

    it('PYG-567_20 Verify that a group with no active mapping returns its group with an empty list (E2)', async () => {
      const e = await elder(0);
      await h.prisma.careGroupServicePackage.updateMany({
        where: { careGroup: 'bedridden' },
        data: { isActive: false },
      });
      expect(await recOk(e)).toEqual({ careGroup: 'BEDRIDDEN', packages: [] });
    });

    it('PYG-567_21 Verify that empty package tables do not break the query or booking (E8)', async () => {
      const e = await elder(20);
      await h.prisma.$executeRawUnsafe(
        'TRUNCATE care_group_service_packages, service_package_items, service_packages CASCADE',
      );
      expect(await recOk(e)).toEqual({ careGroup: 'SOCIAL', packages: [] });
      await bookOk(e.patient, e.recipientId, 'companion');
    });

    it('PYG-567_22 Verify that a package disabled after it was picked does not block the booking (E7)', async () => {
      const e = await elder(20);
      const picked = (await recOk(e)).packages[0];
      await h.prisma.servicePackage.update({
        where: { code: picked.code },
        data: { isActive: false },
      });
      const b = await bookOk(
        e.patient,
        e.recipientId,
        picked.items[0].serviceType,
      );
      expect(b.serviceType).toBe(picked.items[0].serviceType);
    });
  });

  // ───────────────────────────── AC5 · E1 · E3 ─────────────────────────────
  describe('AC5 · E1 · E3 · กลุ่มเปลี่ยน / ไม่มีผลประเมิน / หลายคน', () => {
    it('PYG-567_23 Verify that re-assessment to another group switches packages and keeps the earlier booking', async () => {
      const e = await elder(20);
      const before = await bookOk(e.patient, e.recipientId, 'companion');
      await h.submitAssessment(e.patient, e.recipientId, { adl: adlFor(3) });
      const r = await recOk(e);
      expect(r.careGroup).toBe('BEDRIDDEN');
      expect(shape(r)).toEqual(APPROVED.BEDRIDDEN);
      const after = await h.prisma.booking.findUniqueOrThrow({
        where: { id: before.id },
        select: {
          id: true,
          serviceType: true,
          careRecipientId: true,
          estimatedCost: true,
        },
      });
      expect(after).toEqual(before);
    });

    it('PYG-567_24 Verify that an elder with no assessment has no group and no packages (E1)', async () => {
      const owner = await h.seedUser('patient');
      const r = await h.prisma.careRecipient.create({
        data: { patientId: owner.id, name: owner.accountName, is_self: true },
        select: { id: true },
      });
      const body = await rec(owner.token, r.id);
      expect(body.errors).toBeUndefined();
      expect(body.data!.recommendedServicePackages).toEqual({
        careGroup: null,
        packages: [],
      });
      // จองได้ไหม: ด่าน S08 บังคับประเมินก่อนจอง → บันทึกผลจริงไว้ในรายงาน
      const res = await book(owner, r.id, 'companion');
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).toContain('ASSESSMENT_REQUIRED');
    });

    it('PYG-567_25 Verify that two elders of one account in different groups each get their own packages (E3)', async () => {
      const e = await elder(20);
      const second = await h.prisma.careRecipient.create({
        data: { patientId: e.patient.id, name: 'คุณยาย QA', is_self: false },
        select: { id: true },
      });
      await h.submitAssessment(e.patient, second.id, { adl: adlFor(2) });
      const a = await recOk(e);
      const b = await recOk({ ...e, recipientId: second.id });
      expect([a.careGroup, b.careGroup]).toEqual(['SOCIAL', 'BEDRIDDEN']);
      expect(shape(a)).toEqual(APPROVED.SOCIAL);
      expect(shape(b)).toEqual(APPROVED.BEDRIDDEN);
    });
  });

  // ───────────────────────────── สิทธิ์ ─────────────────────────────
  describe('สิทธิ์ · เรียก API ตรง', () => {
    it('PYG-567_26 Verify that user A cannot read packages of user B elder', async () => {
      const b = await elder(0);
      const a = await h.seedUser('stranger');
      const body = await rec(a.token, b.recipientId);
      expect(codeOf(body)).toBe('ASSESSMENT_ACCESS_DENIED');
      expect(body.data?.recommendedServicePackages ?? null).toBeNull();
    });

    it('PYG-567_27 Verify that an unauthenticated call is rejected', async () => {
      const e = await elder(20);
      const body = await rec(null, e.recipientId);
      expect(codeOf(body)).toBe('UNAUTHENTICATED');
      expect(body.data?.recommendedServicePackages ?? null).toBeNull();
    });

    it('PYG-567_28 Verify that a caregiver role is rejected', async () => {
      const e = await elder(20);
      const cg = await h.seedCaregiver();
      const body = await rec(cg.token, e.recipientId);
      expect(codeOf(body)).toBe('ASSESSMENT_ACCESS_DENIED');
    });

    it('PYG-567_29 Verify that an active family-group member can read, and loses access once removed from the group', async () => {
      const g = await h.seedGroup(1);
      const recipientId = await h.seedAssessedRecipient(g.owner, {
        adl: adlFor(8),
      });
      await h.prisma.careRecipient.update({
        where: { id: recipientId },
        data: { familyGroupId: g.groupId },
      });
      const ok = await rec(g.members[0].token, recipientId);
      expect(ok.errors).toBeUndefined();
      expect(
        (ok.data as { recommendedServicePackages: Rec })
          .recommendedServicePackages.careGroup,
      ).toBe('HOMEBOUND');

      await h.prisma.familyGroupMember.updateMany({
        where: { groupId: g.groupId, userId: g.members[0].id },
        data: { status: 'REMOVED' },
      });
      expect(codeOf(await rec(g.members[0].token, recipientId))).toBe(
        'ASSESSMENT_ACCESS_DENIED',
      );
    });

    it('PYG-567_30 Verify that a non-UUID or deleted elder id is rejected the same way as a foreign id', async () => {
      const e = await elder(20);
      expect(codeOf(await rec(e.patient.token, 'not-a-uuid'))).toBe(
        'ASSESSMENT_ACCESS_DENIED',
      );
      await h.prisma.careRecipient.update({
        where: { id: e.recipientId },
        data: { is_deleted: true },
      });
      expect(codeOf(await rec(e.patient.token, e.recipientId))).toBe(
        'ASSESSMENT_ACCESS_DENIED',
      );
    });
  });

  // ───────────────────────────── DB หลัง migration ─────────────────────────────
  describe('ตรวจข้อมูลหลัง migration (query ใน PYG-627)', () => {
    it('PYG-567_31 Verify that the seed gives 4 packages, 9 items and 2 mappings per group', async () => {
      const one = async (q: string) =>
        (await h.prisma.$queryRawUnsafe<Record<string, unknown>[]>(q)).map(
          (r) => Object.values(r).map(String).join(':'),
        );
      expect(await one('SELECT count(*) FROM service_packages')).toEqual(['4']);
      expect(await one('SELECT count(*) FROM service_package_items')).toEqual([
        '9',
      ]);
      expect(
        await one(
          'SELECT care_group, count(*) FROM care_group_service_packages GROUP BY care_group ORDER BY care_group',
        ),
      ).toEqual(['bedridden:2', 'homebound:2', 'social:2']);
    });

    it('PYG-567_32 Verify that re-running the seed is idempotent', async () => {
      const sql = new Client({ connectionString: DB_URL });
      await sql.connect();
      try {
        await sql.query(
          readFileSync(
            join(
              __dirname,
              '..',
              'prisma/migrations/20261009030000_pyg567_seed_service_packages/migration.sql',
            ),
            'utf8',
          ),
        );
      } finally {
        await sql.end();
      }
      expect(await h.prisma.servicePackage.count()).toBe(4);
      expect(await h.prisma.servicePackageItem.count()).toBe(9);
      expect(await h.prisma.careGroupServicePackage.count()).toBe(6);
    });
  });
});
