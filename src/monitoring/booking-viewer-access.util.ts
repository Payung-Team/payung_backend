import { PrismaService } from '../common/prisma.service';
import { ROLE_ID } from '../common/constants/roles.constant';
import { MEMBER_STATUS } from '../family-group/family-group.constants';

/**
 * ใครอ่านข้อมูลติดตามงาน (proofOfWork / careLogs) ของ booking หนึ่งใบได้บ้าง
 *
 *   - แอดมิน → ทุกงาน
 *   - คู่กรณี → ผู้รับบริการเจ้าของงาน / ผู้ดูแลเจ้าของงาน
 *   - สมาชิก ACTIVE ของกลุ่มครอบครัวที่ booking นี้สังกัด (booking.familyGroupId)
 *     → ติดตามการดูแลได้เหมือนผู้จอง (อ่านอย่างเดียว — mutation ทุกตัวยังตรวจคู่กรณีของตัวเอง)
 *     กติกาเดียวกับ query groupBooking ที่เปิดให้สมาชิกทุกคนอ่านรายละเอียดคำจองอยู่แล้ว
 *
 * ★ ต้องกรอง status = ACTIVE เสมอ — คนที่ถูกเตะ/ออกจากกลุ่มหมดสิทธิ์ทันที (AC-BS-01 A3)
 */
export async function canViewBookingMonitoring(
  prisma: PrismaService,
  userId: string,
  role: number,
  booking: {
    patientId: string;
    familyGroupId: string | null;
    caregiver: { userId: string } | null;
  },
): Promise<boolean> {
  if (role === ROLE_ID.ADMIN) return true;
  if (booking.patientId === userId || booking.caregiver?.userId === userId) {
    return true;
  }
  if (!booking.familyGroupId) return false;

  const member = await prisma.familyGroupMember.findUnique({
    where: { groupId_userId: { groupId: booking.familyGroupId, userId } },
    select: { status: true },
  });
  return member?.status === MEMBER_STATUS.ACTIVE;
}
