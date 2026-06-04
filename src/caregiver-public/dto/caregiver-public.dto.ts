/**
 * CaregiverPublicDto
 *
 * Fields returned by GET /api/v1/caregivers/:id/public.
 * Intentionally excludes: id_card_number, phone, email, full address.
 */

export class AvailabilitySlotDto {
  day: number;   // 0 = Sunday … 6 = Saturday (ISO: 1=Mon, but we follow dayOfWeek in DB)
  slots: string[];
}

export class CaregiverPublicDto {
  id: string;
  first_name: string;
  last_name: string;
  avatar_url: string | null;
  bio: string | null;
  experience_years: number | null;
  hourly_rate: number | null;
  avg_rating: number | null;
  review_count: number;
  skills: string[];
  availability: AvailabilitySlotDto[];
  province: string | null;
  district: string | null;
  verified_at: Date | null;
}
