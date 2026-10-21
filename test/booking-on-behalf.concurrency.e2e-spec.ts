/**
 * E2E concurrency — PYG-427_31 · จองแทนสมาชิกคนเดียวกันพร้อมกัน ห้ามได้โปรไฟล์กลุ่มซ้ำ
 *
 * resolveGroupPatientProfile() ทำ "findFirst แล้วค่อย create" นอก transaction ของ booking
 * และตาราง care_recipients ไม่มี unique constraint บน (patient_id, family_group_id)
 * → คาดว่าจะ FAIL (PYG-464 คอมเมนต์ข้อ ⚠️3) — ผลของไฟล์นี้คือหลักฐานสำหรับเปิดการ์ด
 *
 * ต้องใช้ Postgres จริง — mock พิสูจน์ race นี้ไม่ได้
 */
import {
  bootstrap,
  describeDb,
  futureDate,
  Harness,
} from './support/booking-on-behalf-e2e';

jest.setTimeout(120_000);

const ON_BEHALF = `mutation($input: CreateBookingOnBehalfInput!) {
  createBookingOnBehalf(input: $input) { id }
}`;

describeDb('PYG-427_31 · book on behalf concurrency (e2e, real DB)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await bootstrap();
  });

  afterAll(async () => {
    await h?.close();
  });

  it('PYG-427_31 — concurrent bookings for the same member do not create duplicate group profiles', async () => {
    const rounds = 5;
    const profileCounts: number[] = [];
    const bookingOutcomes: string[][] = [];
    let day = 60;

    for (let round = 0; round < rounds; round++) {
      const { groupId, members } = await h.seedGroup(3);
      const [m, p, n] = members; // M และ P จองให้ N พร้อมกัน (N ยังไม่มีข้อมูลเลย)
      const cgA = await h.seedCaregiver();
      const cgB = await h.seedCaregiver();

      const input = (caregiverId: string) => ({
        groupId,
        memberUserId: n.id,
        patientName: `คุณยาย รอบ ${round}`,
        caregiverId,
        tasks: ['อาบน้ำ'],
        serviceLocations: ['บ้าน'],
        serviceType: 'general_care',
        timeSlot: 'morning',
        startTime: '09:00:00',
        durationHours: 2,
        locationAddress: 'PYG-427 concurrency',
        bookingDate: futureDate(day++), // คนละวัน — ไม่ให้ time-conflict มาบังผลของ race
      });

      const results = await Promise.all([
        h.gql(m.token, ON_BEHALF, { input: input(cgA.caregiverId) }),
        h.gql(p.token, ON_BEHALF, { input: input(cgB.caregiverId) }),
      ]);
      bookingOutcomes.push(
        results.map((r) =>
          r.errors
            ? String(r.errors[0].extensions?.code ?? r.errors[0].message)
            : 'OK',
        ),
      );
      profileCounts.push(
        await h.prisma.careRecipient.count({
          where: { patientId: n.id, familyGroupId: groupId },
        }),
      );
    }

    // ทุกรอบต้องได้โปรไฟล์กลุ่มของ N เพียง 1 ใบ — ถ้าไม่ใช่ Jest จะพิมพ์ทุกรอบเป็นหลักฐาน
    expect({ profileCounts, bookingOutcomes }).toEqual({
      profileCounts: Array(rounds).fill(1),
      bookingOutcomes,
    });
  });
});
