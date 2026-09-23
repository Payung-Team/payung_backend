/**
 * E2E — PYG-427 / TC-BS-03,06 · Book on behalf (โมเดล "สมาชิก = patient" ของ PYG-464)
 *
 * Spec ที่ใช้เทียบ: PYG-410 (AC D1–D5) + PYG-464 (โมเดลใหม่, merged + migration deployed 11 ก.ย.)
 *   ★ ที่ไหนสองสเปกขัดกัน โค้ดที่ merge แล้วคือความจริง และความขัดคือ finding ในรายงาน
 *
 * ขับผ่าน API จริง (GraphQL + REST) — guard/resolver/service/listener ตัวจริง, Prisma จริงกับ Postgres ทิ้งได้
 * Omise / Supabase / Email ถูก mock (ดู test/support/booking-on-behalf-e2e.ts) — ไม่มีการเรียกภายนอกจริง
 *
 * ★ baseline ของ regression ถูกตรึงไว้ที่ commit 0a6f1ec (origin/dev HEAD ตอนรัน)
 *   "พฤติกรรมจองปกติวันนี้" = สิ่งที่โค้ด commit นั้นทำ ในรอบรันเดียวกัน ไม่ใช่สถานะในอดีต
 * วิธีรัน: docs/qa/pyg-427-book-on-behalf-report.md หัวข้อ "How to run"
 */
import { randomUUID } from 'crypto';
import {
  bootstrap,
  codeOf,
  describeDb,
  futureDate,
  Harness,
} from './support/booking-on-behalf-e2e';

jest.setTimeout(90_000);

export const PINNED_REGRESSION_COMMIT = '0a6f1ec';

// ─── operations ────────────────────────────────────────────────────────────
const ON_BEHALF = `mutation($input: CreateBookingOnBehalfInput!) {
  createBookingOnBehalf(input: $input) { id status careRecipientName }
}`;
const GROUP_BOOKINGS = `query($groupId: ID!) {
  groupBookings(groupId: $groupId) { id status careRecipientName bookedByUserId bookedByMe }
}`;
const ACCEPT = `mutation($id: ID!) { acceptBooking(bookingId: $id) { id status } }`;
const DECLINE = `mutation($input: DeclineBookingInput!) { declineBooking(input: $input) { id status } }`;
const PAY = `mutation($input: CreatePaymentInput!) { createPayment(input: $input) { id } }`;
const COMPLETE = `mutation($id: ID!) { completeBooking(bookingId: $id) { bookingId status } }`;

/** ลำดับสถานะของ "จองปกติวันนี้" ที่ commit ที่ตรึงไว้ (อ่านจาก caregiver-booking / payment / complete-booking service) */
const PINNED_SELF_FLOW = {
  bookingStatuses: ['pending', 'accepted', 'confirmed', 'completed'],
  paymentHistory: ['null→held', 'held→captured'],
};

let dayOffset = 20;
const nextDate = () => futureDate(dayOffset++);

