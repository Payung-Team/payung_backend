import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { assessmentRequired } from '../../assessment/assessment.errors';
import { calculateRequiredSkills } from './required-skills.calculate';
import { skillErrorForTransport } from './required-skills.errors';

const RECALCULABLE = ['unmatched', 'pending', 'accepted', 'rejected'];

/** All writers lock recipient BEFORE booking, matching assessment saves/deletion. */
export async function lockRequiredSkillRecipient(
  tx: Prisma.TransactionClient,
  careRecipientId: string,
) {
  await tx.$queryRaw`SELECT id FROM care_recipients WHERE id = ${careRecipientId}::uuid FOR UPDATE`;
}

/**
 * S15/S16 integration point: call AFTER changing persisted services/activities,
 * inside the caller's transaction, with recipient locked first. No nested tx.
 * Does not calculate or write S16 levels/timestamps.
 */
export async function recalculateBookingRequiredSkills(
  tx: Prisma.TransactionClient,
  bookingId: string,
  transport: 'graphql' | 'rest' = 'graphql',
): Promise<void> {
  const initial = await tx.booking.findUnique({
    where: { id: bookingId },
    select: { careRecipientId: true },
  });
  if (!initial) throw new NotFoundException('Booking not found');
  if (initial.careRecipientId)
    await lockRequiredSkillRecipient(tx, initial.careRecipientId);
  await tx.$queryRaw`SELECT id FROM bookings WHERE id = ${bookingId}::uuid FOR UPDATE`;
  const booking = await tx.booking.findUniqueOrThrow({
    where: { id: bookingId },
    select: {
      status: true,
      serviceType: true,
      confirmedAt: true,
      careRecipientId: true,
      activities: { select: { careActivity: { select: { code: true } } } },
    },
  });
  // A terminal status cannot reopen a confirmed snapshot; keep legacy nulls.
  if (booking.confirmedAt || !RECALCULABLE.includes(booking.status)) return;
  if (!booking.careRecipientId) throw assessmentRequired(transport);
  const assessment = await tx.careRecipientAssessment.findUnique({
    where: { careRecipientId: booking.careRecipientId },
  });
  if (!assessment) throw assessmentRequired(transport);
  const rules = await tx.careSkillRule.findMany({
    where: { isActive: true },
  });
  // Load separately so a missing target is a domain configuration error, not
  // Prisma's required-relation exception, even on inconsistent legacy data.
  const skills = rules.length
    ? await tx.careSkill.findMany({
        where: {
          code: { in: [...new Set(rules.map((rule) => rule.skillCode))] },
        },
        select: { code: true, isActive: true },
      })
    : [];
  const byCode = new Map(skills.map((skill) => [skill.code, skill]));
  try {
    const result = calculateRequiredSkills(
      {
        adlAnswers: assessment.adlAnswers as Record<string, number | null>,
        // System flags are inputs, never implicit skills. Only configured rules apply.
        flags: [
          ...assessment.flags,
          ...(assessment.hasUnsureFlag ? ['unsure'] : []),
        ],
        serviceCodes: [
          booking.serviceType,
          // Current seed addresses services by T-01 activity codes. Before S15
          // supplies activities, an explicit physiotherapy booking denotes F03
          // (S17-R6). Medication is NOT an alias for injection or any other task.
          ...(booking.serviceType === 'physiotherapy' ? ['F03'] : []),
          ...booking.activities.flatMap((row) =>
            row.careActivity.code ? [row.careActivity.code] : [],
          ),
        ],
      },
      rules.map((rule) => ({
        ...rule,
        skill: byCode.get(rule.skillCode) ?? null,
      })),
    );
    await tx.bookingRequiredSkill.deleteMany({ where: { bookingId } });
    if (result.length)
      await tx.bookingRequiredSkill.createMany({
        data: result.map((row) => ({
          bookingId,
          skillCode: row.code,
          sources: row.sources,
        })),
      });
    await tx.booking.update({
      where: { id: bookingId },
      data: { requiredSkills: result.map((row) => row.code) },
    });
  } catch (error) {
    skillErrorForTransport(error, transport);
  }
}

/** Parent row is already locked by AssessmentService; stable order avoids cycles. */
export async function recalculateRecipientRequiredSkills(
  tx: Prisma.TransactionClient,
  careRecipientId: string,
) {
  const bookings = await tx.booking.findMany({
    where: { careRecipientId, confirmedAt: null, status: { in: RECALCULABLE } },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  for (const booking of bookings)
    await recalculateBookingRequiredSkills(tx, booking.id);
}
