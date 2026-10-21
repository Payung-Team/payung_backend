import type { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import type { ConsentService } from '../consent/consent.service';
import { CONSENT_TYPE } from '../consent/consent.constants';
import { assessmentAccessDenied } from './assessment.errors';

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