describeDb('PYG-427 · book on behalf (e2e, real DB)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await bootstrap();
  });

  afterAll(async () => {
    await h?.close();
  });

  // ─── helpers ─────────────────────────────────────────────────────────────
  const baseInput = (caregiverId: string) => ({
    caregiverId,
    tasks: ['อาบน้ำ'],
    serviceLocations: ['บ้าน'],
    serviceType: 'general_care',
    timeSlot: 'morning',
    startTime: '09:00:00',
    durationHours: 2,
    locationAddress: 'PYG-427 test address',
    bookingDate: nextDate(),
  });

  const bookOnBehalf = (
    token: string,
    groupId: string,
    caregiverId: string,
    extra: Record<string, unknown>,
  ) =>
    h.gql(token, ON_BEHALF, {
      input: { groupId, ...baseInput(caregiverId), ...extra },
    });

  const bookSelf = (token: string, caregiverId: string) =>
    h.rest(token).post('/api/v1/bookings', baseInput(caregiverId));

  const bookingRow = (id: string) =>
    h.prisma.booking.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        patientId: true,
        bookedBy: true,
        caregiverId: true,
        familyGroupId: true,
        careRecipientId: true,
        memberDetails: true,
        estimatedCost: true,
        platformFee: true,
      },
    });

  const accept = (cgToken: string, id: string) =>
    h.gql(cgToken, ACCEPT, { id });

  const pay = (token: string, bookingId: string) =>
    h.gql(token, PAY, {
      input: {
        bookingId,
        paymentMethod: 'credit_card',
        omiseToken: 'tokn_test_427',
      },
    });

  const paymentHistory = async (bookingId: string) => {
    const p = await h.prisma.payment.findUnique({
      where: { bookingId },
      select: { id: true },
    });
    if (!p) return [];
    const rows = await h.prisma.paymentStatusHistory.findMany({
      where: { paymentId: p.id },
      orderBy: { createdAt: 'asc' },
      select: { fromStatus: true, toStatus: true },
    });
    return rows.map((r) => `${r.fromStatus ?? 'null'}→${r.toStatus}`);
  };

  /** ตัวนับสำหรับเคสลบ: ทุกอย่างที่ "ห้ามถูกสร้าง" */
  const sideEffects = async (groupId: string, bookerId: string) => ({
    bookings: await h.prisma.booking.count({ where: { patientId: bookerId } }),
    payments: await h.prisma.payment.count({ where: { patientId: bookerId } }),
    activity: await h.prisma.familyGroupActivity.count({
      where: { groupId, action: 'BOOKING_ON_BEHALF' },
    }),
    groupProfiles: await h.prisma.careRecipient.count({
      where: { familyGroupId: groupId },
    }),
    charges: h.omise.createCharge.mock.calls.length,
  });

  const waitFor = async <T>(fn: () => Promise<T>, ok: (v: T) => boolean) => {
    let v = await fn();
    for (let i = 0; i < 30 && !ok(v); i++) {
      await new Promise((r) => setTimeout(r, 100));
      v = await fn();
    }
    return v;
  };

  /** จองแทน N (ยังไม่มีข้อมูล) → ได้ booking id + context */
  const onBehalfScenario = async () => {
    const { groupId, members } = await h.seedGroup(2);
    const [m, n] = members;
    const cg = await h.seedCaregiver();
    const body = await bookOnBehalf(m.token, groupId, cg.caregiverId, {
      memberUserId: n.id,
      patientName: 'คุณแม่ ทดสอบ',
      memberDetails: { conditions: ['เบาหวาน'], medicines: 'metformin' },
    });
    if (body.errors) throw new Error(JSON.stringify(body.errors));
    return {
      groupId,
      m,
      n,
      cg,
      bookingId: body.data!.createBookingOnBehalf.id as string,
    };
  };

  // ═══════════════════════════════════════════════════════════════════════
  //  ชีตเดิม _01–_21 (_01 _03 _11 _14 เขียนใหม่ตามโมเดล PYG-464)
  // ═══════════════════════════════════════════════════════════════════════

  it('PYG-427_01 — member books on behalf by selecting a member (no recipient pre-added); booking linked to caregiver, group and resolved profile', async () => {
    const { groupId, members } = await h.seedGroup(2);
    const [m, n] = members;
    const cg = await h.seedCaregiver();
    expect(
      await h.prisma.careRecipient.count({ where: { familyGroupId: groupId } }),
    ).toBe(0); // ไม่มีการเพิ่มผู้รับบริการล่วงหน้า

    const body = await bookOnBehalf(m.token, groupId, cg.caregiverId, {
      memberUserId: n.id,
      patientName: 'คุณแม่ ทดสอบ',
    });
    expect(body.errors).toBeUndefined();
    const booking = await bookingRow(body.data!.createBookingOnBehalf.id);

    expect(booking).toMatchObject({
      status: 'pending',
      caregiverId: cg.caregiverId,
      familyGroupId: groupId,
    });
    expect(booking!.careRecipientId).not.toBeNull();
  });

  it('PYG-427_02 — on-behalf booking carries family_group_id of the group', async () => {
    const s = await onBehalfScenario();
    expect((await bookingRow(s.bookingId))!.familyGroupId).toBe(s.groupId);
  });

  it('PYG-427_03 — care_recipient_id points at the profile resolveGroupPatientProfile() produced, whose patientId is the member booked for', async () => {
    const s = await onBehalfScenario();
    const booking = await bookingRow(s.bookingId);
    const profiles = await h.prisma.careRecipient.findMany({
      where: { patientId: s.n.id, familyGroupId: s.groupId },
      select: { id: true, patientId: true },
    });

    expect(profiles).toHaveLength(1);
    expect(booking!.careRecipientId).toBe(profiles[0].id);
    expect(profiles[0].patientId).toBe(s.n.id); // subject = N
    expect(booking!.patientId).toBe(s.m.id); // ผู้จอง/ผู้จ่าย = M (ไม่ใช่ subject)
  });

  it('PYG-427_04 — memberDetails persisted; booker and subject distinguishable on the record', async () => {
    const s = await onBehalfScenario();
    const booking = await bookingRow(s.bookingId);
    const profile = await h.prisma.careRecipient.findUnique({
      where: { id: booking!.careRecipientId! },
      select: { patientId: true },
    });

    expect(booking!.memberDetails).toEqual({
      conditions: ['เบาหวาน'],
      medicines: 'metformin',
    });
    expect(booking!.bookedBy).toBe(s.m.id);
    expect(profile!.patientId).toBe(s.n.id);
    expect(booking!.bookedBy).not.toBe(profile!.patientId);
  });

  it('PYG-427_05 — exactly one BOOKING_ON_BEHALF activity row, actor = booker', async () => {
    const s = await onBehalfScenario();
    const rows = await h.prisma.familyGroupActivity.findMany({
      where: { groupId: s.groupId, action: 'BOOKING_ON_BEHALF' },
      select: { actorId: true, targetType: true, targetId: true },
    });
    expect(rows).toEqual([
      { actorId: s.m.id, targetType: 'BOOKING', targetId: s.bookingId },
    ]);
  });

  it('PYG-427_06 — the booker (not the subject) is charged', async () => {
    const s = await onBehalfScenario();
    expect((await accept(s.cg.token, s.bookingId)).errors).toBeUndefined();
    const chargesBefore = h.omise.createCharge.mock.calls.length;

    // subject N พยายามจ่าย → ถูกปฏิเสธ (booking.patientId = M)
    const bySubject = await pay(s.n.token, s.bookingId);
    expect(bySubject.errors).toBeDefined();
    expect(h.omise.createCharge.mock.calls.length).toBe(chargesBefore);

    const byBooker = await pay(s.m.token, s.bookingId);
    expect(byBooker.errors).toBeUndefined();
    const payment = await h.prisma.payment.findUnique({
      where: { bookingId: s.bookingId },
      select: { patientId: true, paymentStatus: true },
    });
    expect(payment).toEqual({ patientId: s.m.id, paymentStatus: 'held' });
    expect(h.omise.createCharge.mock.calls.length).toBe(chargesBefore + 1);
    expect(await h.prisma.payment.count({ where: { patientId: s.n.id } })).toBe(
      0,
    );
  });

  it('PYG-427_07 — Omise hold uses the existing self-booking path (createCharge, no card vaulting) — and is placed at booking time', async () => {
    const calls = () => ({
      createCharge: h.omise.createCharge.mock.calls.length,
      createCustomerWithCard: h.omise.createCustomerWithCard.mock.calls.length,
      captureCharge: h.omise.captureCharge.mock.calls.length,
    });
    const delta = (
      a: ReturnType<typeof calls>,
      b: ReturnType<typeof calls>,
    ) => ({
      createCharge: b.createCharge - a.createCharge,
      createCustomerWithCard:
        b.createCustomerWithCard - a.createCustomerWithCard,
      captureCharge: b.captureCharge - a.captureCharge,
    });

    const before = calls();
    const s = await onBehalfScenario();
    const atBookingTime = calls();
    await accept(s.cg.token, s.bookingId);
    expect((await pay(s.m.token, s.bookingId)).errors).toBeUndefined();
    const afterPay = calls();

    // จองปกติ ในรอบเดียวกัน (commit ที่ตรึงไว้) เพื่อเทียบเส้นทาง
    const self = await h.seedUser('self-payer');
    const cg2 = await h.seedCaregiver();
    const selfId = (await bookSelf(self.token, cg2.caregiverId)).body
      .id as string;
    await accept(cg2.token, selfId);
    const selfBeforePay = calls();
    await pay(self.token, selfId);
    const selfAfterPay = calls();

    // เส้นทางเดียวกับจองปกติเป๊ะ: authorize ด้วย createCharge 1 ครั้ง ไม่ vault บัตร ไม่ capture
    expect(delta(atBookingTime, afterPay)).toEqual({
      createCharge: 1,
      createCustomerWithCard: 0,
      captureCharge: 0,
    });
    expect(delta(atBookingTime, afterPay)).toEqual(
      delta(selfBeforePay, selfAfterPay),
    );
    expect(
      (await h.prisma.payment.findUnique({
        where: { bookingId: s.bookingId },
      }))!.paymentStatus,
    ).toBe('held');

    // ชีต: "An Omise hold is created at booking time"
    expect({
      chargesCreatedAtBookingTime: delta(before, atBookingTime).createCharge,
    }).toEqual({
      chargesCreatedAtBookingTime: 1,
    });
  });

  it(`PYG-427_08 — on-behalf hold→capture follows the pinned self-booking FSM (${PINNED_REGRESSION_COMMIT})`, async () => {
    const s = await onBehalfScenario();
    const statuses = [(await bookingRow(s.bookingId))!.status];
    await accept(s.cg.token, s.bookingId);
    statuses.push((await bookingRow(s.bookingId))!.status);
    await pay(s.m.token, s.bookingId);
    statuses.push((await bookingRow(s.bookingId))!.status);
    const complete = await h.gql(s.m.token, COMPLETE, { id: s.bookingId });
    expect(complete.errors).toBeUndefined();
    statuses.push((await bookingRow(s.bookingId))!.status);

    expect({
      bookingStatuses: statuses,
      paymentHistory: await paymentHistory(s.bookingId),
    }).toEqual(PINNED_SELF_FLOW);
  });

  it('PYG-427_09 — charge amount and fee snapshot equal the equivalent self-booking', async () => {
    const s = await onBehalfScenario();
    await accept(s.cg.token, s.bookingId);
    await pay(s.m.token, s.bookingId);

    const self = await h.seedUser('self-baseline');
    const selfRes = await bookSelf(self.token, s.cg.caregiverId); // ผู้ดูแล/ระยะเวลาเดียวกัน
    expect(selfRes.status).toBe(201);
    const selfId = selfRes.body.id as string;
    await accept(s.cg.token, selfId);
    await pay(self.token, selfId);

    const snap = async (id: string) => {
      const b = await bookingRow(id);
      const p = await h.prisma.payment.findUnique({
        where: { bookingId: id },
        select: { amount: true },
      });
      return {
        estimatedCost: Number(b!.estimatedCost),
        platformFee: b!.platformFee == null ? null : Number(b!.platformFee),
        paymentAmount: p ? Number(p.amount) : null,
      };
    };
    const onBehalf = await snap(s.bookingId);
    expect(onBehalf.paymentAmount).toBe(600); // 2 ชม. × 300
    expect(onBehalf).toEqual(await snap(selfId));
  });

  it('PYG-427_10 — failed Omise hold leaves no orphan on-behalf booking, no activity, no caregiver notification', async () => {
    const s = await onBehalfScenario();
    await accept(s.cg.token, s.bookingId);
    h.omise.createCharge.mockRejectedValueOnce(new Error('card declined'));
    const declined = await pay(s.m.token, s.bookingId);
    expect(declined.errors).toBeDefined();

    // เทียบจองปกติในรอบเดียวกัน: บัตรถูกปฏิเสธแล้ว booking ยังอยู่เหมือนกันไหม
    const self = await h.seedUser('self-declined');
    const cg2 = await h.seedCaregiver();
    const selfId = (await bookSelf(self.token, cg2.caregiverId)).body
      .id as string;
    await accept(cg2.token, selfId);
    h.omise.createCharge.mockRejectedValueOnce(new Error('card declined'));
    await pay(self.token, selfId);

    const caregiverNotified = await waitFor(
      () =>
        h.prisma.notification.count({
          where: { userId: s.cg.id, type: 'booking_new' },
        }),
      (n) => n > 0,
    );

    const observed = {
      onBehalfBookingPersisted: !!(await bookingRow(s.bookingId)),
      selfBookingPersistedAfterSameFailure: !!(await bookingRow(selfId)),
      onBehalfPaymentStatus:
        (
          await h.prisma.payment.findUnique({
            where: { bookingId: s.bookingId },
          })
        )?.paymentStatus ?? null,
      bookingOnBehalfActivity: await h.prisma.familyGroupActivity.count({
        where: { groupId: s.groupId, action: 'BOOKING_ON_BEHALF' },
      }),
      groupProfileForSubject: await h.prisma.careRecipient.count({
        where: { patientId: s.n.id, familyGroupId: s.groupId },
      }),
      caregiverNotifiedNewBooking: caregiverNotified,
    };

    // ชีต _10 (เข้มตามที่เขียน): ไม่มี booking, ไม่มี activity, ผู้ดูแลไม่ได้รับแจ้ง, ไม่มีโปรไฟล์ค้าง
    expect(observed).toEqual({
      onBehalfBookingPersisted: false,
      selfBookingPersistedAfterSameFailure:
        observed.selfBookingPersistedAfterSameFailure,
      onBehalfPaymentStatus: null,
      bookingOnBehalfActivity: 0,
      groupProfileForSubject: 0,
      caregiverNotifiedNewBooking: 0,
    });
  });

  it('PYG-427_11 — subject outside the group is rejected (non-member subject → MEMBER_NOT_FOUND; out-of-group careRecipientId → RECIPIENT_NOT_IN_GROUP)', async () => {
    const { groupId, members } = await h.seedGroup(1);
    const m = members[0];
    const outsider = await h.seedUser('outsider');
    const foreignProfile = await h.prisma.careRecipient.create({
      data: { patientId: outsider.id, name: 'โปรไฟล์นอกกลุ่ม' },
      select: { id: true },
    });
    const cg = await h.seedCaregiver();
    const before = await sideEffects(groupId, m.id);

    const viaMember = await bookOnBehalf(m.token, groupId, cg.caregiverId, {
      memberUserId: outsider.id,
      patientName: 'ไม่ควรถูกสร้าง',
    });
    const viaRecipient = await bookOnBehalf(m.token, groupId, cg.caregiverId, {
      careRecipientId: foreignProfile.id,
    });

    expect(await sideEffects(groupId, m.id)).toEqual(before);
    expect(
      await h.prisma.careRecipient.count({ where: { patientId: outsider.id } }),
    ).toBe(1);
    expect({
      memberUserIdPath: codeOf(viaMember),
      careRecipientIdPath: codeOf(viaRecipient),
    }).toEqual({
      memberUserIdPath: 'MEMBER_NOT_FOUND',
      careRecipientIdPath: 'RECIPIENT_NOT_IN_GROUP',
    });
  });

  it('PYG-427_12 — non-member cannot book on behalf for the group (NOT_A_MEMBER)', async () => {
    const { groupId, members } = await h.seedGroup(1);
    const u = await h.seedUser('non-member');
    const cg = await h.seedCaregiver();
    const before = await sideEffects(groupId, u.id);

    const body = await bookOnBehalf(u.token, groupId, cg.caregiverId, {
      memberUserId: members[0].id,
      patientName: 'ไม่ควรถูกสร้าง',
    });
    expect(body.data).toBeNull();
    expect(await sideEffects(groupId, u.id)).toEqual(before);
    expect(codeOf(body)).toBe('NOT_A_MEMBER');
  });

  it('PYG-427_13 — non-existent recipient / member / missing subject is rejected cleanly', async () => {
    const { groupId, members } = await h.seedGroup(1);
    const m = members[0];
    const cg = await h.seedCaregiver();
    const before = await sideEffects(groupId, m.id);

    const ghostRecipient = await bookOnBehalf(
      m.token,
      groupId,
      cg.caregiverId,
      {
        careRecipientId: randomUUID(),
      },
    );
    const ghostMember = await bookOnBehalf(m.token, groupId, cg.caregiverId, {
      memberUserId: randomUUID(),
      patientName: 'ไม่ควรถูกสร้าง',
    });
    const noSubject = await bookOnBehalf(m.token, groupId, cg.caregiverId, {});

    expect(await sideEffects(groupId, m.id)).toEqual(before);
    expect([
      codeOf(ghostRecipient),
      codeOf(ghostMember),
      codeOf(noSubject),
    ]).toEqual([
      'RECIPIENT_NOT_IN_GROUP',
      'MEMBER_NOT_FOUND',
      'RECIPIENT_NOT_IN_GROUP',
    ]);
  });

  it('PYG-427_14 — no cross-group booking (G1 member booking a G2 subject)', async () => {
    const g1 = await h.seedGroup(1);
    const g2 = await h.seedGroup(1);
    const m = g1.members[0];
    const n = g2.members[0];
    const g2Profile = await h.prisma.careRecipient.create({
      data: { patientId: n.id, name: 'โปรไฟล์ G2', familyGroupId: g2.groupId },
      select: { id: true },
    });
    const cg = await h.seedCaregiver();
    const b1 = await sideEffects(g1.groupId, m.id);
    const b2 = await sideEffects(g2.groupId, m.id);

    const underG1ByMember = await bookOnBehalf(
      m.token,
      g1.groupId,
      cg.caregiverId,
      {
        memberUserId: n.id,
        patientName: 'ไม่ควรถูกสร้าง',
      },
    );
    const underG2 = await bookOnBehalf(m.token, g2.groupId, cg.caregiverId, {
      memberUserId: n.id,
    });
    const underG1ByG2Profile = await bookOnBehalf(
      m.token,
      g1.groupId,
      cg.caregiverId,
      {
        careRecipientId: g2Profile.id,
      },
    );

    expect(await sideEffects(g1.groupId, m.id)).toEqual(b1);
    expect(await sideEffects(g2.groupId, m.id)).toEqual(b2);
    expect({
      g1MemberUserId: codeOf(underG1ByMember),
      g2AsNonMember: codeOf(underG2),
      g1WithG2Profile: codeOf(underG1ByG2Profile),
    }).toEqual({
      g1MemberUserId: 'MEMBER_NOT_FOUND',
      g2AsNonMember: 'NOT_A_MEMBER',
      g1WithG2Profile: 'RECIPIENT_NOT_IN_GROUP',
    });
  });

  it('PYG-427_15 — caregiver is notified of an on-behalf booking like a self-booking, naming the recipient as subject · UI half NOT COVERED (FE)', async () => {
    const s = await onBehalfScenario();
    const notif = await waitFor(
      () =>
        h.prisma.notification.findMany({
          where: { userId: s.cg.id, type: 'booking_new' },
          select: { title: true, body: true, data: true },
        }),
      (rows) => rows.length > 0,
    );

    const self = await h.seedUser('self-notify');
    const cg2 = await h.seedCaregiver();
    await bookSelf(self.token, cg2.caregiverId);
    const selfNotif = await waitFor(
      () =>
        h.prisma.notification.findMany({
          where: { userId: cg2.id, type: 'booking_new' },
          select: { title: true },
        }),
      (rows) => rows.length > 0,
    );

    expect(notif).toHaveLength(1);
    expect(notif[0].title).toBe(selfNotif[0].title); // ช่องทาง/รูปแบบเดียวกับจองปกติ
    // ชีต: "Notification reflects the recipient as the service subject"
    expect(JSON.stringify(notif[0])).toContain('คุณแม่ ทดสอบ');
  });

  it(`PYG-427_16 — caregiver response moves the on-behalf booking through the same statuses as self-booking (${PINNED_REGRESSION_COMMIT})`, async () => {
    const run = async (id: string, cgToken: string, payerToken: string) => {
      const seq = [(await bookingRow(id))!.status];
      expect((await accept(cgToken, id)).errors).toBeUndefined();
      seq.push((await bookingRow(id))!.status);
      expect((await pay(payerToken, id)).errors).toBeUndefined();
      seq.push((await bookingRow(id))!.status);
      return seq;
    };

    const s = await onBehalfScenario();
    const onBehalf = await run(s.bookingId, s.cg.token, s.m.token);

    const self = await h.seedUser('self-confirm');
    const cg2 = await h.seedCaregiver();
    const selfId = (await bookSelf(self.token, cg2.caregiverId)).body
      .id as string;
    const selfSeq = await run(selfId, cg2.token, self.token);

    expect(onBehalf).toEqual(['pending', 'accepted', 'confirmed']);
    expect(onBehalf).toEqual(selfSeq);
  });

  it('PYG-427_17 — caregiver decline releases the booker’s hold on an on-behalf booking', async () => {
    const s = await onBehalfScenario();
    await accept(s.cg.token, s.bookingId);
    expect((await pay(s.m.token, s.bookingId)).errors).toBeUndefined(); // hold อยู่ (held)
    const voidsBefore =
      h.omise.voidCharge.mock.calls.length +
      h.omise.reverseCharge.mock.calls.length;

    const decline = await h.gql(s.cg.token, DECLINE, {
      input: { bookingId: s.bookingId, reason: 'ติดธุระ' },
    });

    // เทียบ: decline ตอน pending (ยังไม่มี hold)
    const pendingOnBehalf = await onBehalfScenario();
    const pendingDecline = await h.gql(pendingOnBehalf.cg.token, DECLINE, {
      input: { bookingId: pendingOnBehalf.bookingId, reason: 'ติดธุระ' },
    });

    const observed = {
      declineOfHeldBooking: decline.errors ? decline.errors[0].message : 'OK',
      heldBookingStatus: (await bookingRow(s.bookingId))!.status,
      heldPaymentStatus: (await h.prisma.payment.findUnique({
        where: { bookingId: s.bookingId },
      }))!.paymentStatus,
      omiseVoidCalls:
        h.omise.voidCharge.mock.calls.length +
        h.omise.reverseCharge.mock.calls.length -
        voidsBefore,
      declineOfPendingBooking: pendingDecline.errors ? 'ERROR' : 'OK',
      pendingBookingStatus: (await bookingRow(pendingOnBehalf.bookingId))!
        .status,
    };

    // ชีต _17: hold ถูกปล่อย (booker ไม่ถูกเก็บเงิน) และ booking → declined ผ่าน flow decline เดิม
    expect(observed).toEqual({
      declineOfHeldBooking: 'OK',
      heldBookingStatus: 'rejected',
      heldPaymentStatus: 'voided',
      omiseVoidCalls: 1,
      declineOfPendingBooking: 'OK',
      pendingBookingStatus: 'rejected',
    });
  });

  it('PYG-427_18 — normal self-booking (REST) still succeeds with no group fields', async () => {
    const self = await h.seedUser('self');
    const cg = await h.seedCaregiver();
    const res = await bookSelf(self.token, cg.caregiverId);
    expect(res.status).toBe(201);
    expect(await bookingRow(res.body.id as string)).toMatchObject({
      status: 'pending',
      patientId: self.id,
      familyGroupId: null,
      careRecipientId: null,
      bookedBy: null,
    });
  });

  it(`PYG-427_19 — self-booking hold→capture FSM matches the pinned baseline (${PINNED_REGRESSION_COMMIT})`, async () => {
    const self = await h.seedUser('self-fsm');
    const cg = await h.seedCaregiver();
    const id = (await bookSelf(self.token, cg.caregiverId)).body.id as string;
    const statuses = [(await bookingRow(id))!.status];
    await accept(cg.token, id);
    statuses.push((await bookingRow(id))!.status);
    await pay(self.token, id);
    statuses.push((await bookingRow(id))!.status);
    expect((await h.gql(self.token, COMPLETE, { id })).errors).toBeUndefined();
    statuses.push((await bookingRow(id))!.status);

    expect({
      bookingStatuses: statuses,
      paymentHistory: await paymentHistory(id),
    }).toEqual(PINNED_SELF_FLOW);
  });

  it('PYG-427_20 — self-booking writes no BOOKING_ON_BEHALF activity', async () => {
    const self = await h.seedUser('self-activity');
    const cg = await h.seedCaregiver();
    const id = (await bookSelf(self.token, cg.caregiverId)).body.id as string;
    expect(
      await h.prisma.familyGroupActivity.count({ where: { targetId: id } }),
    ).toBe(0);
  });

  it('PYG-427_21 — memberDetails / family_group_id / care_recipient_id are null on a self-booking', async () => {
    const self = await h.seedUser('self-payload');
    const cg = await h.seedCaregiver();
    const id = (await bookSelf(self.token, cg.caregiverId)).body.id as string;
    expect(await bookingRow(id)).toMatchObject({
      memberDetails: null,
      familyGroupId: null,
      careRecipientId: null,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  เคสใหม่ตามโมเดล PYG-464 (_31 อยู่ในไฟล์ concurrency)
  // ═══════════════════════════════════════════════════════════════════════

  it('PYG-427_22 — on-behalf booking appears in groupBookings with family_group_id = G (the PYG-464 defect)', async () => {
    const s = await onBehalfScenario();
    const feed = await h.gql(s.m.token, GROUP_BOOKINGS, { groupId: s.groupId });
    expect(feed.errors).toBeUndefined();
    expect(feed.data!.groupBookings).toEqual([
      expect.objectContaining({
        id: s.bookingId,
        careRecipientName: 'คุณแม่ ทดสอบ',
        bookedByUserId: s.m.id,
        bookedByMe: true,
      }),
    ]);
    expect((await bookingRow(s.bookingId))!.familyGroupId).toBe(s.groupId);
  });

  it('PYG-427_23 — a member can book through the group for themselves', async () => {
    const { groupId, members } = await h.seedGroup(1);
    const m = members[0];
    const cg = await h.seedCaregiver();

    const body = await bookOnBehalf(m.token, groupId, cg.caregiverId, {
      memberUserId: m.id,
      patientName: 'ตัวฉันเอง',
    });
    expect(body.errors).toBeUndefined();
    const id = body.data!.createBookingOnBehalf.id as string;
    const booking = await bookingRow(id);
    const profile = await h.prisma.careRecipient.findUnique({
      where: { id: booking!.careRecipientId! },
      select: { patientId: true },
    });

    expect(booking!.familyGroupId).toBe(groupId);
    expect(profile!.patientId).toBe(m.id);
    const feed = await h.gql(m.token, GROUP_BOOKINGS, { groupId });
    expect(feed.data!.groupBookings.map((b: { id: string }) => b.id)).toContain(
      id,
    );
  });

  it('PYG-427_24 — branch ①: existing group profile is reused, not duplicated', async () => {
    const { groupId, members } = await h.seedGroup(2);
    const [m, n] = members;
    const existing = await h.prisma.careRecipient.create({
      data: {
        patientId: n.id,
        name: 'โปรไฟล์เดิมในกลุ่ม',
        familyGroupId: groupId,
      },
      select: { id: true },
    });
    const cg = await h.seedCaregiver();

    const body = await bookOnBehalf(m.token, groupId, cg.caregiverId, {
      memberUserId: n.id,
    });
    expect(body.errors).toBeUndefined();

    expect(
      (await bookingRow(body.data!.createBookingOnBehalf.id))!.careRecipientId,
    ).toBe(existing.id);
    expect(
      await h.prisma.careRecipient.count({
        where: { patientId: n.id, familyGroupId: groupId },
      }),
    ).toBe(1);
  });

  it('PYG-427_25 — branch ②: personal profile copied into the group with self_reported = true; personal profile unchanged', async () => {
    const { groupId, members } = await h.seedGroup(2);
    const [m, n] = members;
    const personal = await h.prisma.careRecipient.create({
      data: {
        patientId: n.id,
        name: 'คุณยาย ส่วนตัว',
        is_self: true,
        medical_conditions: ['ความดัน'],
        current_medications: 'amlodipine',
        allergies: 'penicillin',
      },
    });
    const cg = await h.seedCaregiver();

    const body = await bookOnBehalf(m.token, groupId, cg.caregiverId, {
      memberUserId: n.id,
    });
    expect(body.errors).toBeUndefined();

    const copy = await h.prisma.careRecipient.findFirst({
      where: { patientId: n.id, familyGroupId: groupId },
    });
    expect(copy).toMatchObject({
      name: 'คุณยาย ส่วนตัว',
      self_reported: true,
      medical_conditions: ['ความดัน'],
      current_medications: 'amlodipine',
      allergies: 'penicillin',
    });
    expect(copy!.id).not.toBe(personal.id);
    expect(
      await h.prisma.careRecipient.findUnique({ where: { id: personal.id } }),
    ).toEqual(personal);
  });

  it('PYG-427_26 — branch ③: booker-entered profile is created with self_reported = false', async () => {
    const { groupId, members } = await h.seedGroup(2);
    const [m, n] = members;
    const cg = await h.seedCaregiver();

    const body = await bookOnBehalf(m.token, groupId, cg.caregiverId, {
      memberUserId: n.id,
      patientName: 'คุณพ่อ กรอกให้',
      memberDetails: {
        conditions: ['หัวใจ'],
        medicines: 'aspirin',
        allergies: 'อาหารทะเล',
        careInstructions: 'เดินช้า',
      },
    });
    expect(body.errors).toBeUndefined();

    const profile = await h.prisma.careRecipient.findFirst({
      where: { patientId: n.id, familyGroupId: groupId },
    });
    expect(profile).toMatchObject({
      name: 'คุณพ่อ กรอกให้',
      self_reported: false,
      medical_conditions: ['หัวใจ'],
      current_medications: 'aspirin',
      allergies: 'อาหารทะเล',
      care_notes: 'เดินช้า',
    });
  });

  it('PYG-427_27 — booker-entered details without a name are rejected with PATIENT_NAME_REQUIRED', async () => {
    const { groupId, members } = await h.seedGroup(2);
    const [m, n] = members;
    const cg = await h.seedCaregiver();
    const before = await sideEffects(groupId, m.id);

    const body = await bookOnBehalf(m.token, groupId, cg.caregiverId, {
      memberUserId: n.id,
      memberDetails: { medicines: 'aspirin' },
    });

    expect(body.data).toBeNull();
    expect(await sideEffects(groupId, m.id)).toEqual(before);
    expect(
      await h.prisma.careRecipient.count({ where: { patientId: n.id } }),
    ).toBe(0);
    expect(codeOf(body)).toBe('PATIENT_NAME_REQUIRED');
  });

  it('PYG-427_28 — booking for a non-ACTIVE (removed) member is rejected with MEMBER_NOT_FOUND', async () => {
    const { groupId, members } = await h.seedGroup(2);
    const [m, n] = members;
    await h.prisma.familyGroupMember.update({
      where: { groupId_userId: { groupId, userId: n.id } },
      data: { status: 'REMOVED', removedAt: new Date() },
    });
    const cg = await h.seedCaregiver();
    const before = await sideEffects(groupId, m.id);

    const body = await bookOnBehalf(m.token, groupId, cg.caregiverId, {
      memberUserId: n.id,
      patientName: 'ไม่ควรถูกสร้าง',
    });

    expect(body.data).toBeNull();
    expect(await sideEffects(groupId, m.id)).toEqual(before);
    expect(
      await h.prisma.careRecipient.count({ where: { patientId: n.id } }),
    ).toBe(0);
    expect(codeOf(body)).toBe('MEMBER_NOT_FOUND');
  });

  it('PYG-427_29 — both booking entry points bind the group context (API half; SearchPage vs CaregiverProfilePage distinction NOT COVERED (FE))', async () => {
    // backend มีทางเข้าจองแทนทางเดียว (createBookingOnBehalf) — สองหน้า FE ส่ง payload รูปทรงเดียวกัน
    // จำลองสองรูปทรง: หน้าค้นหา (เลือกผู้ดูแลจากผลค้นหา) · หน้าโปรไฟล์ผู้ดูแล (caregiverId ของหน้านั้น)
    const { groupId, members } = await h.seedGroup(2);
    const [m, n] = members;
    const fromSearch = await h.seedCaregiver();
    const fromProfile = await h.seedCaregiver(450);

    const a = await bookOnBehalf(m.token, groupId, fromSearch.caregiverId, {
      memberUserId: n.id,
      patientName: 'คุณแม่',
    });
    const b = await bookOnBehalf(m.token, groupId, fromProfile.caregiverId, {
      memberUserId: n.id,
      notes: 'จองจากหน้าโปรไฟล์ผู้ดูแล',
    });
    expect(a.errors).toBeUndefined();
    expect(b.errors).toBeUndefined();

    const ra = await bookingRow(a.data!.createBookingOnBehalf.id);
    const rb = await bookingRow(b.data!.createBookingOnBehalf.id);
    expect([ra!.familyGroupId, rb!.familyGroupId]).toEqual([groupId, groupId]);
    expect(ra!.careRecipientId).toBe(rb!.careRecipientId); // ครั้งที่สองใช้โปรไฟล์เดิม (branch ①)
  });

  it('PYG-427_30 — every ACTIVE member sees the on-behalf booking; a non-member is denied with no data leak', async () => {
    const { groupId, members } = await h.seedGroup(3);
    const [m, n, p] = members;
    const cg = await h.seedCaregiver();
    const body = await bookOnBehalf(m.token, groupId, cg.caregiverId, {
      memberUserId: n.id,
      patientName: 'ชื่อที่ต้องไม่รั่ว',
      memberDetails: { allergies: 'ข้อมูลสุขภาพลับ' },
    });
    const id = body.data!.createBookingOnBehalf.id as string;
    const u = await h.seedUser('outsider');

    const asMember = await h.gql(p.token, GROUP_BOOKINGS, { groupId });
    const asOutsider = await h.gql(u.token, GROUP_BOOKINGS, { groupId });

    expect(
      asMember.data!.groupBookings.map((x: { id: string }) => x.id),
    ).toEqual([id]);
    expect(asMember.data!.groupBookings[0].bookedByMe).toBe(false);
    expect(asOutsider.data).toBeNull();
    expect(JSON.stringify(asOutsider)).not.toContain('ชื่อที่ต้องไม่รั่ว');
    expect(JSON.stringify(asOutsider)).not.toContain('ข้อมูลสุขภาพลับ');
    expect(JSON.stringify(asOutsider)).not.toContain(id);
    expect(codeOf(asOutsider)).toBe('NOT_A_MEMBER');
  });

  it('PYG-427_32 — memberDetails length limits agree between the two booking paths (GraphQL memberDetails vs REST patientProfile) · FE limit NOT COVERED (FE)', async () => {
    const { groupId, members } = await h.seedGroup(2);
    const [m, n] = members;
    const cg = await h.seedCaregiver();
    const probe = async (field: 'medicines' | 'allergies', len: number) => {
      const body = await bookOnBehalf(m.token, groupId, cg.caregiverId, {
        memberUserId: n.id,
        patientName: 'ขอบเขตความยาว',
        memberDetails: { [field]: 'ก'.repeat(len) },
      });
      return body.errors ? String(codeOf(body)) : 'OK';
    };

    const graphql = {
      medicines1000: await probe('medicines', 1000),
      medicines1001: await probe('medicines', 1001),
      allergies1000: await probe('allergies', 1000),
      allergies1001: await probe('allergies', 1001),
      medicines2000: await probe('medicines', 2000),
    };

    const self = await h.seedUser('self-limit');
    const restProbe = async (len: number) => {
      const res = await h.rest(self.token).post('/api/v1/bookings', {
        ...baseInput(cg.caregiverId),
        patientName: 'ขอบเขต REST',
        patientProfile: {
          medicines: 'ก'.repeat(len),
          allergies: 'ก'.repeat(len),
        },
      });
      return res.status === 201 ? 'OK' : `${res.status}`;
    };
    const rest = {
      both2000: await restProbe(2000),
      both2001: await restProbe(2001),
    };

    expect(graphql).toMatchObject({
      medicines1000: 'OK',
      allergies1000: 'OK',
      medicines1001: 'BAD_REQUEST',
      allergies1001: 'BAD_REQUEST',
    });
    expect(rest).toEqual({ both2000: 'OK', both2001: '400' });
    // เพดานต้องตรงกันระหว่างสองเส้นทางที่เขียนคอลัมน์ member_details เดียวกัน (PYG-464 follow-up)
    expect({ graphqlAt2000: graphql.medicines2000 }).toEqual({
      graphqlAt2000: rest.both2000,
    });
  });

  it('PYG-427_33 — legacy careRecipientId-only path still works', async () => {
    const { groupId, members } = await h.seedGroup(2);
    const [m, n] = members;
    const profile = await h.prisma.careRecipient.create({
      data: { patientId: n.id, name: 'โปรไฟล์ legacy', familyGroupId: groupId },
      select: { id: true },
    });
    const cg = await h.seedCaregiver();

    const body = await bookOnBehalf(m.token, groupId, cg.caregiverId, {
      careRecipientId: profile.id,
    });
    expect(body.errors).toBeUndefined();
    const id = body.data!.createBookingOnBehalf.id as string;

    expect(await bookingRow(id)).toMatchObject({
      familyGroupId: groupId,
      careRecipientId: profile.id,
      bookedBy: m.id,
    });
    expect(
      await h.prisma.familyGroupActivity.count({
        where: { groupId, action: 'BOOKING_ON_BEHALF', targetId: id },
      }),
    ).toBe(1);
  });

  it('PYG-427_34 — a failed on-behalf attempt leaves no group patient profile behind', async () => {
    // (ก) ล้มที่ hold ตามชีต — hold เกิดตอน createPayment หลังผู้ดูแลรับงาน
    const s = await onBehalfScenario();
    await accept(s.cg.token, s.bookingId);
    h.omise.createCharge.mockRejectedValueOnce(new Error('card declined'));
    expect((await pay(s.m.token, s.bookingId)).errors).toBeDefined();

    // (ข) ล้มตอนสร้าง booking หลัง resolveGroupPatientProfile() ทำงานไปแล้ว (ผู้ดูแลไม่มีอยู่จริง)
    const { groupId, members } = await h.seedGroup(2);
    const [m2, n2] = members;
    const failed = await bookOnBehalf(m2.token, groupId, randomUUID(), {
      memberUserId: n2.id,
      patientName: 'ต้องไม่ค้าง',
    });
    expect(failed.errors).toBeDefined();

    const observed = {
      holdFailure: {
        booking: (await bookingRow(s.bookingId)) ? 1 : 0,
        bookingOnBehalfActivity: await h.prisma.familyGroupActivity.count({
          where: { groupId: s.groupId, action: 'BOOKING_ON_BEHALF' },
        }),
        subjectProfilesInGroup: await h.prisma.careRecipient.count({
          where: { patientId: s.n.id, familyGroupId: s.groupId },
        }),
      },
      bookingRecordFailure: {
        bookings: await h.prisma.booking.count({ where: { patientId: m2.id } }),
        bookingOnBehalfActivity: await h.prisma.familyGroupActivity.count({
          where: { groupId, action: 'BOOKING_ON_BEHALF' },
        }),
        subjectProfilesInGroup: await h.prisma.careRecipient.count({
          where: { patientId: n2.id, familyGroupId: groupId },
        }),
      },
    };

    expect(observed).toEqual({
      holdFailure: {
        booking: 0,
        bookingOnBehalfActivity: 0,
        subjectProfilesInGroup: 0,
      },
      bookingRecordFailure: {
        bookings: 0,
        bookingOnBehalfActivity: 0,
        subjectProfilesInGroup: 0,
      },
    });
  });

  it('PYG-427_35 — a caregiver-role member who books on behalf can pay for that booking', async () => {
    // FamilyBookingResolver ตั้งใจเปิดให้ทุก role จอง (ผู้ดูแลก็มีพ่อแม่ต้องจองให้) — แต่ createPayment ติด @Roles(PATIENT)
    const { groupId, members } = await h.seedGroup(1);
    const n = members[0];
    const caregiverMember = await h.seedUser('cg-member', 2);
    await h.prisma.familyGroupMember.create({
      data: {
        groupId,
        userId: caregiverMember.id,
        role: 'MEMBER',
        status: 'ACTIVE',
      },
    });
    const cg = await h.seedCaregiver();

    const body = await bookOnBehalf(
      caregiverMember.token,
      groupId,
      cg.caregiverId,
      {
        memberUserId: n.id,
        patientName: 'พ่อของผู้ดูแล',
      },
    );
    expect(body.errors).toBeUndefined();
    const id = body.data!.createBookingOnBehalf.id as string;
    expect((await accept(cg.token, id)).errors).toBeUndefined();

    const payment = await pay(caregiverMember.token, id);
    expect(payment.errors?.[0]?.message ?? 'OK').toBe('OK');
    expect(
      (await h.prisma.payment.findUnique({ where: { bookingId: id } }))
        ?.paymentStatus,
    ).toBe('held');
  });
});
