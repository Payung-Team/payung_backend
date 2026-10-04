/**
 * PYG-527 — QA ของ PYG-490: จองด้วยเวลาเริ่ม–สิ้นสุด + ระบบที่อ่าน durationHours ต่อยังทำงาน
 *
 * ไล่หัวข้อในการ์ด PYG-527 ผ่าน API จริง (REST จองเอง / GraphQL จองแทน, รับงาน, ชำระเงิน, QR, sweeper)
 * กับ Postgres ทิ้งได้ใน Docker · ClockService ปลอมเพื่อเลื่อนเวลาไปช่วงเช็คอิน/เช็คเอาต์ได้
 * _X1 = เคสเพิ่ม: ผู้ดูแลคนเดียวถูกจองซ้อนเวลาโดยคนละผู้จอง — บั๊กที่รู้แล้ว PYG-544 (it.failing)
 *
 * รัน: PYG527_DATABASE_URL=postgresql://...@127.0.0.1:<port>/<db> npm run test:e2e -- pyg527
 */
import { NoCheckoutSweeperService } from '../src/monitoring/no-checkout-sweeper.service';
import {
  bootstrap,
  describeDb,
  futureDate,
  type Harness,
} from './support/pyg527-e2e';

const ACCEPT = `mutation($id: ID!) { acceptBooking(bookingId: $id) { id status } }`;
const PAY = `mutation($input: CreatePaymentInput!) { createPayment(input: $input) { id amount } }`;
const JOB_QR = `query($id: ID!) { jobQr(bookingId: $id) { token validFrom validUntil } }`;
const SCAN = `mutation($input: ScanJobQrInput!) { scanJobQr(input: $input) { ok result action } }`;
const MY_BOOKING = `query($id: ID!) { myBooking(id: $id) { id timeSlot startTime endTime durationHours estimatedCost } }`;
const CG_BOOKINGS = `query($input: CaregiverBookingsInput!) {
  caregiverBookings(input: $input) { data { id startTime endTime durationHours } }
}`;
const ON_BEHALF = `mutation($input: CreateBookingOnBehalfInput!) {
  createBookingOnBehalf(input: $input) { id timeSlot startTime endTime durationHours estimatedCost }
}`;

/** เวลานาฬิกาไทย → Date (UTC) */
const bkk = (date: string, hm: string) => new Date(`${date}T${hm}:00+07:00`);
const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

let dayOffset = 40;
const nextDate = () => futureDate(dayOffset++);

