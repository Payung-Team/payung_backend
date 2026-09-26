/**
 * REST-specific response types for the booking REST endpoints.
 *
 * These are plain interfaces (not GraphQL ObjectTypes) so the REST controller
 * can return them without touching the GraphQL schema.
 */

export interface CaregiverBriefRest {
  id: string;
  fullName?: string;
  avatarUrl?: string;
  hourlyRate?: number;
}

/** Booking summary returned from REST endpoints */
export interface BookingRest {
  id: string;
  bookingDate: string;
  status: string;
  serviceType: string;
  /** PYG-526: ข้อมูลภายในของการจับคู่ — ห้ามแสดงให้ผู้ใช้เห็น ใช้ startTime / endTime แทน */
  timeSlot: string;
  // PYG-526: เดิม REST ไม่คืนเวลาเลย มีแต่ timeSlot → client แสดงได้แค่ "ช่วงเช้า"
  /** เวลาเริ่ม "HH:mm" (เวลาไทย) */
  startTime?: string;
  /** เวลาสิ้นสุด "HH:mm" = startTime + durationHours (คำนวณตอนอ่าน ไม่ได้เก็บในดีบี) */
  endTime?: string;
  durationHours?: number;
  tasks: string[];
  serviceLocations: string[];
  locationAddress: string;
  notes?: string;
  estimatedCost?: number;
  caregiver?: CaregiverBriefRest; // undefined when booking is unmatched
  careRecipientName?: string;
  confirmedAt?: Date;
  createdAt: Date;
}

/**
 * Caregiver card returned from POST /bookings/search-matches
 *
 * ⚠️ BASIC PLACEHOLDER — Phase 3 matching engine will enrich this with scoring.
 */
export interface MatchedCaregiverRest {
  id: string;
  fullName?: string;
  avatarUrl?: string;
  hourlyRate?: number;
  experienceYears?: number;
  skills: string[];
  province?: string;
  district?: string;
  avgRating?: number;
  reviewCount: number;
}

/** Task suggestion item returned from GET /booking-task-suggestions */
export interface TaskSuggestion {
  label: string;
}
