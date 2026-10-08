/**
 * PYG-544 · ผู้ดูแลกดรับงานที่ซ้อนเวลากันไม่ได้ — ทดสอบกับ Postgres จริง
 *
 * unit test (caregiver-booking.service.spec.ts) ยืนยันได้แค่ "เรียกล็อกก่อนเช็ค" — พิสูจน์ไม่ได้ว่า
 * Postgres กันการกดรับพร้อมกันได้จริง ไฟล์นี้เรียก CaregiverBookingService.acceptBooking ตัวจริง
 * ผ่าน PrismaService ตัวจริง (pg Pool → แต่ละ request คนละ connection) แล้วกดรับ 2 ใบพร้อมกัน
 *
 * ★★ ต่อได้เฉพาะ Postgres ทิ้งได้บน localhost ผ่าน PYG544_DATABASE_URL เท่านั้น
 *    - host ไม่ใช่ localhost / มีคำว่า supabase → throw ทันที
 *    - ไม่ได้ตั้งค่า: เครื่อง dev → skip ทั้งไฟล์ · CI (process.env.CI) → throw
 *
 * รัน: PYG544_DATABASE_URL=postgresql://...@127.0.0.1:<port>/<db> npm run test:e2e -- pyg544
 * (DB สร้างจาก schema.prisma: prisma migrate diff --from-empty --to-schema-datamodel ... --script)
 */
import { randomUUID } from 'crypto';
import { ConflictException } from '@nestjs/common';
import { PrismaService } from '../src/common/prisma.service';
import { CaregiverBookingService } from '../src/booking/caregiver-booking.service';

const DB_URL = process.env.PYG544_DATABASE_URL;

if (DB_URL) {
  const host = new URL(DB_URL).hostname;
  if (
    !['localhost', '127.0.0.1', '::1'].includes(host) ||
    /supabase/i.test(DB_URL)
  ) {
    throw new Error(
      `PYG544_DATABASE_URL ต้องเป็น Postgres ทิ้งได้บน localhost เท่านั้น (ได้ host=${host})`,
    );
  }
} else if (process.env.CI) {
  throw new Error(
    'PYG544_DATABASE_URL ไม่ได้ตั้งค่าใน CI — ชุดทดสอบ PYG-544 ต้องรันจริง ห้าม skip',
  );
}

const describeDb = DB_URL ? describe : describe.skip;

/** จำนวนรอบของเทสกดพร้อมกัน — race ไม่เกิดทุกครั้ง รอบเดียวผ่านได้โดยบังเอิญ */
const RACE_ROUNDS = 25;

