import type { Prisma } from '@prisma/client';
import { assessmentRequired } from './assessment.errors';

/** Call before any booking writes, with the resolved recipient, never booker ID. */
export async function assertBookingAssessment(
  tx: Prisma.TransactionClient,
  careRecipientId: string | null | undefined,
  transport: 'graphql' | 'rest',
): Promise<void> {
  if (!careRecipientId) throw assessmentRequired(transport);
  // Same lock order as assessment saves and S17 confirmation: recipient, booking.
  const active = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM care_recipients
    WHERE id = ${careRecipientId}::uuid AND is_deleted = false FOR UPDATE`;
  if (active.length === 0) throw assessmentRequired(transport);
  const assessment = await tx.careRecipientAssessment.findUnique({
    where: { careRecipientId },
    select: { id: true },
  });
  if (!assessment) throw assessmentRequired(transport);
}
