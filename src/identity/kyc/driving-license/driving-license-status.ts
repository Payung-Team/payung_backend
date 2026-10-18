/**
 * คำนวณสถานะ "ผ่านการตรวจใบขับขี่" — จุดเดียวของระบบ (PYG-597 · R5, R9)
 *
 * ใช้ร่วมกันทั้งตอนแสดงผล (โปรไฟล์ Elder / ผู้ดูแล / แอดมิน) และตอนรับงาน (assertVerified)
 * ห้ามมีที่อื่นคำนวณซ้ำ
 *
 * ผ่าน (verified) = มีใบที่แอดมินอนุมัติแล้ว "และ" วันนี้ยังไม่เลยวันหมดอายุ (ตามปฏิทินไทย)
 *   - วันหมดอายุเองยังใช้ได้ · เทียบเป็น "วัน" ตามเวลาไทย ไม่ขึ้นกับเวลาที่เก็บในคอลัมน์
 *   - คำนวณ ณ เวลาที่เรียก ไม่เก็บสถานะหมดอายุในฐาน (R9) → ใบที่หมดอายุกลายเป็น false เองโดยไม่มีใครแก้ข้อมูล (E3)
 *
 * ผู้ดูแลมีหลายแถว (E7 อัปโหลดใหม่หลังถูกปฏิเสธ / E8 ต่ออายุ):
 *   - verified: มีแถวใดแถวหนึ่งที่ approved และไม่หมดอายุ ก็ผ่าน
 *     (ใบเดิมที่ยังไม่หมดอายุยังใช้ได้ระหว่างรอตรวจใบใหม่ — ข้อสมมติ รอทีมเคาะ E8)
 *   - แสดงผล (status / เหตุผล / วันหมดอายุ): ใช้แถวที่อัปโหลด "ล่าสุด"
 */
import { bangkokDayNumber } from '../license/license-date';
import { DRIVING_LICENSE_REVIEW_STATUS } from './driving-license.constants';

export type DrivingLicenseStatus = 'none' | 'pending' | 'approved' | 'rejected';

/** แถว kyc_documents ชนิด driving_license ที่ตัวคำนวณต้องใช้ */
export interface DrivingLicenseRow {
  id: string;
  reviewStatus: string | null;
  expiresAt: Date | null;
  uploadedAt: Date;
}

export interface DrivingLicenseState {
  /** ผ่านการตรวจ ณ เวลาที่เรียก (R5) */
  verified: boolean;
  /** สถานะของแถวล่าสุด · none = ไม่เคยอัปโหลด */
  status: DrivingLicenseStatus;
  /** แถวล่าสุดที่ใช้แสดงผล */
  documentId?: string;
  expiresAt?: Date;
  /** แถวล่าสุดหมดอายุแล้ว ณ เวลาที่เรียก (BE คำนวณให้ FE ไม่คำนวณเอง) */
  isExpired: boolean;
}

/** วันนี้ยังไม่เลยวันหมดอายุ (ตามปฏิทินไทย) — วันหมดอายุเองยังใช้ได้ */
export function isDrivingLicenseUnexpired(expiresAt: Date, now: Date): boolean {
  return bangkokDayNumber(expiresAt) >= bangkokDayNumber(now);
}

function normalizeStatus(reviewStatus: string | null): Exclude<DrivingLicenseStatus, 'none'> {
  if (reviewStatus === DRIVING_LICENSE_REVIEW_STATUS.APPROVED) return 'approved';
  if (reviewStatus === DRIVING_LICENSE_REVIEW_STATUS.REJECTED) return 'rejected';
  // pending, null และค่าที่ไม่รู้จัก = ยังไม่ผ่านการตรวจ
  return 'pending';
}

export function computeDrivingLicenseState(rows: DrivingLicenseRow[], now: Date): DrivingLicenseState {
  if (rows.length === 0) return { verified: false, status: 'none', isExpired: false };

  const verified = rows.some(
    (r) =>
      normalizeStatus(r.reviewStatus) === 'approved' &&
      r.expiresAt !== null &&
      isDrivingLicenseUnexpired(r.expiresAt, now),
  );

  const latest = [...rows].sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime())[0];
  return {
    verified,
    status: normalizeStatus(latest.reviewStatus),
    documentId: latest.id,
    expiresAt: latest.expiresAt ?? undefined,
    isExpired: latest.expiresAt !== null && !isDrivingLicenseUnexpired(latest.expiresAt, now),
  };
}
