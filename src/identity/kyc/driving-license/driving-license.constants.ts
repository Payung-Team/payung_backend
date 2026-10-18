/**
 * ค่าคงที่ของใบขับขี่ (PYG-597 / การ์ดแม่ PYG-561 · contract PYG-596)
 *
 * เก็บใน kyc_documents (doc_type = 'driving_license') ใช้คอลัมน์ expires_at ที่ S03 (PYG-586) สร้างไว้แล้ว
 * ผลตรวจใช้ review_status เดิม · ประวัติใช้ kyc_reviews (document_id)
 * ไม่มีสถานะ 'expired' ในฐานสำหรับใบขับขี่ — หมดอายุคำนวณตอนใช้งาน (R9)
 */
export const DRIVING_LICENSE_DOC_TYPE = 'driving_license';

export const DRIVING_LICENSE_REVIEW_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
} as const;

/** kyc_reviews.action ของการตรวจใบขับขี่ — มี document_id เสมอ (แยกจาก KYC ทั้งก้อนและใบประกอบฯ) */
export const DRIVING_LICENSE_REVIEW_ACTION = {
  APPROVED: 'driving_license_approved',
  REJECTED: 'driving_license_rejected',
} as const;
