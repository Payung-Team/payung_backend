import { Prisma } from '@prisma/client';
/** Existing List baseline, shared by generic search and booking matching. */
export function publicCaregiverConditions(): Prisma.Sql[] {
  return [
    Prisma.sql`c.is_searchable = true`,
    Prisma.sql`c.kyc_status = 'verified'`,
    Prisma.sql`EXISTS (SELECT 1 FROM caregiver_availability ca WHERE ca.caregiver_id = c.id AND ca.is_active = true)`,
  ];
}
