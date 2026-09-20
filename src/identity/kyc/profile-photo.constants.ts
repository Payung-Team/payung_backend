/**
 * ค่าคงที่ของรูปโปรไฟล์ที่อัปโหลดผ่าน backend (PYG-507 / การ์ดแม่ PYG-488)
 */

/** bucket ใหม่ของการ์ดนี้ — private, เขียนด้วย service-role เท่านั้น (ดู migration 20260920010000) */
export const PROFILE_PHOTOS_BUCKET = 'profile-photos';

/**
 * JPEG อย่างเดียว — FE crop แล้ว export เป็น JPEG เสมอ (PYG-510)
 * ทำให้ใช้ตัวตัด EXIF ของ PYG-466 ซ้ำได้ตรง ๆ (รองรับ JPEG เท่านั้น)
 */
export const PROFILE_PHOTO_MIME = 'image/jpeg';

/** ตรงกับ file_size_limit ของ bucket — ถ้าแก้ที่นี่ต้องแก้ใน migration ด้วย */
export const PROFILE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/** doc_type ใน kyc_documents ของรูปโปรไฟล์ผู้ดูแล (ของเดิมมี id_card_front / id_card_selfie / certificate) */
export const PROFILE_PHOTO_DOC_TYPE = 'profile_photo';

/** ค่าที่ CHECK ของ kyc_documents.review_status ยอมรับ (PYG-506) */
export const DOCUMENT_REVIEW_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
} as const;
