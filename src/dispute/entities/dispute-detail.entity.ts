import { DisputeStatus } from './dispute-status.enum';
import { DisputePartyBrief, DisputePaymentBrief } from './dispute-booking.entity';

/**
 * REST-only response shapes for GET /api/v1/admin/disputes/:id.
 * Plain TS types (no GraphQL decorators) — this endpoint has no GraphQL equivalent.
 */

export interface DisputePaymentHistoryEntry {
  id: string;
  fromStatus?: string;
  toStatus: string;
  changedBy?: DisputePartyBrief;
  reason?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface DisputeEvidenceEntry {
  id: string;
  fileUrl: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  note?: string;
  uploadedBy?: DisputePartyBrief;
  uploaderRole: string;
  createdAt: Date;
}

export interface DisputeAuditLogEntry {
  id: string;
  action: string;
  fromStatus?: string;
  toStatus?: string;
  actor?: DisputePartyBrief;
  actorRole?: string;
  note?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface DisputeDetail {
  id: string;
  bookingDate: string;
  status: string;
  serviceType: string;
  /** PYG-526: ข้อมูลภายในของการจับคู่ — ห้ามแสดงให้ผู้ใช้เห็น ใช้ startTime / endTime แทน */
  timeSlot: string;
  /** เวลาเริ่ม "HH:mm" (เวลาไทย) */
  startTime?: string;
  /** เวลาสิ้นสุด "HH:mm" = startTime + durationHours (คำนวณตอนอ่าน ไม่ได้เก็บในดีบี) */
  endTime?: string;
  durationHours?: number;
  locationAddress: string;
  estimatedCost?: number;

  disputeStatus: DisputeStatus;
  disputeReason?: string;
  disputeResolvedAt?: Date;
  resolvedBy?: DisputePartyBrief;

  patient: DisputePartyBrief;
  caregiver?: DisputePartyBrief;
  payment?: DisputePaymentBrief;

  paymentHistory: DisputePaymentHistoryEntry[];
  evidence: DisputeEvidenceEntry[];
  notes: DisputeAuditLogEntry[];
  audit: DisputeAuditLogEntry[];

  createdAt: Date;
  updatedAt: Date;
}
