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
  completed_booking_count: number;
  skills: string[];
  /** PYG-556 · S01-AC4 — 'general_caregiver' | 'nurse' | 'physiotherapist' (ไม่มี null) */
  profession: string;
  availability: AvailabilitySlotDto[];
  province: string | null;
  district: string | null;
  verified_at: Date | null;
  /** PYG-597: ผ่านการตรวจใบขับขี่ (แอดมินอนุมัติ + ยังไม่เลยวันหมดอายุ) — ไม่สื่อว่ามีรถ/รับรองความปลอดภัย (R8) */
  driving_license_verified: boolean;
}
