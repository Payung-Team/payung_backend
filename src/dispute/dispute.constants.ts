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
