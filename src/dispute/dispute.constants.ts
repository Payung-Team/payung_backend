import { DisputeDecision } from './entities/dispute-decision.enum';
import { DisputeResolutionAction } from './dto/resolve-dispute.dto';

/**
 * PYG-316: Dispute SLA configuration
 *
 * SLA window = ระยะเวลาตั้งแต่ dispute ถูก "ยื่น" (filed) จนถึง "กำหนดต้องตัดสิน" (resolution deadline).
 * เก็บเป็นค่าคงที่ที่เดียว → ถ้า business เปลี่ยน SLA แก้แค่บรรทัดนี้บรรทัดเดียว
 *
 * sla_due_at = dispute_filed_at + DISPUTE_SLA_HOURS ชั่วโมง
 */
export const DISPUTE_SLA_HOURS = 72; // 3 วัน

/**
 * ค่าที่เป็นไปได้ของ "ผู้ยื่น dispute" (dispute_filed_by column)
 * ตอนนี้มีแต่ 'customer' (patient) ที่ flag ได้ — 'caregiver' เผื่ออนาคต
 */
export const DISPUTE_FILED_BY = {
  CUSTOMER: 'customer',
  CAREGIVER: 'caregiver',
} as const;

/**
 * แปลง REST resolution vocabulary (ticket-specified) → GraphQL DisputeDecision
 * เก็บแยกจาก DisputeDecision เพื่อไม่ให้ REST contract ผูกกับ GraphQL enum โดยตรง
 */
export const RESOLUTION_TO_DECISION: Record<
  DisputeResolutionAction,
  DisputeDecision
> = {
  [DisputeResolutionAction.full_refund]: DisputeDecision.refund_full,
  [DisputeResolutionAction.partial_refund]: DisputeDecision.refund_partial,
  [DisputeResolutionAction.reject]: DisputeDecision.no_refund,
};

/** dispute_audit_logs.action values ที่ระบบเขียนอัตโนมัติ */
export const DISPUTE_AUDIT_ACTION = {
  FILED: 'dispute_filed',
  NOTE_ADDED: 'note_added',
  RESOLVED: 'resolved',
} as const;