describeDb('PYG-527 · จองด้วยเวลาเริ่ม–สิ้นสุด (e2e, real DB)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await bootstrap();
  });

  afterEach(() => h?.clock.reset());

  afterAll(async () => {
    await h?.close();
  });

  // ─── helpers ─────────────────────────────────────────────────────────────
  const body = (caregiverId: string | undefined, date: string, extra: Record<string, unknown> = {}) => ({
    ...(caregiverId ? { caregiverId } : {}),
    tasks: ['อาบน้ำ'],
    serviceLocations: ['บ้าน'],
    serviceType: 'general_care',
    locationAddress: 'PYG-527 test address',
    bookingDate: date,
    ...extra,
  });

  const selfBook = (token: string, payload: Record<string, unknown>) =>
    h.rest(token).post('/api/v1/bookings', payload);

  const bookingCount = (patientId: string) => h.prisma.booking.count({ where: { patientId } });

  /** จอง → ผู้ดูแลรับ → ผู้จองจ่าย (ก่อนวันงาน) → confirmed */
  async function bookAcceptPay(start = '09:00', end = '11:30') {
    const patient = await h.seedUser('patient');
    const cg = await h.seedCaregiver();
    const date = nextDate();
    const res = await selfBook(patient.token, body(cg.caregiverId, date, { startTime: start, endTime: end }));
    expect(res.status).toBe(201);
    const id = res.body.id as string;

    const acc = await h.gql(cg.token, ACCEPT, { id });
    expect(acc.errors).toBeUndefined();

    h.clock.set(bkk(date, '06:00'));
    const pay = await h.gql(patient.token, PAY, {
      input: { bookingId: id, paymentMethod: 'credit_card', omiseToken: 'tokn_test_527', saveCard: false },
    });
    expect(pay.errors).toBeUndefined();
    return { patient, cg, date, id, res, pay };
  }

  // ═══ ฟอร์มและ validation ═══════════════════════════════════════════════════

  it('_01 จองเอง (REST) ด้วยวัน + เวลาเริ่ม + เวลาสิ้นสุด → BE คำนวณชั่วโมง/slot/ราคาเอง', async () => {
    const patient = await h.seedUser('patient');
    const cg = await h.seedCaregiver();
    const res = await selfBook(patient.token, body(cg.caregiverId, nextDate(), { startTime: '09:00', endTime: '11:30' }));

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'pending',
      timeSlot: 'morning',
      startTime: '09:00',
      endTime: '11:30',
      durationHours: 2.5,
      estimatedCost: 750, // 300 × 2.5
    });
  });

  it('_02 จองแทน (GraphQL) ด้วยเวลาเริ่ม–สิ้นสุด → ผลเดียวกับจองเอง', async () => {
    const { groupId, owner, members } = await h.seedGroup(1);
    const cg = await h.seedCaregiver();
    const res = await h.gql(owner.token, ON_BEHALF, {
      input: {
        groupId,
        memberUserId: members[0].id,
        ...body(cg.caregiverId, nextDate(), { startTime: '13:00', endTime: '16:30' }),
      },
    });

    expect(res.errors).toBeUndefined();
    expect(res.data!.createBookingOnBehalf).toMatchObject({
      timeSlot: 'afternoon',
      startTime: '13:00',
      endTime: '16:30',
      durationHours: 3.5,
      estimatedCost: 1050,
    });
  });

  const INVALID: Array<[string, string, string, RegExp]> = [
    ['endTime = startTime', '10:00', '10:00', /เวลาสิ้นสุดต้องหลังเวลาเริ่ม/],
    ['endTime < startTime', '11:00', '10:00', /เวลาสิ้นสุดต้องหลังเวลาเริ่ม/],
    ['สั้นกว่าขั้นต่ำ (30 นาที)', '09:00', '09:30', /อย่างน้อย 1 ชั่วโมง/],
    ['ยาวกว่าสูงสุด (12.5 ชม.)', '06:00', '18:30', /สูงสุด 12 ชั่วโมง/],
    ['ข้ามเที่ยงคืน (21:30–00:30)', '21:30', '00:30', /อยู่ในวันเดียวกัน/],
    ['เวลาไม่ลง 30 นาที (09:15)', '09:15', '11:00', /:00 หรือ :30/],
    ['"25:99"', '25:99', '27:00', /รูปแบบเวลาเริ่มไม่ถูกต้อง/],
    ['endTime "25:99"', '09:00', '25:99', /รูปแบบเวลาสิ้นสุดไม่ถูกต้อง/],
    ['เริ่มก่อน 06:00', '05:00', '07:00', /06:00 ถึง 21:30/],
    ['เริ่มหลัง 21:30', '22:00', '23:30', /06:00 ถึง 21:30/],
  ];

  it.each(INVALID)('_03 REST: %s → 400 ข้อความอ่านเข้าใจ ไม่สร้างใบจอง', async (_l, start, end, msg) => {
    const patient = await h.seedUser('patient');
    const cg = await h.seedCaregiver();
    const res = await selfBook(patient.token, body(cg.caregiverId, nextDate(), { startTime: start, endTime: end }));

    expect(res.status).toBe(400);
    expect(String(res.body.message)).toMatch(msg);
    expect(await bookingCount(patient.id)).toBe(0);
  });

  it.each(INVALID)('_03 GraphQL จองแทน: %s → ถูกปฏิเสธ ข้อความเดียวกัน ไม่สร้างใบจอง', async (_l, start, end, msg) => {
    const { groupId, owner, members } = await h.seedGroup(1);
    const cg = await h.seedCaregiver();
    const res = await h.gql(owner.token, ON_BEHALF, {
      input: {
        groupId,
        memberUserId: members[0].id,
        ...body(cg.caregiverId, nextDate(), { startTime: start, endTime: end }),
      },
    });

    expect(res.data).toBeNull();
    expect(res.errors?.[0]?.message).toMatch(msg);
    expect(await h.prisma.booking.count({ where: { familyGroupId: groupId } })).toBe(0);
  });

  it('_04 ชั่วโมงและราคาที่เห็นก่อนยืนยัน = ยอดที่เรียกเก็บจริงตอนชำระเงิน', async () => {
    h.omise.createCharge.mockClear();
    const { res, pay, id } = await bookAcceptPay('09:00', '11:30');

    expect(res.body).toMatchObject({ durationHours: 2.5, estimatedCost: 750 });
    expect(h.omise.createCharge).toHaveBeenCalledTimes(1);
    expect(h.omise.createCharge.mock.calls[0][0]).toBe(75000); // สตางค์
    expect(pay.data!.createPayment.amount).toBe(750);
    const row = await h.prisma.payment.findUniqueOrThrow({ where: { bookingId: id }, select: { amount: true } });
    expect(Number(row.amount)).toBe(750);
  });

  // ═══ ผู้ดูแลว่าง / เวลาชน ══════════════════════════════════════════════════

  async function caregiverWithSlots(date: string, slots: Array<'morning' | 'afternoon' | 'evening'>) {
    const cg = await h.seedCaregiver();
    await h.prisma.caregiverAvailability.updateMany({
      where: { caregiverId: cg.caregiverId, dayOfWeek: weekdayOf(date), timeSlot: { notIn: slots } },
      data: { isActive: false },
    });
    return cg;
  }

  it('_05 จองช่วงที่ผู้ดูแลไม่เปิดรับ → 409 · คร่อม 2 slot ที่ว่างทั้งคู่ → ได้ · คร่อมแต่ว่างแค่ slot เดียว → ไม่ได้', async () => {
    const patient = await h.seedUser('patient');
    const date = nextDate();

    const morningOnly = await caregiverWithSlots(date, ['morning']);
    const closed = await selfBook(patient.token, body(morningOnly.caregiverId, date, { startTime: '13:00', endTime: '15:00' }));
    expect(closed.status).toBe(409);
    expect(String(closed.body.message)).toMatch(/ไม่ได้เปิดรับงานในช่วงเวลานี้/);

    const spanHalf = await selfBook(patient.token, body(morningOnly.caregiverId, date, { startTime: '11:00', endTime: '14:00' }));
    expect(spanHalf.status).toBe(409);

    const both = await caregiverWithSlots(date, ['morning', 'afternoon']);
    const span = await selfBook(patient.token, body(both.caregiverId, date, { startTime: '11:00', endTime: '14:00' }));
    expect(span.status).toBe(201);
    expect(await bookingCount(patient.id)).toBe(1);
  });

  it.each(['pending', 'accepted', 'confirmed'])(
    '_06 ซ้อนกับใบเดิมของผู้จองคนเดียวกันที่ %s → 409 · ต่อกันพอดี (จบ = เริ่ม) → ได้',
    async (status) => {
      const patient = await h.seedUser('patient');
      const cg = await h.seedCaregiver();
      const date = nextDate();
      const first = await selfBook(patient.token, body(cg.caregiverId, date, { startTime: '09:00', endTime: '11:00' }));
      expect(first.status).toBe(201);
      await h.prisma.booking.update({ where: { id: first.body.id }, data: { status } });

      const overlap = await selfBook(patient.token, body(cg.caregiverId, date, { startTime: '10:30', endTime: '12:00' }));
      expect(overlap.status).toBe(409);

      const touching = await selfBook(patient.token, body(cg.caregiverId, date, { startTime: '11:00', endTime: '12:00' }));
      expect(touching.status).toBe(201);
    },
  );

  // ★ บั๊กที่รู้แล้ว — ติดตามที่ PYG-544 · it.failing = ผ่านเมื่อยังพังอยู่
  //   แก้ PYG-544 เสร็จแล้วชุดนี้จะ "ล้ม" เพื่อเตือนให้เปลี่ยนกลับเป็น it(...)
  it.failing('_X1 [PYG-544] ผู้ดูแลคนเดียว ถูกจองซ้อนเวลาโดยผู้จอง 2 คน (ใบแรก accepted) → ใบที่สองต้องไม่ได้', async () => {
    const cg = await h.seedCaregiver();
    const date = nextDate();
    const p1 = await h.seedUser('patient');
    const p2 = await h.seedUser('patient');

    const first = await selfBook(p1.token, body(cg.caregiverId, date, { startTime: '09:00', endTime: '12:00' }));
    expect(first.status).toBe(201);
    expect((await h.gql(cg.token, ACCEPT, { id: first.body.id })).errors).toBeUndefined();

    const second = await selfBook(p2.token, body(cg.caregiverId, date, { startTime: '10:00', endTime: '11:00' }));
    // ถ้าสร้างได้ ดูต่อว่าผู้ดูแลกด "รับ" ใบที่สองได้ด้วยไหม (= มีงานซ้อนกัน 2 งานที่ต้องไปพร้อมกัน)
    const acceptSecond =
      second.status === 201 ? await h.gql(cg.token, ACCEPT, { id: second.body.id }) : null;
    expect({
      createSecond: second.status,
      acceptSecond: acceptSecond ? (acceptSecond.errors ? 'rejected' : acceptSecond.data!.acceptBooking.status) : 'n/a',
    }).toEqual({ createSecond: 409, acceptSecond: 'n/a' });
  });

  // ═══ ระบบที่อ่าน durationHours ต่อ ═════════════════════════════════════════

  it('_07 ตารางงานผู้ดูแล + QR: ช่วงใช้ได้ = เริ่ม−60 นาที ถึง จบ+120 นาที · เช็คอิน/เช็คเอาต์ตามเวลาจบที่คำนวณ', async () => {
    const { patient, cg, date, id } = await bookAcceptPay('09:00', '11:30');

    const list = await h.gql(cg.token, CG_BOOKINGS, { input: { status: 'CONFIRMED' } });
    expect(list.errors).toBeUndefined();
    const mine = (list.data!.caregiverBookings.data as Array<Record<string, unknown>>).find((b) => b.id === id);
    expect(mine).toMatchObject({ startTime: '09:00', endTime: '11:30', durationHours: 2.5 });

    const qr = await h.gql(patient.token, JOB_QR, { id });
    expect(qr.errors).toBeUndefined();
    const { token, validFrom, validUntil } = qr.data!.jobQr;
    expect(new Date(validFrom).toISOString()).toBe(bkk(date, '08:00').toISOString());
    expect(new Date(validUntil).toISOString()).toBe(bkk(date, '13:30').toISOString());

    h.clock.set(bkk(date, '07:59'));
    expect((await h.gql(cg.token, SCAN, { input: { token } })).data!.scanJobQr).toMatchObject({
      ok: false,
      result: 'OUT_OF_WINDOW',
    });

    h.clock.set(bkk(date, '08:55'));
    const inRes = await h.gql(cg.token, SCAN, { input: { token } });
    expect(inRes.data!.scanJobQr).toMatchObject({ ok: true, action: 'CHECK_IN' });

    // PYG-437: เช็คอินแล้ว token เปลี่ยนเป็นของ CHECK_OUT — หน้าจอผู้รับบริการดึง QR ใบใหม่
    h.clock.set(bkk(date, '13:29'));
    const outToken = (await h.gql(patient.token, JOB_QR, { id })).data!.jobQr.token;
    const outRes = await h.gql(cg.token, SCAN, { input: { token: outToken } });
    expect(outRes.data!.scanJobQr).toMatchObject({ ok: true, action: 'CHECK_OUT' });
  });

  it('_07b เลยเวลาจบ + 120 นาทีแล้วค่อยสแกนจบงาน → OUT_OF_WINDOW', async () => {
    const { patient, cg, date, id } = await bookAcceptPay('09:00', '11:30');
    const { token } = (await h.gql(patient.token, JOB_QR, { id })).data!.jobQr;

    h.clock.set(bkk(date, '09:00'));
    expect((await h.gql(cg.token, SCAN, { input: { token } })).data!.scanJobQr.ok).toBe(true);

    h.clock.set(bkk(date, '13:31'));
    const outToken = (await h.gql(patient.token, JOB_QR, { id })).data!.jobQr.token;
    expect((await h.gql(cg.token, SCAN, { input: { token: outToken } })).data!.scanJobQr).toMatchObject({
      ok: false,
      result: 'OUT_OF_WINDOW',
      action: 'CHECK_OUT',
    });
  });

  it('_08 no-checkout sweeper ปิดงานที่ เวลาจบ (คำนวณจาก start/end) + 6 ชม. — ก่อนนั้นไม่แตะ', async () => {
    const { patient, cg, date, id } = await bookAcceptPay('09:00', '11:30');
    const { token } = (await h.gql(patient.token, JOB_QR, { id })).data!.jobQr;
    h.clock.set(bkk(date, '09:00'));
    expect((await h.gql(cg.token, SCAN, { input: { token } })).data!.scanJobQr.ok).toBe(true);
    const sweeper = h.app.get(NoCheckoutSweeperService);

    h.clock.set(bkk(date, '17:29')); // 11:30 + 6 ชม. = 17:30
    await sweeper.run();
    expect((await h.prisma.booking.findUniqueOrThrow({ where: { id } })).status).toBe('in_progress');

    h.clock.set(bkk(date, '17:31'));
    await sweeper.run();
    const after = await h.prisma.booking.findUniqueOrThrow({
      where: { id },
      select: { status: true, reviewReasons: true },
    });
    expect(after.status).toBe('completed');
    expect(after.reviewReasons).toContain('no_checkout');
    expect(
      await h.prisma.jobEvent.count({ where: { bookingId: id, eventType: 'check_out' } }),
    ).toBe(1);
  });

  // ═══ ข้อมูลเดิม ════════════════════════════════════════════════════════════

  it.each([
    ['evening 18:00 × 4 ชม.', 'evening', '18:00:00', 4, '18:00', '22:00'],
    ['night 23:00 × 2 ชม. (ข้ามเที่ยงคืน, slot ที่ไม่มีแล้ว)', 'night', '23:00:00', 2, '23:00', '01:00'],
    ['เริ่มไม่ลง :00/:30 (08:45 × 1.5)', 'morning', '08:45:00', 1.5, '08:45', '10:15'],
  ])('_09 ใบจองเก่า (%s) เปิดอ่านได้ และแสดงเวลาเริ่ม–สิ้นสุดถูก', async (_l, slot, start, hours, s, e) => {
    const patient = await h.seedUser('patient');
    const row = await h.prisma.booking.create({
      data: {
        patientId: patient.id,
        tasks: ['อาบน้ำ'],
        serviceLocations: ['บ้าน'],
        serviceType: 'general_care',
        timeSlot: slot as never,
        startTime: new Date(`1970-01-01T${start}Z`),
        durationHours: hours,
        locationAddress: 'legacy',
        bookingDate: new Date(nextDate()),
        status: 'completed',
      },
      select: { id: true },
    });

    const res = await h.gql(patient.token, MY_BOOKING, { id: row.id });
    expect(res.errors).toBeUndefined();
    expect(res.data!.myBooking).toMatchObject({ timeSlot: slot, startTime: s, endTime: e, durationHours: hours });
  });

  it('_10 FE เก่า (ส่ง timeSlot + durationHours ไม่ส่ง endTime) ยังจองได้ ทั้ง REST และ GraphQL', async () => {
    const patient = await h.seedUser('patient');
    const cg = await h.seedCaregiver();
    const rest = await selfBook(
      patient.token,
      body(cg.caregiverId, nextDate(), { timeSlot: 'morning', startTime: '09:00:00', durationHours: 2 }),
    );
    expect(rest.status).toBe(201);
    expect(rest.body).toMatchObject({ timeSlot: 'morning', startTime: '09:00', endTime: '11:00', durationHours: 2, estimatedCost: 600 });

    const { groupId, owner, members } = await h.seedGroup(1);
    const gql = await h.gql(owner.token, ON_BEHALF, {
      input: {
        groupId,
        memberUserId: members[0].id,
        ...body(cg.caregiverId, nextDate(), { timeSlot: 'afternoon', startTime: '13:00:00', durationHours: 3 }),
      },
    });
    expect(gql.errors).toBeUndefined();
    expect(gql.data!.createBookingOnBehalf).toMatchObject({ startTime: '13:00', endTime: '16:00', durationHours: 3, estimatedCost: 900 });

    // ไม่ส่งทั้ง endTime และ timeSlot/durationHours → ขอให้ใส่เวลาสิ้นสุด
    const none = await selfBook(patient.token, body(cg.caregiverId, nextDate(), { startTime: '09:00' }));
    expect(none.status).toBe(400);
    expect(String(none.body.message)).toMatch(/กรุณาระบุเวลาสิ้นสุด/);
  });
});
