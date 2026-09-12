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
  timeSlot: string;
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
