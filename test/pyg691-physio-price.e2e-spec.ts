/**
 * PYG-693 (การ์ดแม่ PYG-691) — ราคากายภาพบำบัด 800 ฿/ชม. ถึงทุกจุดที่แสดง/คิดเงิน · บริการอื่นคง 300
 *
 * ยิง REST / GraphQL เข้าแอปจริง (harness: test/support/qa-e2e.ts) ต่อ Postgres ทิ้งได้ใน Docker
 * TC_NO = PYG-691_NN
 *
 * ราคาตั้งต้น = seed เดิม (5 ประเภท 300.00) แล้วรัน migration จริง 20261023000000_pyg691_physiotherapy_price_800
 * expected (800 / 300) มาจากการ์ด PYG-691 ไม่อ่านจาก DB
 * จุดที่ตรวจ: จอง (estimated_cost) · search-matches · searchCaregivers · โปรไฟล์สาธารณะ · ชำระเงิน (ยอดที่ส่ง Omise)
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import request from 'supertest';
import {
  bootstrap,
  DB_URL,
  describeDb,
  futureDate,
  GqlBody,
  Harness,
  seedProductionMasterData,
  UNLOCKED_SKILLS,
} from './support/qa-e2e';

const PHYSIO = 800;
const OTHER = 300;
const SERVICE_TYPES = [
  'general_care',
  'bedridden_care',
  'physiotherapy',
  'medication',
  'companion',
];
const MIGRATION = join(
  __dirname,
  '..',
  'prisma/migrations/20261023000000_pyg691_physiotherapy_price_800/migration.sql',
);

const SEARCH = `query($p: String, $j: String) {
  searchCaregivers(input: { province: $p, jobType: $j, limit: 50 }) { data { id hourlyRate } } }`;
const ACCEPT = `mutation($id: ID!) { acceptBooking(bookingId: $id) { id } }`;
const PAY = `mutation($input: CreatePaymentInput!) { createPayment(input: $input) { id } }`;

type Seeded = Awaited<ReturnType<Harness['seedUser']>>;
type Res = { status: number; body: unknown };

const inYears = (n: number) => {
  const d = new Date();
  d.setFullYear(d.getFullYear() + n);
  return d;
};

async function runSql(sql: string) {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

describeDb('PYG-691 · physiotherapy price 800 (PYG-693)', () => {
  let h: Harness;
  let day = 30;
  const province = `QA-691-${Date.now()}`;

  /** สภาพ seed เดิม (20260928000000): 5 ประเภท 300.00 */
  const resetToSeed = async () => {
    for (const serviceType of SERVICE_TYPES) {
      await h.prisma.servicePriceCatalog.upsert({
        where: { serviceType },
        create: { serviceType, pricePerHour: OTHER },
        update: { isActive: true, pricePerHour: OTHER },
      });
    }
  };
  const applyMigration = () => runSql(readFileSync(MIGRATION, 'utf8'));

  beforeAll(async () => {
    h = await bootstrap();
    // S15/S16/S17 master data — physiotherapy ต้องมีกติการะดับ F03 ถึงจะจองได้
    await seedProductionMasterData();
    await resetToSeed();
    await applyMigration();
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  /** ผู้ดูแลในจังหวัดเฉพาะของไฟล์นี้ + ประเภทงานที่รับ */
  async function caregiver(
    jobTypes: string[],
    opts: Parameters<Harness['seedCaregiver']>[0] = {},
  ) {
    const cg = await h.seedCaregiver(opts);
    await h.prisma.caregiver.update({
      where: { id: cg.caregiverId },
      data: { serviceAreaProvince: province },
    });
    await h.prisma.caregiverJobType.createMany({
      data: jobTypes.map((jobType) => ({
        caregiverId: cg.caregiverId,
        jobType: jobType as never,
      })),
    });
    return cg;
  }
  const physioCaregiver = (jobTypes = ['physiotherapy']) =>
    caregiver(jobTypes, {
      profession: 'physiotherapist',
      careLevel: 'advanced',
      skills: [...UNLOCKED_SKILLS, 'physiotherapy'],
      license: { status: 'approved', expiresAt: inYears(1) },
    });

  async function elder() {
    const patient = await h.seedUser('patient');
    const recipientId = await h.seedAssessedRecipient(patient);
    return { patient, recipientId };
  }

  async function book(
    owner: Seeded,
    recipientId: string,
    serviceType: string,
  ): Promise<Res> {
    return h.rest(owner.token).post('/api/v1/bookings', {
      careRecipientId: recipientId,
      tasks: ['ดูแลทั่วไป'],
      serviceLocations: ['at_home'],
      serviceType,
      startTime: '09:00',
      endTime: '11:00', // 2 ชม.
      locationAddress: 'บ้านทดสอบ QA-691',
      bookingDate: futureDate(day++),
    });
  }
  async function bookOk(owner: Seeded, recipientId: string, type: string) {
    const res = await book(owner, recipientId, type);
    expect([res.status, res.status === 201 ? null : res.body]).toEqual([
      201,
      null,
    ]);
    const id = (res.body as { id: string }).id;
    const row = await h.prisma.booking.findUniqueOrThrow({
      where: { id },
      select: { estimatedCost: true, durationHours: true },
    });
    return {
      id,
      rest: res.body as Record<string, unknown>,
      cost: row.estimatedCost!.toFixed(2),
      hours: Number(row.durationHours),
    };
  }

  async function searchRates(jobType?: string) {
    const viewer = await h.seedUser('viewer');
    const body: GqlBody = await h.gql(viewer.token, SEARCH, {
      p: province,
      j: jobType ?? null,
    });
    expect(body.errors).toBeUndefined();
    const rows = (
      body.data as {
        searchCaregivers: { data: { id: string; hourlyRate: number }[] };
      }
    ).searchCaregivers.data;
    return new Map(rows.map((r) => [r.id, r.hourlyRate]));
  }

  // ───────────────────────────── ราคาใน catalog ─────────────────────────────
  it('PYG-691_01 Verify that the migration leaves physiotherapy at 800.00 and the other four at 300.00', async () => {
    const rows = await h.prisma.servicePriceCatalog.findMany({
      where: { serviceType: { in: SERVICE_TYPES } },
      orderBy: { serviceType: 'asc' },
    });
    expect(
      rows.map((r) => [r.serviceType, r.pricePerHour.toFixed(2), r.isActive]),
    ).toEqual([
      ['bedridden_care', '300.00', true],
      ['companion', '300.00', true],
      ['general_care', '300.00', true],
      ['medication', '300.00', true],
      ['physiotherapy', '800.00', true],
    ]);
  });

  // ───────────────────────────── ตอนจอง ─────────────────────────────
  describe('ตอนจอง · bookings.estimated_cost', () => {
    it('PYG-691_02 Verify that booking physiotherapy for 2 hours stores 1600.00 and shows 800/hour', async () => {
      const e = await elder();
      const b = await bookOk(e.patient, e.recipientId, 'physiotherapy');
      expect(b.hours).toBe(2);
      expect(b.cost).toBe('1600.00');
    });

    it('PYG-691_03 Verify that booking general_care for 2 hours stores 600.00', async () => {
      const e = await elder();
      const b = await bookOk(e.patient, e.recipientId, 'general_care');
      expect(b.cost).toBe('600.00');
    });

    it.each(['bedridden_care', 'medication', 'companion'])(
      'PYG-691_04 Verify that %s for 2 hours still stores 600.00',
      async (type) => {
        const e = await elder();
        expect((await bookOk(e.patient, e.recipientId, type)).cost).toBe(
          '600.00',
        );
      },
    );

    it('PYG-691_05 Verify that a booking made before the price change keeps its amount', async () => {
      const e = await elder();
      await resetToSeed(); // ราคาเดิม 300
      let before: Awaited<ReturnType<typeof bookOk>>;
      try {
        before = await bookOk(e.patient, e.recipientId, 'physiotherapy');
      } finally {
        await applyMigration(); // → 800 (คืนสภาพแม้เคสล้ม ไม่ให้ลามไปเคสอื่น)
      }
      expect(before.cost).toBe('600.00');
      const again = await h.prisma.booking.findUniqueOrThrow({
        where: { id: before.id },
        select: { estimatedCost: true },
      });
      expect(again.estimatedCost!.toFixed(2)).toBe('600.00');
      const after = await bookOk(e.patient, e.recipientId, 'physiotherapy');
      expect(after.cost).toBe('1600.00');
    });
  });

  // ───────────────────────────── search-matches ─────────────────────────────
  it('PYG-691_06 Verify that search-matches quotes 800 for physiotherapy and 300 for general_care', async () => {
    await physioCaregiver();
    await caregiver(['general_care']);
    const quote = async (serviceType: string) => {
      const e = await elder();
      const res: Res = await h
        .rest(e.patient.token)
        .post('/api/v1/bookings/search-matches', { serviceType });
      expect(res.status).toBe(200);
      const rates = new Set(
        (res.body as { hourlyRate?: number }[]).map((m) => m.hourlyRate),
      );
      expect(rates.size).toBeGreaterThan(0);
      return [...rates];
    };
    expect(await quote('physiotherapy')).toEqual([PHYSIO]);
    expect(await quote('general_care')).toEqual([OTHER]);
  });

  // ─────────────────────── หน้า Search + โปรไฟล์ (กติกาเดียวกัน) ───────────────────────
  describe('ราคาเริ่มต้น · searchCaregivers และโปรไฟล์สาธารณะ', () => {
    let mixed: string; // general_care + physiotherapy
    let physioOnly: string;

    beforeAll(async () => {
      mixed = (await physioCaregiver(['general_care', 'physiotherapy']))
        .caregiverId;
      physioOnly = (await physioCaregiver(['physiotherapy'])).caregiverId;
    });

    it('PYG-691_07 Verify that filtering jobType=physiotherapy shows 800 for both caregivers', async () => {
      const rates = await searchRates('physiotherapy');
      expect(rates.get(mixed)).toBe(PHYSIO);
      expect(rates.get(physioOnly)).toBe(PHYSIO);
    });

    it('PYG-691_08 Verify that without a filter a general_care + physiotherapy caregiver starts at 300 and a physiotherapy-only caregiver at 800', async () => {
      const rates = await searchRates();
      expect(rates.get(mixed)).toBe(OTHER);
      expect(rates.get(physioOnly)).toBe(PHYSIO);
    });

    it('PYG-691_09 Verify that the public profile shows the same starting price as the unfiltered search', async () => {
      const profile = async (id: string) => {
        const res: Res = await request(h.app.getHttpServer()).get(
          `/api/v1/caregivers/${id}/public`,
        );
        expect(res.status).toBe(200);
        return (res.body as { hourly_rate: number | null }).hourly_rate;
      };
      const rates = await searchRates();
      expect(await profile(mixed)).toBe(rates.get(mixed));
      expect(await profile(physioOnly)).toBe(rates.get(physioOnly));
      expect(await profile(physioOnly)).toBe(PHYSIO);
    });
  });

  // ───────────────────────────── ชำระเงิน ─────────────────────────────
  it('PYG-691_10 Verify that payment charges the stored 1600.00 (160000 satang) for a 2-hour physiotherapy booking', async () => {
    const e = await elder();
    const b = await bookOk(e.patient, e.recipientId, 'physiotherapy');
    const cg = await physioCaregiver();
    const sel = await h.selectCaregiver(e.patient, b.id, cg.caregiverId);
    expect(sel.errors).toBeUndefined();
    expect(
      (await h.gql(cg.token, ACCEPT, { id: b.id })).errors,
    ).toBeUndefined();

    h.omise.createCharge.mockClear();
    const paid = await h.gql(e.patient.token, PAY, {
      input: {
        bookingId: b.id,
        paymentMethod: 'credit_card',
        omiseToken: 'tokn_test_691',
      },
    });
    expect(paid.errors).toBeUndefined();
    expect(h.omise.createCharge).toHaveBeenCalledWith(160000, 'tokn_test_691');
    const payment = await h.prisma.payment.findFirstOrThrow({
      where: { bookingId: b.id },
      select: { amount: true },
    });
    expect(Number(payment.amount)).toBe(1600);
  });
});
