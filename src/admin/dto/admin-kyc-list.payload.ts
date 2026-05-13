/**
 * AdminKycListPayload — Output types สำหรับ query adminKycList
 *
 * Types:
 * - CaregiverKycSummary : ข้อมูลสรุปของ caregiver แต่ละคน (ไม่ expose sensitive fields)
 * - AdminKycListPayload : paginated response
 */
import { ObjectType, Field, ID, Int } from '@nestjs/graphql';

/**
 * CaregiverKycSummary — ข้อมูลสรุปของ caregiver 1 คน สำหรับแสดงใน admin KYC list
 *
 * เลือกเฉพาะ fields ที่ admin ต้องการดูในตาราง ไม่ expose sensitive data เช่น idCardNumber
 */
@ObjectType({ description: 'Summary of a caregiver KYC submission for admin review' })
export class CaregiverKycSummary {
  /** UUID ของ caregiver record */
  @Field(() => ID, { description: 'Caregiver UUID' })
  id!: string;

  /** ชื่อ-นามสกุลเต็ม */
  @Field({ description: 'Caregiver full name' })
  fullName!: string;

  /**
   * สถานะ KYC ปัจจุบัน
   * ค่าที่เป็นไปได้: "none" | "pending" | "verified" | "rejected"
   */
  @Field({ description: 'Current KYC status: none | pending | verified | rejected' })
  kycStatus!: string;

  /**
   * วันเวลาที่ submit KYC ล่าสุด
   * null = ยังไม่เคย submit
   */
  @Field({ nullable: true, description: 'When KYC was last submitted' })
  submittedAt?: Date;

  /**
   * จำนวนเอกสาร KYC ที่ upload ไว้ (เพื่อให้ admin รู้ว่ามีเอกสารให้ review กี่ชิ้น)
   */
  @Field(() => Int, { description: 'Number of KYC documents uploaded' })
  documentCount!: number;
}

/**
 * AdminKycListPayload — Paginated response สำหรับ adminKycList query
 */
@ObjectType({ description: 'Paginated KYC submission list for admin' })
export class AdminKycListPayload {
  /** รายการ caregiver ในหน้านี้ */
  @Field(() => [CaregiverKycSummary], { description: 'Caregiver KYC summaries for the current page' })
  items!: CaregiverKycSummary[];

  /** จำนวนรายการทั้งหมดที่ตรงกับ filter (ก่อน paginate) */
  @Field(() => Int, { description: 'Total number of matching caregivers' })
  total!: number;

  /** หน้าปัจจุบัน (1-based) */
  @Field(() => Int, { description: 'Current page number (1-based)' })
  page!: number;

  /** จำนวนหน้าทั้งหมด */
  @Field(() => Int, { description: 'Total number of pages' })
  totalPages!: number;
}
