/**
 * ตัวช่วยของระดับผู้ดูแลที่ใช้ร่วมกันระหว่าง AdminService.approveKyc และ AdminCareLevelService (PYG-581)
 *
 * ทำไมเป็นฟังก์ชันธรรมดา ไม่ใช่ service ที่ inject?
 *   approveKyc อยู่ใน AdminService ซึ่งมี spec หลายไฟล์สร้างด้วยรายการ provider ตายตัว
 *   ถ้าเพิ่ม dependency ใหม่ใน constructor ทุก spec ต้องแก้ตาม — ฟังก์ชันที่รับ tx เข้ามาไม่มีปัญหานี้
 *
 * ── กันแอดมินสองคนแก้พร้อมกัน (story E6) ───────────────────────────────────
 *   ทุกทางที่เขียนระดับ ล็อกแถว caregivers ของผู้ดูแลคนนั้นด้วย SELECT … FOR UPDATE ก่อนอ่านค่าเดิม
 *   → คนที่สองรอจนคนแรก commit แล้วจึงอ่าน "ค่าเดิม" ที่ถูกต้อง (= ค่าที่คนแรกเพิ่งเขียน)
 *   → ค่าล่าสุดชนะ และประวัติมีครบทั้งสองแถว โดย old_level ของแต่ละแถวถูกต้อง
 *   เวลาที่บันทึกใช้ clock_timestamp() หลังได้ล็อก ไม่ใช่ NOW() (= เวลาเริ่มทรานแซคชัน)
 *   ไม่งั้นคนที่สองที่เริ่มก่อนแต่รอล็อกจะได้เวลาเก่ากว่าแถวของคนแรก ลำดับประวัติจะกลับหัว
 */
import { Prisma } from '@prisma/client';
import { CareLevel, careLevelFromDb } from '../common/care-level/care-level';
import {
  CareLevelChange,
  CareLevelChangeSource,
  CaregiverCareLevelInfo,
} from './dto/care-level.dto';

/** ค่าพิเศษในคอลัมน์ caregiver_care_level_logs.reason ที่ระบบเขียนเอง (ไม่ใช่ข้อความจากแอดมิน) */
export const CARE_LEVEL_LOG_REASON = {
  /** แถวที่ migration PYG-580 backfill ให้ผู้ดูแลที่อนุมัติไปแล้ว — ห้ามเปลี่ยนสตริง (มีข้อมูลจริงใน DB แล้ว 50 แถว) */
  MIGRATION_DEFAULT: 'migration_default',
  /** แถวที่เขียนตอนแอดมินเลือกระดับพร้อมกดอนุมัติ KYC */
  KYC_APPROVAL: 'kyc_approval',
} as const;

/** แถว caregivers ที่ล็อกไว้ — ชื่อคอลัมน์เป็นแบบ DB เพราะมาจาก $queryRaw */
export interface LockedCaregiverLevel {
  id: string;
  kyc_status: string;
  care_level: string | null;
  care_level_set_by: string | null;
}

/**
 * ล็อกแถว caregivers หนึ่งแถว แล้วคืนค่าระดับปัจจุบัน — ต้องเรียกใน $transaction เท่านั้น
 * (นอกทรานแซคชัน ล็อกจะปล่อยทันทีหลัง query จบ = ไม่ได้กันอะไรเลย)
 *
 * @returns null เมื่อไม่พบผู้ดูแล
 */
