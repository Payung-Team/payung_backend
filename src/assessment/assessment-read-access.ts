import type { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import type { ConsentService } from '../consent/consent.service';
import { CONSENT_TYPE } from '../consent/consent.constants';
import { assessmentAccessDenied } from './assessment.errors';
import { findMemberCareProfile } from '../booking/member-care-profile';

/** Shared S08/S09 read policy; extracting it does not grant new role access. */
export async function assertAssessmentReadAccess(
  db: Pick<Prisma.TransactionClient, 'careRecipient' | 'familyGroupMember'>,
  consent: Pick<ConsentService, 'findWithdrawnType'>,
  actorId: string,
  careRecipientId: string,
): Promise<void> {
  if (!isUUID(careRecipientId)) throw assessmentAccessDenied();
  const recipient = await db.careRecipient.findUnique({
    where: { id: careRecipientId },
    select: { patientId: true, is_deleted: true, familyGroupId: true },
  });
  if (!recipient || recipient.is_deleted) throw assessmentAccessDenied();
  if (recipient.patientId === actorId) return;
  if (!recipient.familyGroupId) throw assessmentAccessDenied();
  const members = await db.familyGroupMember.findMany({
    where: {
      groupId: recipient.familyGroupId,
      userId: { in: [actorId, recipient.patientId] },
      status: 'ACTIVE',
    },
    select: { userId: true },
  });
  if (new Set(members.map((member) => member.userId)).size !== 2)
    throw assessmentAccessDenied();
  if (
    await consent.findWithdrawnType(recipient.patientId, [
      CONSENT_TYPE.DISCLOSE_TO_FAMILY_GROUP,
    ])
  )
    throw assessmentAccessDenied();
}

/**
 * ชุดบริการที่แนะนำตอน "จองแทนสมาชิก" (S14) — หาใบที่ใช้อ่านกลุ่มดูแลของสมาชิก
 *
 * ★ ทำไมต้องมีทางนี้: FE รู้แค่ memberUserId (groupBookingRecipients ไม่คืน id โปรไฟล์)
 *   และแบบประเมินของสมาชิกส่วนใหญ่อยู่ที่ใบ is_self ส่วนตัว (familyGroupId = null)
 *   ซึ่ง assertAssessmentReadAccess ไม่ให้สมาชิกคนอื่นอ่าน → จองแทนจึงไม่เคยมีชุดแนะนำเลย
 *
 * ใบที่ใช้ = ใบเดียวกับที่ booking จะผูกจริง (findMemberCareProfile) · ไม่มีใบ → null
 *
 * กติกา (ไม่ได้เปิดสิทธิ์อ่านแบบประเมินเพิ่ม — ทางนี้คืนแค่กลุ่มดูแลผ่านชุดบริการ):
 *   - ผู้เรียกและสมาชิกต้อง ACTIVE ในกลุ่มนี้ทั้งคู่
 *   - สมาชิกถอน disclose_to_family_group → ปฏิเสธ (เหมือน assertAssessmentReadAccess)
 *   - ใบ is_self ยังไม่เคยแชร์เข้ากลุ่ม → ต้อง "ยินยอม" ชัดแจ้งเวอร์ชันปัจจุบัน
 *     เกณฑ์เดียวกับที่ groupBookingRecipients ใช้เปิดข้อมูลใบนี้ให้กลุ่มเห็น (PDPA ม.26)
 *   - ดูของตัวเองผ่านทางนี้ได้เสมอ
 * ทุกกรณีที่ไม่ผ่านตอบ ASSESSMENT_ACCESS_DENIED ตัวเดียวกัน — ไม่บอกว่าติดข้อไหน
 */
export async function resolveMemberAssessmentRecipient(
  db: Pick<Prisma.TransactionClient, 'careRecipient' | 'familyGroupMember'>,
  consent: Pick<ConsentService, 'findWithdrawnType' | 'grantedCurrentUserIds'>,
  actorId: string,
  groupId: string,
  memberUserId: string,
): Promise<string | null> {
  if (!isUUID(groupId) || !isUUID(memberUserId)) throw assessmentAccessDenied();
  const required = new Set([actorId, memberUserId]);
  const members = await db.familyGroupMember.findMany({
    where: { groupId, userId: { in: [...required] }, status: 'ACTIVE' },
    select: { userId: true },
  });
  if (new Set(members.map((member) => member.userId)).size !== required.size)
    throw assessmentAccessDenied();

  const viewingSelf = actorId === memberUserId;
  if (
    !viewingSelf &&
    (await consent.findWithdrawnType(memberUserId, [
      CONSENT_TYPE.DISCLOSE_TO_FAMILY_GROUP,
    ]))
  )
    throw assessmentAccessDenied();

  const profile = await findMemberCareProfile(db, groupId, memberUserId);
  if (!profile) return null;
  if (profile.source === 'self' && !viewingSelf) {
    const granted = await consent.grantedCurrentUserIds(
      [memberUserId],
      CONSENT_TYPE.DISCLOSE_TO_FAMILY_GROUP,
    );
    if (!granted.has(memberUserId)) throw assessmentAccessDenied();
  }
  return profile.id;
}