describeDb('PYG-544 · ผู้ดูแลรับงานซ้อนเวลา (e2e, real DB)', () => {
  let prisma: PrismaService;
  let service: CaregiverBookingService;
  let dayOffset = 40;

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    service = new CaregiverBookingService(
      prisma,
      { emit: jest.fn() } as never,
      { now: () => new Date() } as never,
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  // ─── helpers ─────────────────────────────────────────────────────────────
  /** วันให้บริการในอนาคต ไม่ซ้ำกันทุกเทส (ไกลพอไม่ชน deadline guard ของ PYG-461/462) */
  const nextDate = () =>
    new Date(Date.now() + dayOffset++ * 86_400_000).toISOString().slice(0, 10);

  const seedUser = async (tag: string, role: number) => {
    const uid = randomUUID();
    const user = await prisma.user.create({
      data: {
        supabaseUid: uid,
        email: `${tag}-${uid}@pyg544.test`,
        displayName: `${tag}-${uid.slice(0, 8)}`,
        role,
      },
      select: { id: true },
    });
    return user.id;
  };

  const seedCaregiver = async () => {
    const userId = await seedUser('caregiver', 2);
    const cg = await prisma.caregiver.create({
      data: {
        userId,
        fullName: 'ผู้ดูแลทดสอบ',
        kycStatus: 'verified',
        isSearchable: true,
      },
      select: { id: true },
    });
    return { userId, caregiverId: cg.id };
  };

  /** ใบจองของผู้จองคนใหม่ทุกครั้ง — เวลาเป็นนาฬิกาไทยตามคอลัมน์ TIME */
  const seedBooking = async (
    caregiverId: string,
    date: string,
    start: string,
    hours: number,
    status = 'pending',
  ) => {
    const patientId = await seedUser('patient', 1);
    const booking = await prisma.booking.create({
      data: {
        patientId,
        caregiverId,
        serviceType: 'general_care',
        timeSlot: 'morning',
        startTime: new Date(`1970-01-01T${start}:00.000Z`),
        durationHours: hours,
        locationAddress: '123 ถนนทดสอบ',
        bookingDate: new Date(`${date}T00:00:00.000Z`),
        status,
      },
      select: { id: true },
    });
    return booking.id;
  };

  const statusOf = async (id: string) =>
    (
      await prisma.booking.findUniqueOrThrow({
        where: { id },
        select: { status: true },
      })
    ).status;

  // ─── รับทีละใบ ───────────────────────────────────────────────────────────

  it.each(['accepted', 'confirmed', 'in_progress'])(
    '_01 มีงาน %s 09:00–12:00 อยู่แล้ว → กดรับใบ 10:00–11:00 ไม่ได้ (409) ใบยังเป็น pending',
    async (busyStatus) => {
      const cg = await seedCaregiver();
      const date = nextDate();
      await seedBooking(cg.caregiverId, date, '09:00', 3, busyStatus);
      const second = await seedBooking(cg.caregiverId, date, '10:00', 1);

      await expect(service.acceptBooking(cg.userId, second)).rejects.toThrow(
        'ช่วงเวลาของงานนี้ซ้อนทับกับงานที่คุณรับไว้แล้ว',
      );
      expect(await statusOf(second)).toBe('pending');
    },
  );

  it('_02 ใบที่ซ้อนกันยังเป็น pending ทั้งคู่ → รับใบแรกได้ ใบที่สองรับไม่ได้', async () => {
    const cg = await seedCaregiver();
    const date = nextDate();
    const first = await seedBooking(cg.caregiverId, date, '09:00', 3);
    const second = await seedBooking(cg.caregiverId, date, '10:00', 1);

    await expect(
      service.acceptBooking(cg.userId, first),
    ).resolves.toMatchObject({
      status: 'accepted',
    });
    await expect(
      service.acceptBooking(cg.userId, second),
    ).rejects.toBeInstanceOf(ConflictException);
    expect([await statusOf(first), await statusOf(second)]).toEqual([
      'accepted',
      'pending',
    ]);
  });

  it('_03 ต่อกันพอดี (09:00–12:00 แล้ว 12:00–14:00 และ 07:00–09:00) → รับได้ทั้งหมด', async () => {
    const cg = await seedCaregiver();
    const date = nextDate();
    await seedBooking(cg.caregiverId, date, '09:00', 3, 'accepted');
    const after = await seedBooking(cg.caregiverId, date, '12:00', 2);
    const before = await seedBooking(cg.caregiverId, date, '07:00', 2);

    await service.acceptBooking(cg.userId, after);
    await service.acceptBooking(cg.userId, before);

    expect([await statusOf(after), await statusOf(before)]).toEqual([
      'accepted',
      'accepted',
    ]);
  });

  it.each(['pending', 'rejected', 'cancelled', 'completed', 'expired'])(
    '_04 งานอื่นที่ซ้อนเวลาแต่สถานะ %s ไม่กันเวลา → รับได้',
    async (otherStatus) => {
      const cg = await seedCaregiver();
      const date = nextDate();
      await seedBooking(cg.caregiverId, date, '09:00', 3, otherStatus);
      const mine = await seedBooking(cg.caregiverId, date, '10:00', 1);

      await service.acceptBooking(cg.userId, mine);

      expect(await statusOf(mine)).toBe('accepted');
    },
  );

  it('_05 งานซ้อนเวลาของผู้ดูแลคนอื่น / ของวันอื่น ไม่เกี่ยว → รับได้', async () => {
    const cg = await seedCaregiver();
    const other = await seedCaregiver();
    const date = nextDate();
    await seedBooking(other.caregiverId, date, '09:00', 3, 'accepted');
    await seedBooking(cg.caregiverId, nextDate(), '09:00', 3, 'accepted');
    const mine = await seedBooking(cg.caregiverId, date, '10:00', 1);

    await service.acceptBooking(cg.userId, mine);

    expect(await statusOf(mine)).toBe('accepted');
  });

  // ─── กดพร้อมกัน ──────────────────────────────────────────────────────────

  it(`_06 ★ กดรับ 2 ใบที่ซ้อนกันพร้อมกัน × ${RACE_ROUNDS} รอบ → รับได้ใบเดียวทุกรอบ`, async () => {
    const cg = await seedCaregiver();
    const accepted: number[] = [];

    for (let round = 0; round < RACE_ROUNDS; round++) {
      const date = nextDate();
      const a = await seedBooking(cg.caregiverId, date, '09:00', 3);
      const b = await seedBooking(cg.caregiverId, date, '10:00', 1);

      const results = await Promise.allSettled([
        service.acceptBooking(cg.userId, a),
        service.acceptBooking(cg.userId, b),
      ]);

      const rejected = results.filter((r) => r.status === 'rejected');
      for (const r of rejected) {
        expect(r.reason).toBeInstanceOf(ConflictException);
      }
      accepted.push(
        [await statusOf(a), await statusOf(b)].filter((s) => s === 'accepted')
          .length,
      );
    }

    expect(accepted).toEqual(Array(RACE_ROUNDS).fill(1));
  });

  it('_07 กดรับ 2 ใบที่ไม่ซ้อนกันพร้อมกัน → รับได้ทั้งคู่ (ล็อกแค่ต่อคิว ไม่ได้ทำให้ล้ม)', async () => {
    const cg = await seedCaregiver();
    const date = nextDate();
    const a = await seedBooking(cg.caregiverId, date, '09:00', 3);
    const b = await seedBooking(cg.caregiverId, date, '13:00', 2);

    await Promise.all([
      service.acceptBooking(cg.userId, a),
      service.acceptBooking(cg.userId, b),
    ]);

    expect([await statusOf(a), await statusOf(b)]).toEqual([
      'accepted',
      'accepted',
    ]);
  });
});