export async function lockCaregiverForCareLevel(
  tx: Prisma.TransactionClient,
  caregiverId: string,
): Promise<LockedCaregiverLevel | null> {
  // $queryRaw แบบ tagged template = Prisma ส่ง caregiverId เป็น parameter ($1) ให้ ปลอดภัยจาก SQL injection
  const rows = await tx.$queryRaw<LockedCaregiverLevel[]>`
    SELECT id, kyc_status, care_level, care_level_set_by
    FROM caregivers
    WHERE id = ${caregiverId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

/** เวลาของ DB ณ ตอนนี้จริง ๆ (clock_timestamp) — เรียกหลังได้ล็อกแล้ว */
export async function dbClockNow(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<
    Array<{ now: Date }>
  >`SELECT clock_timestamp() AS now`;
  return rows[0]?.now ?? new Date();
}

/**
 * เขียนระดับใหม่ + แถวประวัติ "ในทรานแซคชันเดียวกัน" (การ์ด PYG-581: สองอย่างนี้ต้องสำเร็จหรือล้มพร้อมกัน)
 *
 * ผู้เรียกต้อง: ล็อกแถวด้วย lockCaregiverForCareLevel แล้ว และตัดสินแล้วว่าการเขียนนี้ "นับเป็นการเปลี่ยน"
 * (ฟังก์ชันนี้ไม่เช็คค่าเดิมซ้ำ — ใครเรียกก็ได้แถวประวัติเสมอ)
 */
export async function writeCareLevelChange(
  tx: Prisma.TransactionClient,
  change: {
    caregiverId: string;
    oldLevel: CareLevel | null;
    newLevel: CareLevel;
    /** users.id ของแอดมินที่ล็อกอิน — ไม่รับจาก input ของ client */
    changedBy: string;
    reason: string;
    at: Date;
  },
): Promise<void> {
  await tx.caregiver.update({
    where: { id: change.caregiverId },
    data: {
      careLevel: change.newLevel,
      careLevelSetBy: change.changedBy,
      careLevelSetAt: change.at,
    },
  });

  await tx.caregiver_care_level_logs.create({
    data: {
      caregiver_id: change.caregiverId,
      old_level: change.oldLevel,
      new_level: change.newLevel,
      changed_by: change.changedBy,
      reason: change.reason,
      created_at: change.at,
    },
  });
}

/** แปลงแถว caregivers (Prisma) → CaregiverCareLevelInfo */
export function toCareLevelInfo(row: {
  id: string;
  careLevel?: string | null;
  careLevelSetBy?: string | null;
  careLevelSetAt?: Date | null;
  careLevelSetByUser?: { displayName: string | null } | null;
}): CaregiverCareLevelInfo {
  const level = careLevelFromDb(row.careLevel);
  const setBy = row.careLevelSetBy ?? null;
  return {
    caregiverId: row.id,
    level,
    setBy,
    setByName: row.careLevelSetByUser?.displayName ?? null,
    setAt: row.careLevelSetAt ?? null,
    // มีระดับ แต่ไม่มีแอดมินคนไหนเป็นผู้กำหนด = ค่าเริ่มต้นจาก migration ที่ยังไม่ถูกทบทวน (E3)
    needsReview: level !== null && setBy === null,
  };
}

/** แปลงแถว caregiver_care_level_logs (Prisma) → CareLevelChange */
export function toCareLevelChange(row: {
  id: string;
  old_level: string | null;
  new_level: string;
  changed_by: string | null;
  reason: string | null;
  created_at: Date;
  users?: { displayName: string | null } | null;
}): CareLevelChange {
  const source = careLevelChangeSource(row.changed_by, row.reason);
  return {
    id: row.id,
    oldLevel: careLevelFromDb(row.old_level),
    // new_level เป็น NOT NULL + CHECK 3 ค่าใน DB จึงแปลงตรง ๆ ได้
    // (ถ้าวันหนึ่งมีค่าแปลกหลุดมา GraphQL จะตอบ error ให้เห็น ดีกว่าเดาค่าแทนเงียบ ๆ)
    newLevel: row.new_level as CareLevel,
    changedBy: row.changed_by,
    changedByName: row.users?.displayName ?? null,
    // แถวที่ระบบเขียน reason เป็นรหัสภายใน ไม่ใช่ข้อความให้คนอ่าน → ส่ง null แล้วให้ FE ดู source แทน
    reason: source === CareLevelChangeSource.ADMIN_UPDATE ? row.reason : null,
    source,
    createdAt: row.created_at,
  };
}

function careLevelChangeSource(
  changedBy: string | null,
  reason: string | null,
): CareLevelChangeSource {
  // changed_by = NULL มีทางเดียวคือ backfill ของ migration (โค้ดทุกทางใส่ users.id ของแอดมินเสมอ)
  if (
    changedBy === null ||
    reason === CARE_LEVEL_LOG_REASON.MIGRATION_DEFAULT
  ) {
    return CareLevelChangeSource.MIGRATION_DEFAULT;
  }
  if (reason === CARE_LEVEL_LOG_REASON.KYC_APPROVAL) {
    return CareLevelChangeSource.KYC_APPROVAL;
  }
  return CareLevelChangeSource.ADMIN_UPDATE;
}
