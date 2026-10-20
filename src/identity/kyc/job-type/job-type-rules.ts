/**
 * กฎประเภทงาน x วิชาชีพ x ใบประกอบฯ — ตารางจับคู่ที่เคาะแล้ว (PYG-590, Sammy 7 ต.ค. 2026)
 *
 * ★ ตารางเดียวที่ทั้ง operation อ่าน (myJobTypeOptions) และ operation เขียน (updateWorkCondition) ใช้ร่วมกัน
 *   แก้ตารางที่นี่ที่เดียว (ถ้าทีมเคาะผู้ช่วยพยาบาลเป็นวิชาชีพที่ 4 ต้องแก้ PYG-590 ก่อน)
 *
 * medication = จัดยาตามแพทย์สั่ง ไม่รวมฉีดยา — ไม่ผูกวิชาชีพ ตัวตรวจนี้ไม่ตรวจเรื่องฉีดยา (S17/S18)
 */
import { LICENSE_STATUS } from '../license/license.constants';

/** ค่าเดียวกับ enum job_type ใน DB ครบ 5 ค่า — ลำดับนี้คือลำดับที่ส่งให้ FE */
export const JOB_TYPES = [
  'general_care',
  'bedridden_care',
  'companion',
  'medication',
  'physiotherapy',
] as const;

export type JobTypeValue = (typeof JOB_TYPES)[number];

export const JOB_TYPE_BLOCKED_REASON = {
  PROFESSION_MISMATCH: 'PROFESSION_MISMATCH',
  LICENSE_NOT_APPROVED: 'LICENSE_NOT_APPROVED',
  LICENSE_EXPIRED: 'LICENSE_EXPIRED',
} as const;

export type JobTypeBlockedReason =
  (typeof JOB_TYPE_BLOCKED_REASON)[keyof typeof JOB_TYPE_BLOCKED_REASON];

interface JobTypeRule {
  /** วิชาชีพที่ต้องเป็น */
  profession: string;
  /** ต้องมีใบประกอบฯ ที่อนุมัติและยังไม่หมดอายุ */
  requiresLicense: boolean;
}

/** ประเภทงานที่ไม่อยู่ในตาราง = ไม่ผูกวิชาชีพ ไม่ต้องมีใบประกอบฯ */
export const JOB_TYPE_RULES: Readonly<Partial<Record<JobTypeValue, JobTypeRule>>> = {
  physiotherapy: { profession: 'physiotherapist', requiresLicense: true },
};

/** ข้อมูลใบประกอบฯ ที่ตัวตรวจต้องใช้ (หนึ่งแถวของ kyc_documents ชนิด professional_license) */
export interface LicenseSnapshot {
  reviewStatus: string | null;
  expiresAt: Date | null;
  uploadedAt: Date;
}

export interface JobTypeEvaluation {
  jobType: string;
  selectable: boolean;
  blockedReason: JobTypeBlockedReason | null;
}

/** ใบที่ใช้ได้ ณ เวลาตรวจ: อนุมัติ + expires_at ยังไม่ถึง (เทียบเวลาตอนตรวจ ไม่พึ่งแค่ค่า expired ของงานรายวัน) */
function isValidLicense(l: LicenseSnapshot, now: Date): boolean {
  return (
    l.reviewStatus === LICENSE_STATUS.APPROVED &&
    l.expiresAt !== null &&
    l.expiresAt.getTime() > now.getTime()
  );
}

/** ใบที่เคยอนุมัติแต่หมดอายุแล้ว (สถานะ expired จากงานรายวัน หรือ approved แต่ expires_at ถึงแล้วโดยงานยังไม่รัน) */
function isExpiredLicense(l: LicenseSnapshot, now: Date): boolean {
  if (l.reviewStatus === LICENSE_STATUS.EXPIRED) return true;
  return (
    l.reviewStatus === LICENSE_STATUS.APPROVED &&
    l.expiresAt !== null &&
    l.expiresAt.getTime() <= now.getTime()
  );
}

/**
 * ตัวตรวจกลาง (pure) — ลำดับเหตุผลเมื่อผิดหลายข้อตาม PYG-590:
 *   วิชาชีพไม่ตรง → ใบประกอบฯ ยังไม่อนุมัติ → หมดอายุ
 *
 * @param licenses ใบประกอบฯ ทั้งหมดของผู้ดูแล — มีใบที่ใช้ได้อย่างน้อยหนึ่งใบ = ผ่าน
 *                 ถ้าไม่มี ให้ใบล่าสุด (uploadedAt) ตัดสินเหตุผล (ใบใหม่รอตรวจ = NOT_APPROVED แม้ใบเก่าหมดอายุ)
 */
export function evaluateJobType(
  jobType: string,
  profession: string,
  licenses: LicenseSnapshot[],
  now: Date,
): JobTypeEvaluation {
  const rule = JOB_TYPE_RULES[jobType as JobTypeValue];
  if (!rule) return { jobType, selectable: true, blockedReason: null };

  if (profession !== rule.profession) {
    return { jobType, selectable: false, blockedReason: JOB_TYPE_BLOCKED_REASON.PROFESSION_MISMATCH };
  }
  if (!rule.requiresLicense) return { jobType, selectable: true, blockedReason: null };

  if (licenses.some((l) => isValidLicense(l, now))) {
    return { jobType, selectable: true, blockedReason: null };
  }

  const latest = [...licenses].sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime())[0];
  const reason =
    latest && isExpiredLicense(latest, now)
      ? JOB_TYPE_BLOCKED_REASON.LICENSE_EXPIRED
      : JOB_TYPE_BLOCKED_REASON.LICENSE_NOT_APPROVED;
  return { jobType, selectable: false, blockedReason: reason };
}
