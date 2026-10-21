/**
 * PYG-521 — QA ของ PYG-492: จองแทนในกลุ่มครอบครัว
 *   ชื่อ-นามสกุลแก้ไม่ได้ + shortcut autofill + คนนอกกลุ่ม/คนที่ออกแล้วจองไม่ได้
 *
 * ไล่ตารางในการ์ด PYG-521 (TC _01–_07) ผ่าน API จริง (GraphQL) + Postgres ทิ้งได้ใน Docker
 * ส่วนที่เป็นหน้าจอ (ช่องเป็น read-only / ปุ่ม shortcut) อยู่ใน FE — ที่นี่ตรวจ "สัญญาของ API" ที่หน้าจอพึ่ง
 * _X1–_X3 = เคสเพิ่มจากการอ่านโค้ด (ชื่อ/ข้อมูลที่ใบจองใช้ตรงกับที่ shortcut โชว์หรือไม่)
 *
 * รัน: PYG521_DATABASE_URL=postgresql://...@127.0.0.1:<port>/<db> npm run test:e2e -- pyg521
 */
import {
  bootstrap,
  codeOf,
  describeDb,
  futureDate,
  type Harness,
} from './support/pyg521-e2e';

const RECIPIENTS = `query($groupId: ID!) {
  groupBookingRecipients(groupId: $groupId) {
    memberUserId name nameLocked nickname hasProfile
    details { addressLine conditions medicines allergies careInstructions }
  }
}`;
const ON_BEHALF = `mutation($input: CreateBookingOnBehalfInput!) {
  createBookingOnBehalf(input: $input) {
    id status patientName careRecipientName locationAddress
    patientProfile { conditions medicines allergies careInstructions }
  }
}`;
const CAREGIVER_VIEW = `query($id: ID!) { caregiverBooking(id: $id) { id careRecipientName } }`;

let dayOffset = 30;
const nextDate = () => futureDate(dayOffset++);

