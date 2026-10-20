import type { Prisma } from '@prisma/client';
import { recalculateBookingLevel } from './level/booking-level.persistence';
import { recalculateBookingRequiredSkills } from './required-skills/required-skills.persistence';
/** Shared S15/S16/S17 hook; caller owns the transaction and all source writes. */
export async function recalculateBookingRequirements(
  tx: Prisma.TransactionClient,
  bookingId: string,
  transport: 'graphql' | 'rest' = 'graphql',
): Promise<void> {
  // The recipient lock remains held until commit, so both see the same assessment.
  if (await recalculateBookingLevel(tx, bookingId, transport))
    await recalculateBookingRequiredSkills(tx, bookingId, transport);
}
export async function recalculateRecipientBookingRequirements(
  tx: Prisma.TransactionClient,
  careRecipientId: string,
) {
  const bookings = await tx.booking.findMany({
    where: {
      careRecipientId,
      confirmedAt: null,
      status: { in: ['unmatched', 'pending', 'accepted', 'rejected'] },
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  for (const booking of bookings)
    await recalculateBookingRequirements(tx, booking.id);
}
