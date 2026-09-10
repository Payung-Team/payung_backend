import { gender_enum, mobility_level } from '@prisma/client';
import {
  GenderLabel,
  PatientProfileDto,
  SupportLevelLabel,
} from './dto/patient-profile.dto';

/**
 * PYG-460 — แปลงระหว่าง "รูปทรงที่หน้าบ้านใช้" กับ "คอลัมน์จริงในตาราง care_recipients"
 *
 * ทั้งไฟล์นี้มีอยู่เพราะสองฝั่งพูดคนละภาษาโดยตั้งใจ:
 *   FE เก็บข้อความไทยเป็น id ของตัวเลือก (ปุ่มแสดงผลตรง ๆ ไม่ต้องมี dictionary)
 *   DB เก็บ enum อังกฤษ (query ได้ บังคับชุดค่าได้ ไม่ผูกกับภาษา UI)
 * ตาราง mapping จึงต้องมีที่ไหนสักที่ — ให้อยู่ที่นี่ที่เดียว ไม่ใช่กระจายใน service
 */

// ── เพศ ──────────────────────────────────────────────────────────────────────
const GENDER_TO_DB: Record<GenderLabel, gender_enum> = {
  ชาย:  'male',
  หญิง: 'female',
};

const GENDER_TO_LABEL: Record<gender_enum, GenderLabel> = {
  male:   'ชาย',
  female: 'หญิง',
};

// ── ระดับการช่วยเหลือตนเอง ───────────────────────────────────────────────────
const MOBILITY_TO_DB: Record<SupportLevelLabel, mobility_level> = {
  'ช่วยเหลือตัวเองได้ดี':                              'independent',
  'ช่วยเหลือตัวเองได้เล็กน้อย / ต้องการการช่วยพยุงเดิน': 'assisted',
  'ช่วยเหลือตัวเองไม่ได้ / ติดเตียง':                   'bedridden',
  'ใช้รถเข็น':                                        'wheelchair',
};

/**
 * ขากลับ DB → FE
 *
 * ⚠ 'wheelchair' ไม่มีปุ่มให้เลือกใน BookingStepPatient วันนี้ (FE มี 3 ตัวเลือก)
 *   ยังคืนค่าตามจริงแทนที่จะยัดให้เป็น 'assisted' เพราะการโกหกระดับการช่วยเหลือ
 *   ของคนไข้เพื่อให้ปุ่มไฮไลต์สวย ๆ อันตรายกว่าการที่ผู้ใช้เห็นว่าไม่มีปุ่มไหนถูกเลือก
 *   พฤติกรรมที่ได้: ฟอร์มบังคับให้เลือกใหม่ ซึ่งเป็นการยืนยันโดยคนจริง ไม่ใช่การเดาโดยโค้ด
 */
const MOBILITY_TO_LABEL: Record<mobility_level, SupportLevelLabel> = {
  independent: 'ช่วยเหลือตัวเองได้ดี',
  assisted:    'ช่วยเหลือตัวเองได้เล็กน้อย / ต้องการการช่วยพยุงเดิน',
  bedridden:   'ช่วยเหลือตัวเองไม่ได้ / ติดเตียง',
  wheelchair:  'ใช้รถเข็น',
};

// ── อายุ ↔ วันเกิด ───────────────────────────────────────────────────────────
//
// ★ จุดเดียวในระบบที่รู้เรื่องการแปลงนี้ — ถ้า Siwali สรุปว่าให้เก็บอายุดิบ
//   (เพิ่มคอลัมน์ age_years) ให้แก้แค่สองฟังก์ชันข้างล่าง ที่เหลือไม่ต้องแตะ
//
// ฟอร์มถามแค่ "อายุ" ไม่ได้ถามวันเกิด → ความละเอียดที่มีจริงคือระดับปีเท่านั้น
// เก็บเป็น 1 ม.ค. ของปีเกิดโดยประมาณ แล้วอ่านกลับด้วยการลบปี เพื่อให้ค่าที่ผู้ใช้
// กรอก 72 อ่านกลับมาได้ 72 ในปีเดียวกันเสมอ (round-trip ไม่เพี้ยน)
//
// ⚠ ข้อจำกัดที่ยอมรับ: คนที่เกิดปลายปีจะถูกนับอายุเกินจริงได้ 1 ปีหลังขึ้นปีใหม่
//   ซึ่งเป็นความคลาดเคลื่อนแบบเดียวกับที่ฟอร์มมีอยู่แล้ว (ถามอายุ ไม่ถามวันเกิด)
//   แต่ต่างตรงที่แบบนี้ "เก่าลงเองตามเวลา" ถูกต้อง ส่วนการเก็บเลขดิบจะค้างอยู่ที่ 72 ตลอดไป

