/**
 * วิชาชีพของผู้ดูแล (PYG-556 · S01) — ค่าคงที่ที่ทุกส่วนของ BE ใช้ร่วมกัน
 *
 * Contract กับ FE: docs/pyg573-caregiver-profession-api-contract.md (branch feature/pyg-573)
 *
 * ★ ค่าใน enum ต้องตรงกับ CHECK ใน DB ทั้ง 2 ตัว (migration PYG-574 / PYG-568):
 *     caregivers_profession_check               ('general_caregiver','nurse','physiotherapist')
 *     care_activity_professions_profession_check (ชุดเดียวกัน)
 *   และ PROFESSION_CODES ของ FE (src/lib/professions.ts)
 *   จะเพิ่มค่าใหม่: แก้ enum นี้ + deploy BE "ก่อน" แล้วค่อย migrate CHECK (ลำดับเหตุผลใน contract §8)
 */
import { registerEnumType } from '@nestjs/graphql';

/**
 * ชื่อ member = ค่าที่ส่งผ่าน GraphQL (ตัวพิมพ์เล็กโดยตั้งใจ — แบบเดียวกับ KycStatusFilter / RoleFilter)
 * Nest code-first ใช้ "ชื่อ member" เป็นค่าของ enum ใน schema → ได้ `general_caregiver` ตรงกับ DB และ FE
 */
export enum CaregiverProfession {
  general_caregiver = 'general_caregiver',
  nurse = 'nurse',
  physiotherapist = 'physiotherapist',
}

registerEnumType(CaregiverProfession, {
  name: 'CaregiverProfession',
  description:
    'วิชาชีพของผู้ดูแล — ค่าตรงกับ CHECK caregivers_profession_check',
  valuesMap: {
    general_caregiver: { description: 'ผู้ดูแลทั่วไป (General caregiver)' },
    nurse: { description: 'พยาบาล (Nurse) — ต้องมีใบประกอบวิชาชีพ (S03)' },
    physiotherapist: {
      description:
        'นักกายภาพบำบัด (Physiotherapist) — ต้องมีใบประกอบวิชาชีพ (S03)',
    },
  },
});

/** รายการค่าที่รับได้ — ใช้ตรวจ input และใส่ใน extensions.allowed ของ error ให้ FE */
export const CAREGIVER_PROFESSIONS: readonly CaregiverProfession[] =
  Object.values(CaregiverProfession);

/** type guard — ใช้แทน `as CaregiverProfession` ทุกที่ที่รับค่ามาจากภายนอก */
export function isCaregiverProfession(
  value: unknown,
): value is CaregiverProfession {
  return (
    typeof value === 'string' &&
    (CAREGIVER_PROFESSIONS as readonly string[]).includes(value)
  );
}

/**
 * ค่า oldValue/newValue ใน caregiver_edit_logs.field_changes เก็บเป็น JSON string ('"nurse"')
 * ตามกติกา computeFieldChanges → แปลงกลับเป็น 'nurse' · ค่าเสีย/ไม่รู้จัก → null
 *
 * ★ ทุกที่ที่อ่าน log เปลี่ยนวิชาชีพต้องใช้ตัวนี้ ห้ามเทียบสตริงดิบกับ caregivers.profession (PYG-667)
 */
export function parseStoredProfession(
  value: unknown,
): CaregiverProfession | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isCaregiverProfession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * สถานะของคำขอเปลี่ยนวิชาชีพหลัง KYC อนุมัติ (S01-AC6)
 * ไม่มีคอลัมน์ไหนเก็บค่านี้ตรง ๆ — คำนวณจากแถวใน caregiver_edit_logs (ดู PROFESSION_CHANGE_ACTION)
 */
export enum ProfessionChangeStatus {
  pending = 'pending',
  approved = 'approved',
  rejected = 'rejected',
  cancelled = 'cancelled',
}

registerEnumType(ProfessionChangeStatus, {
  name: 'ProfessionChangeStatus',
  description: 'สถานะของคำขอเปลี่ยนวิชาชีพ',
  valuesMap: {
    pending: { description: 'รอแอดมินตรวจ — วิชาชีพยังเป็นค่าเดิม' },
    approved: { description: 'แอดมินอนุมัติ — วิชาชีพเปลี่ยนเป็นค่าใหม่แล้ว' },
    rejected: {
      description: 'แอดมินปฏิเสธ — วิชาชีพคงเดิม (ดู rejectionReason)',
    },
    cancelled: { description: 'ผู้ดูแลยกเลิกเอง — วิชาชีพคงเดิม' },
  },
});

/**
 * caregiver_edit_logs.action ของคำขอเปลี่ยนวิชาชีพ — ทุกเหตุการณ์เป็น "แถวใหม่" (append-only)
 *
 * ทำไมเก็บใน caregiver_edit_logs ไม่สร้างตารางใหม่? (มติ 2026-10-17)
 *   ตารางใหม่ = migration ซึ่งต้องรอ gate · ตารางนี้มีอยู่แล้วและ story ขอให้บันทึกการเปลี่ยนวิชาชีพที่นี่อยู่แล้ว
 *   ข้อแลก: กติกา "pending ทีละ 1" อยู่ในโค้ด (ล็อกแถว caregivers) ไม่มี unique index ใน DB
 *
 * ★ ห้ามใครลบ/แก้แถวเหล่านี้เอง — แถวพวกนี้ "คือ" สถานะของคำขอ
 */
export const PROFESSION_CHANGE_ACTION = {
  /** ผู้ดูแลยื่นคำขอ — id ของแถวนี้ = id ของคำขอ */
  REQUEST: 'profession_change_request',
  /** ผู้ดูแลยกเลิกเอง */
  CANCEL: 'profession_change_cancel',
  /** แอดมินอนุมัติ (ทรานแซคชันเดียวกับ UPDATE caregivers.profession) */
  APPROVE: 'profession_change_approve',
  /** แอดมินปฏิเสธ (field_changes[0].reason = เหตุผล) */
  REJECT: 'profession_change_reject',
} as const;

/** แถว "ตัดสิน" แต่ละชนิด → สถานะของคำขอ (ไม่มีแถวตัดสิน = pending) */
export const DECISION_ACTION_TO_STATUS: Record<string, ProfessionChangeStatus> =
  {
    [PROFESSION_CHANGE_ACTION.CANCEL]: ProfessionChangeStatus.cancelled,
    [PROFESSION_CHANGE_ACTION.APPROVE]: ProfessionChangeStatus.approved,
    [PROFESSION_CHANGE_ACTION.REJECT]: ProfessionChangeStatus.rejected,
  };
