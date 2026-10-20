import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { assessmentRequired } from '../../assessment/assessment.errors';
import { lockRequiredSkillRecipient } from '../required-skills/required-skills.persistence';
import { calculateBookingLevel } from './booking-level.calculate';
import { levelErrorForTransport } from './booking-level.errors';
/** Caller owns the transaction. Recipient lock pins the assessment version. */
export async function recalculateBookingLevel(
  tx: Prisma.TransactionClient,
  bookingId: string,
  transport: 'graphql' | 'rest',
): Promise<boolean> {
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
      careRecipientId: true,
      confirmedAt: true,
      status: true,
      serviceType: true,
      activities: {
        select: { careActivity: { select: { code: true, careLevel: true } } },
      },
    },
  });
  if (
    booking.confirmedAt ||
    !['unmatched', 'pending', 'accepted', 'rejected'].includes(booking.status)
  )
    return false;
  if (!booking.careRecipientId) throw assessmentRequired(transport);
  const assessment = await tx.careRecipientAssessment.findUnique({
    where: { careRecipientId: booking.careRecipientId },
  });
  if (!assessment) throw assessmentRequired(transport);
  const services: { code: string | null; careLevel: string | null }[] =
    booking.activities.map((activity) => activity.careActivity);
  // A physiotherapy booking denotes F03. Its level always comes from DB.
  if (
    booking.serviceType === 'physiotherapy' &&
    !services.some((service) => service.code === 'F03')
  ) {
    const activity = await tx.careActivity.findUnique({
      where: { code: 'F03' },
      select: { code: true, careLevel: true },
    });
    services.push(activity ?? { code: 'F03', careLevel: null });
  }
  const rules = await tx.bookingLevelRule.findMany({
    where: { isActive: true },
  });
  try {
    const level = calculateBookingLevel(
      {
        adlTotalScore: assessment.adlTotalScore,
        flags: assessment.flags,
        hasUnsureFlag: assessment.hasUnsureFlag,
        dementiaSevere: assessment.dementiaSevere,
        services,
      },
      rules,
    );
    await tx.booking.update({
      where: { id: bookingId },
      data: {
        requiredLevel: level.requiredLevel,
        levelFromAdl: level.adl,
        levelFromFlags: level.flags,
        levelFromServices: level.services,
        levelCalculatedAt: new Date(),
      },
    });
    return true;
  } catch (error) {
    levelErrorForTransport(error, transport);
  }
}
