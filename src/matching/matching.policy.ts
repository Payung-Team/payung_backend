import type { MatchingAdminContact } from './matching.types';
/** E8 approved by the user: expiry is checked on the service day, Asia/Bangkok. */
export function bookingEvidenceReferenceDate(bookingDate: Date): Date {
  if (!Number.isFinite(bookingDate.getTime()))
    throw new RangeError('Invalid booking date');
  // booking_date is a SQL DATE, represented as UTC midnight by Prisma.
  return new Date(`${bookingDate.toISOString().slice(0, 10)}T00:00:00+07:00`);
}
export function matchingAdminContact(): MatchingAdminContact | null {
  const value = process.env.MATCHING_ADMIN_CONTACT_URL?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'tel:'].includes(url.protocol)) return null;
    return { label: 'ติดต่อทีมงาน Payung', url: url.toString() };
  } catch {
    return null;
  }
}