describeDb('PYG-521 · จองแทนในกลุ่ม: ล็อกชื่อ + shortcut autofill (e2e, real DB)', () => {
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
    startTime: '09:00',
    endTime: '11:00',
    locationAddress: 'PYG-521 ที่อยู่เดิม',
    bookingDate: nextDate(),
  });

  const book = (token: string, groupId: string, caregiverId: string, extra: Record<string, unknown>) =>
    h.gql(token, ON_BEHALF, { input: { groupId, ...baseInput(caregiverId), ...extra } });

  const recipients = async (token: string, groupId: string) => {
    const body = await h.gql(token, RECIPIENTS, { groupId });
    return { body, list: (body.data?.groupBookingRecipients ?? []) as Array<Record<string, any>> };
  };

  const counts = async (groupId: string) => ({
    bookings: await h.prisma.booking.count({ where: { familyGroupId: groupId } }),
    profiles: await h.prisma.careRecipient.count({ where: { familyGroupId: groupId } }),
  });

  /** โปรไฟล์ในกลุ่ม (สาขา ① ของ BookingService) */
  const seedGroupProfile = (patientId: string, groupId: string, name: string) =>
    h.prisma.careRecipient.create({
      data: {
        patientId,
        familyGroupId: groupId,
        name,
        nickname: 'แม่ศรี',
        self_reported: true,
        address_line: '99/1 ถ.เดิม',
        medical_conditions: ['เบาหวาน'],
        current_medications: 'metformin',
        allergies: 'penicillin',
        care_notes: 'เดินช้า',
      },
      select: { id: true },
    });

  const setStatus = (groupId: string, userId: string, status: 'LEFT' | 'REMOVED') =>
    h.prisma.familyGroupMember.updateMany({ where: { groupId, userId }, data: { status } });

  // ─── _01 ─────────────────────────────────────────────────────────────────
  it('_01 รายชื่อ = สมาชิก ACTIVE ครบรวมเจ้าของ ไม่มีคนที่ออก/ถูกเชิญออก · ชื่อจากบัญชี · nameLocked', async () => {
    const { groupId, owner, members } = await setupGroup(4);
    const [a, b, left, removed] = members;
    await setStatus(groupId, left.id, 'LEFT');
    await setStatus(groupId, removed.id, 'REMOVED');

    const { body, list } = await recipients(owner.token, groupId);

    expect(body.errors).toBeUndefined();
    expect(list.map((r) => r.memberUserId).sort()).toEqual([owner.id, a.id, b.id].sort());
    for (const r of list) {
      const who = [owner, a, b].find((u) => u.id === r.memberUserId)!;
      expect(r.name).toBe(who.accountName);
      expect(r.nameLocked).toBe(true);
    }
    // สมาชิกธรรมดาเห็นรายการเดียวกัน
    const asMember = await recipients(a.token, groupId);
    expect(asMember.list.map((r) => r.memberUserId).sort()).toEqual([owner.id, a.id, b.id].sort());
  });

  // ─── _02 / _03 ───────────────────────────────────────────────────────────
  it('_02 สมาชิกที่มีข้อมูล → hasProfile + details ครบ · _03 สมาชิกที่ยังไม่มีข้อมูล → ชื่อมา details ว่าง', async () => {
    const { groupId, owner, members } = await setupGroup(2);
    const [withData, noData] = members;
    await seedGroupProfile(withData.id, groupId, withData.accountName);

    const { list } = await recipients(owner.token, groupId);
    const a = list.find((r) => r.memberUserId === withData.id)!;
    const b = list.find((r) => r.memberUserId === noData.id)!;

    expect(a).toMatchObject({
      name: withData.accountName,
      nameLocked: true,
      nickname: 'แม่ศรี',
      hasProfile: true,
      details: {
        addressLine: '99/1 ถ.เดิม',
        conditions: ['เบาหวาน'],
        medicines: 'metformin',
        allergies: 'penicillin',
        careInstructions: 'เดินช้า',
      },
    });
    expect(b).toMatchObject({ name: noData.accountName, nameLocked: true, hasProfile: false, details: null });
  });

  // ─── _04 ─────────────────────────────────────────────────────────────────
  it('_04 แก้ที่อยู่/ข้อมูลสุขภาพแล้วจอง → ใบจองบันทึกค่าใหม่ · ชื่อยังเป็นชื่อบัญชี', async () => {
    const { groupId, owner, members, caregiver } = await setupGroup(1);
    const [m] = members;
    const profile = await seedGroupProfile(m.id, groupId, m.accountName);

    const body = await book(owner.token, groupId, caregiver.caregiverId, {
      memberUserId: m.id,
      locationAddress: '12 ถ.ใหม่ (แก้ตอนจอง)',
      memberDetails: {
        conditions: ['เบาหวาน', 'ความดัน'],
        medicines: 'metformin, amlodipine',
        allergies: 'ไม่มี',
        careInstructions: 'ต้องพยุงตอนลุก',
      },
    });

    expect(body.errors).toBeUndefined();
    const b = body.data!.createBookingOnBehalf;
    expect(b.locationAddress).toBe('12 ถ.ใหม่ (แก้ตอนจอง)');
    expect(b.patientProfile).toMatchObject({
      conditions: ['เบาหวาน', 'ความดัน'],
      medicines: 'metformin, amlodipine',
      allergies: 'ไม่มี',
      careInstructions: 'ต้องพยุงตอนลุก',
    });
    expect(b.careRecipientName).toBe(m.accountName);
    const row = await h.prisma.booking.findUniqueOrThrow({
      where: { id: b.id },
      select: { careRecipientId: true, patientName: true, locationAddress: true },
    });
    expect(row).toEqual({
      careRecipientId: profile.id,
      patientName: m.accountName,
      locationAddress: '12 ถ.ใหม่ (แก้ตอนจอง)',
    });
  });

  // ─── _05 ─────────────────────────────────────────────────────────────────
  it('_05 ยิง API ส่ง patientName ชื่ออื่น → ไม่ได้ชื่อนั้น (ถูกปฏิเสธ) · ใบจองปกติ: ใบจอง + หน้าผู้ดูแล = ชื่อบัญชี', async () => {
    const { groupId, owner, members, caregiver } = await setupGroup(1);
    const [m] = members;
    const before = await counts(groupId);

    const spoof = await book(owner.token, groupId, caregiver.caregiverId, {
      memberUserId: m.id,
      patientName: 'ชื่อปลอม ที่พิมพ์เอง',
    });
    expect(codeOf(spoof)).toBe('PATIENT_NAME_NOT_ALLOWED');
    expect(spoof.data).toBeNull();
    expect(await counts(groupId)).toEqual(before);

    const ok = await book(owner.token, groupId, caregiver.caregiverId, { memberUserId: m.id });
    expect(ok.errors).toBeUndefined();
    const id = ok.data!.createBookingOnBehalf.id as string;
    expect(ok.data!.createBookingOnBehalf).toMatchObject({
      patientName: m.accountName,
      careRecipientName: m.accountName,
    });
    const cg = await h.gql(caregiver.token, CAREGIVER_VIEW, { id });
    expect(cg.errors).toBeUndefined();
    expect(cg.data!.caregiverBooking.careRecipientName).toBe(m.accountName);
  });

  // ─── _06 ─────────────────────────────────────────────────────────────────
  it.each(['LEFT', 'REMOVED'] as const)(
    '_06 จองให้คนที่ออกจากกลุ่มแล้ว (%s) ทั้ง memberUserId และ careRecipientId → ไม่ได้ ไม่มีอะไรถูกสร้าง',
    async (status) => {
      const { groupId, owner, members, caregiver } = await setupGroup(1);
      const [gone] = members;
      const profile = await seedGroupProfile(gone.id, groupId, gone.accountName);
      await setStatus(groupId, gone.id, status);
      const before = await counts(groupId);

      const byMember = await book(owner.token, groupId, caregiver.caregiverId, { memberUserId: gone.id });
      const byProfile = await book(owner.token, groupId, caregiver.caregiverId, { careRecipientId: profile.id });
      const both = await book(owner.token, groupId, caregiver.caregiverId, {
        memberUserId: gone.id,
        careRecipientId: profile.id,
      });

      expect(codeOf(byMember)).toBe('MEMBER_NOT_FOUND');
      expect(codeOf(byProfile)).toBe('RECIPIENT_NOT_IN_GROUP');
      expect(codeOf(both)).toBe('MEMBER_NOT_FOUND');
      expect(await counts(groupId)).toEqual(before);
      // และไม่อยู่ในรายชื่อ shortcut
      const { list } = await recipients(owner.token, groupId);
      expect(list.map((r) => r.memberUserId)).not.toContain(gone.id);
    },
  );

  // ─── _07 ─────────────────────────────────────────────────────────────────
  it('_07 คนนอกกลุ่ม / คนที่ออกไปแล้ว เรียก query รายชื่อ → NOT_A_MEMBER ไม่รั่วชื่อ/ข้อมูล', async () => {
    const { groupId, members } = await setupGroup(2);
    const [stay, gone] = members;
    await seedGroupProfile(stay.id, groupId, stay.accountName);
    await setStatus(groupId, gone.id, 'LEFT');
    const outsider = await h.seedUser('outsider');

    for (const who of [outsider, gone]) {
      const res = await h.gqlRaw(who.token, RECIPIENTS, { groupId });
      const body = res.body;
      expect(codeOf(body)).toBe('NOT_A_MEMBER');
      expect(body.data).toBeNull();
      const raw = JSON.stringify(body);
      expect(raw).not.toContain(stay.accountName);
      expect(raw).not.toContain('metformin');
    }
    // ไม่ได้ล็อกอิน
    expect((await h.gqlRaw(null, RECIPIENTS, { groupId })).body.data).toBeFalsy();
  });

  // ─── _X1 — ชื่อบนใบจองต้องเท่ากับชื่อบนปุ่ม shortcut ─────────────────────
  it('_X1 สมาชิกมีโปรไฟล์ในกลุ่มที่ชื่อไม่ตรงบัญชี (เช่นข้อมูลก่อน PYG-516) → ใบจองต้องใช้ชื่อบัญชีเหมือน shortcut', async () => {
    const { groupId, owner, members, caregiver } = await setupGroup(1);
    const [m] = members;
    await seedGroupProfile(m.id, groupId, 'คุณแม่ (ชื่อที่เคยพิมพ์เอง)');

    const shortcut = (await recipients(owner.token, groupId)).list.find((r) => r.memberUserId === m.id)!;
    const body = await book(owner.token, groupId, caregiver.caregiverId, { memberUserId: m.id });
    expect(body.errors).toBeUndefined();
    const id = body.data!.createBookingOnBehalf.id as string;
    const cg = await h.gql(caregiver.token, CAREGIVER_VIEW, { id });

    expect(shortcut.name).toBe(m.accountName);
    expect({
      bookingPatientName: body.data!.createBookingOnBehalf.patientName,
      caregiverSees: cg.data?.caregiverBooking?.careRecipientName,
    }).toEqual({ bookingPatientName: m.accountName, caregiverSees: m.accountName });
  });

  // ─── _X2 — สาขา ② คัดลอก "โปรไฟล์ส่วนตัวใบไหนก็ได้" ──────────────────────
  it('_X2 สมาชิกไม่มีโปรไฟล์ในกลุ่ม มีแค่โปรไฟล์ส่วนตัวของ "คุณยาย" (is_self=false) → ใบจองต้องเป็นชื่อสมาชิก ไม่ใช่คุณยาย', async () => {
    const { groupId, owner, members, caregiver } = await setupGroup(1);
    const [m] = members;
    await h.prisma.careRecipient.create({
      data: {
        patientId: m.id,
        familyGroupId: null,
        is_self: false,
        name: 'คุณยาย ของสมาชิก',
        medical_conditions: ['อัลไซเมอร์'],
      },
    });

    const shortcut = (await recipients(owner.token, groupId)).list.find((r) => r.memberUserId === m.id)!;
    const body = await book(owner.token, groupId, caregiver.caregiverId, { memberUserId: m.id });
    expect(body.errors).toBeUndefined();
    const b = body.data!.createBookingOnBehalf;
    const groupProfile = await h.prisma.careRecipient.findFirst({
      where: { patientId: m.id, familyGroupId: groupId },
      select: { name: true, medical_conditions: true },
    });

    expect(shortcut).toMatchObject({ name: m.accountName, hasProfile: false });
    expect({
      bookingPatientName: b.patientName,
      groupProfileName: groupProfile?.name,
      groupProfileConditions: groupProfile?.medical_conditions,
    }).toEqual({
      bookingPatientName: m.accountName,
      groupProfileName: m.accountName,
      groupProfileConditions: [],
    });
  });

  // ─── _X3 — สาขา ② ไม่เช็คความยินยอมเปิดเผยข้อมูลให้กลุ่ม ─────────────────
  it('_X3 สมาชิกมีใบ is_self แต่ยังไม่ยินยอมเปิดเผยให้กลุ่ม → shortcut ไม่โชว์ข้อมูล และการจองต้องไม่คัดลอกข้อมูลสุขภาพเข้ากลุ่ม', async () => {
    const { groupId, owner, members, caregiver } = await setupGroup(2);
    const [m, other] = members;
    await h.prisma.careRecipient.create({
      data: {
        patientId: m.id,
        familyGroupId: null,
        is_self: true,
        name: m.accountName,
        medical_conditions: ['HIV'],
        current_medications: 'ยาต้านไวรัส',
      },
    });

    const shortcutBefore = (await recipients(other.token, groupId)).list.find((r) => r.memberUserId === m.id)!;
    expect(shortcutBefore).toMatchObject({ hasProfile: false, details: null });

    const body = await book(owner.token, groupId, caregiver.caregiverId, { memberUserId: m.id });
    expect(body.errors).toBeUndefined();

    // หลังจอง สมาชิกคนอื่นในกลุ่มเห็นอะไร
    const shortcutAfter = (await recipients(other.token, groupId)).list.find((r) => r.memberUserId === m.id)!;
    expect({
      hasProfileAfter: shortcutAfter.hasProfile,
      conditionsVisibleToGroup: shortcutAfter.details?.conditions ?? null,
    }).toEqual({ hasProfileAfter: false, conditionsVisibleToGroup: null });
  });

  // ─── setup ───────────────────────────────────────────────────────────────
  async function setupGroup(memberCount: number) {
    const g = await h.seedGroup(memberCount);
    const caregiver = await h.seedCaregiver();
    return { ...g, caregiver };
  }
});
