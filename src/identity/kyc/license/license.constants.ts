/**
 * ค่าคงที่ของใบประกอบวิชาชีพ (PYG-558 / PYG-587 · contract PYG-585)
 */

/** doc_type ใน kyc_documents ของใบประกอบวิชาชีพ (DB ไม่มี CHECK บน doc_type) */
export const LICENSE_DOC_TYPE = 'professional_license';

/** วิชาชีพที่ต้องมีใบประกอบฯ — general_caregiver ไม่ตรวจ (PYG-574: caregivers.profession) */
export const LICENSE_REQUIRED_PROFESSIONS: ReadonlySet<string> = new Set([
  'nurse',
  'physiotherapist',
]);

/** เลขใบประกอบฯ ยาวสุดหลังตัดช่องว่างหัวท้าย (E5) — ค่าเสนอใน contract รอ FE/BE รับ */
export const LICENSE_NUMBER_MAX_LENGTH = 50;

/** kyc_documents.review_status ที่ใบประกอบฯ ใช้ (CHECK รับ 'expired' ตั้งแต่ PYG-586) */
export const LICENSE_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
} as const;

/** kyc_reviews.action ของการตรวจใบประกอบฯ — แถวพวกนี้มี document_id เสมอ (แยกจาก KYC ทั้งก้อน) */
export const LICENSE_REVIEW_ACTION = {
  APPROVED: 'license_approved',
  REJECTED: 'license_rejected',
} as const;

/** สถานะที่ยังนับว่า "ใช้อยู่" — งานหมดอายุรายวันหยิบเฉพาะกลุ่มนี้ */
export const LICENSE_LIVE_STATUSES = [LICENSE_STATUS.PENDING, LICENSE_STATUS.APPROVED];