export function ageToDateOfBirth(age: number): Date {
  return new Date(Date.UTC(new Date().getUTCFullYear() - age, 0, 1));
}

export function dateOfBirthToAge(dob: Date | null | undefined): number | undefined {
  if (!dob) return undefined;
  return new Date().getUTCFullYear() - dob.getUTCFullYear();
}

// ── รูปทรงคอลัมน์ที่ service เขียนลง care_recipients ──────────────────────────

/** คอลัมน์สุขภาพทั้งหมดที่ mapper แตะ — ใช้เป็น select ฝั่งอ่านด้วย */
export const PATIENT_PROFILE_SELECT = {
  date_of_birth:       true,
  gender:              true,
  weight_kg:           true,
  height_cm:           true,
  mobility_level:      true,
  medical_conditions:  true,
  current_medications: true,
  allergies:           true,
  blood_type:          true,
  care_notes:          true,
  preferred_hospital:  true,
} as const;

/** รูปทรงแถวที่ toPatientProfile รับได้ (subset ของ CareRecipient) */
export interface PatientProfileRow {
  date_of_birth:       Date | null;
  gender:              gender_enum | null;
  weight_kg:           unknown;   // Prisma.Decimal | null
  height_cm:           unknown;   // Prisma.Decimal | null
  mobility_level:      mobility_level | null;
  medical_conditions:  string[];
  current_medications: string | null;
  allergies:           string | null;
  blood_type:          string | null;
  care_notes:          string | null;
  preferred_hospital:  string | null;
}

/** Prisma คืน Decimal มา ไม่ใช่ number — JSON.stringify ตรง ๆ จะได้ string */
function decimalToNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = typeof (value as { toNumber?: () => number }).toNumber === 'function'
    ? (value as { toNumber: () => number }).toNumber()
    : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * FE → DB
 *
 * คืนเฉพาะคีย์ที่ "ส่งมาจริง" เพื่อให้ใช้กับ update ได้โดยไม่ล้างค่าเดิมทิ้ง
 * (ส่ง {age: 72} มาอย่างเดียว ต้องไม่ทำให้ allergies ที่เคยกรอกไว้กลายเป็น null)
 */
export function toCareRecipientColumns(
  profile: PatientProfileDto,
): Record<string, unknown> {
  const cols: Record<string, unknown> = {};

  if (profile.age              !== undefined) cols.date_of_birth       = ageToDateOfBirth(profile.age);
  if (profile.gender           !== undefined) cols.gender              = GENDER_TO_DB[profile.gender];
  if (profile.weight           !== undefined) cols.weight_kg           = profile.weight;
  if (profile.height           !== undefined) cols.height_cm           = profile.height;
  if (profile.supportLevel     !== undefined) cols.mobility_level      = MOBILITY_TO_DB[profile.supportLevel];
  if (profile.conditions       !== undefined) cols.medical_conditions  = profile.conditions;
  if (profile.medicines        !== undefined) cols.current_medications = profile.medicines;
  if (profile.allergies        !== undefined) cols.allergies           = profile.allergies;
  if (profile.bloodGroup       !== undefined) cols.blood_type          = profile.bloodGroup;
  if (profile.careInstructions !== undefined) cols.care_notes          = profile.careInstructions;
  if (profile.regularHospital  !== undefined) cols.preferred_hospital  = profile.regularHospital;

  return cols;
}

/**
 * DB → FE
 *
 * คืน undefined เมื่อโปรไฟล์ยังไม่มีข้อมูลสุขภาพสักช่อง เพื่อให้ตรงกับที่ FE
 * ประกาศไว้ว่า details เป็น optional (SavedRecipient.details) — ส่ง object เปล่า
 * ไปจะทำให้ handleSelectRecipient ล้างช่องที่ผู้ใช้กรอกค้างไว้ทิ้งโดยไม่จำเป็น
 */
export function toPatientProfile(row: PatientProfileRow): PatientProfileDto | undefined {
  const profile: PatientProfileDto = {
    age:              dateOfBirthToAge(row.date_of_birth),
    gender:           row.gender         ? GENDER_TO_LABEL[row.gender]           : undefined,
    weight:           decimalToNumber(row.weight_kg),
    height:           decimalToNumber(row.height_cm),
    supportLevel:     row.mobility_level ? MOBILITY_TO_LABEL[row.mobility_level] : undefined,
    bloodGroup:       row.blood_type          ?? undefined,
    conditions:       row.medical_conditions?.length ? row.medical_conditions : undefined,
    medicines:        row.current_medications ?? undefined,
    allergies:        row.allergies           ?? undefined,
    careInstructions: row.care_notes          ?? undefined,
    regularHospital:  row.preferred_hospital  ?? undefined,
  };

  const hasAny = Object.values(profile).some((v) => v !== undefined);
  return hasAny ? profile : undefined;
}
