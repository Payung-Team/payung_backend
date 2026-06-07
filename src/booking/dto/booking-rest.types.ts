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
  timeSlot: string;
  tasks: string[];
  serviceLocations: string[];
  locationAddress: string;
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
