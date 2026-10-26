import type { Prisma } from '@prisma/client';

/** ใบที่หาเจอ + มาจากไหน — `self` คือใบ is_self ส่วนตัว (ยังไม่เคยแชร์เข้ากลุ่ม) */
export interface MemberCareProfile {
  id: string;
  name: string;
  source: 'group' | 'self';
}

/**
 * โปรไฟล์ผู้รับบริการที่ใช้ตอน "จองแทนสมาชิก" (เส้นทาง memberUserId) — ที่เดียวในระบบ
 *
 * ลำดับ:
 *   ① โปรไฟล์ที่แชร์อยู่ในกลุ่มนี้ และมีแบบประเมินแล้ว (ใบล่าสุด)
 *   ② ใบ is_self ของสมาชิกคนนั้น (สร้างตอน Onboarding — เจ้าตัวทำแบบประเมินไว้ที่ใบนี้)
 *   ③ ไม่มีทั้งคู่ → null
 *
 * ★ ใช้ร่วมกันสองที่ ห้ามแยกเขียนเอง:
 *   - BookingService.createBookingOnBehalf — ใบที่ booking ผูกจริง (PYG-729)
 *   - ชุดบริการที่แนะนำตอนจองแทน (S14) — ต้องแนะนำจากกลุ่มของใบเดียวกับที่จะจองจริง
 *     ถ้าสองที่หาใบคนละแบบ หน้าจองจะแนะนำชุดของกลุ่มหนึ่ง แต่ booking ไปผูกกับอีกใบ
 *
 * ★ เฉพาะใบ is_self — โปรไฟล์ส่วนตัวใบอื่นของสมาชิกคือคนที่เขาดูแล (เช่นแม่ของเขา) ไม่ใช่ตัวสมาชิก
 * ★ ไม่ตรวจสมาชิกภาพ/ความยินยอม — ผู้เรียกต้องตรวจก่อนเรียก (แต่ละที่มีกติกาของตัวเอง)
 */
export async function findMemberCareProfile(
  db: Pick<Prisma.TransactionClient, 'careRecipient'>,
  groupId: string,
  memberUserId: string,
): Promise<MemberCareProfile | null> {
  // ① โปรไฟล์ในกลุ่มที่มีแบบประเมินแล้ว
  const assessedGroupProfile = await db.careRecipient.findFirst({
    where: {
      patientId: memberUserId,
      familyGroupId: groupId,
      is_deleted: false,
      assessment: { isNot: null },
    },
    select: { id: true, name: true },
    orderBy: { updated_at: 'desc' },
  });
  if (assessedGroupProfile) return { ...assessedGroupProfile, source: 'group' };

  // ② ใบ is_self ของสมาชิก (ผู้ใช้หนึ่งคนมีใบเดียว — orderBy กันข้อมูลเก่าที่ซ้ำ)
  const selfProfile = await db.careRecipient.findFirst({
    where: {
      patientId: memberUserId,
      is_self: true,
      familyGroupId: null,
      is_deleted: false,
    },
    select: { id: true, name: true },
    orderBy: { updated_at: 'desc' },
  });
  if (selfProfile) return { ...selfProfile, source: 'self' };

  return null;
}
