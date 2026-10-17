/**
 * ProfessionChangeRequest — คำขอเปลี่ยนวิชาชีพหลัง KYC อนุมัติ (PYG-556 · S01-AC6 · contract PYG-573 §4)
 *
 * ชื่อ field ตรงกับ REQUEST_FIELDS ใน FE (src/graphql/professionChange.ts) ทุกตัว — FE ไม่ต้องแก้ query
 *
 * ข้อมูลไม่ได้อยู่ในตารางของตัวเอง — ประกอบจากแถวใน caregiver_edit_logs (ดู ProfessionChangeService)
 */
import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import {
  CaregiverProfession,
  ProfessionChangeStatus,
} from '../profession.constants';
import { KycDocument } from './kyc-document.entity';

@ObjectType({
  description: 'คำขอเปลี่ยนวิชาชีพของผู้ดูแลที่ KYC อนุมัติแล้ว (รอแอดมินตรวจ)',
})
export class ProfessionChangeRequest {
  /** = id ของแถว profession_change_request ใน caregiver_edit_logs */
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  caregiverId!: string;

  /** วิชาชีพ ณ ตอนยื่นคำขอ */
  @Field(() => CaregiverProfession)
  fromProfession!: CaregiverProfession;

  @Field(() => CaregiverProfession)
  toProfession!: CaregiverProfession;

  @Field(() => ProfessionChangeStatus)
  status!: ProfessionChangeStatus;

  /**
   * ใบประกอบวิชาชีพ 3 field — มาพร้อม S03 (PYG-558) ตอนนี้ null เสมอ
   * มีใน type ตั้งแต่ตอนนี้เพื่อให้ query ของ FE validate ผ่านโดยไม่ต้องแก้
   */
  @Field(() => String, {
    nullable: true,
    description: 'S03 (PYG-558) — ตอนนี้ null เสมอ',
  })
  licenseNumber?: string | null;

  @Field(() => String, {
    nullable: true,
    description: "S03 (PYG-558) — 'YYYY-MM-DD' · ตอนนี้ null เสมอ",
  })
  licenseExpiresAt?: string | null;

  @Field(() => KycDocument, {
    nullable: true,
    description: 'S03 (PYG-558) — ตอนนี้ null เสมอ',
  })
  licenseDocument?: KycDocument | null;

  /** มีเฉพาะ status = rejected */
  @Field(() => String, { nullable: true })
  rejectionReason?: string | null;

  @Field()
  requestedAt!: Date;

  /** เวลาที่แอดมินตัดสิน (approved / rejected) — pending / cancelled = null */
  @Field(() => Date, { nullable: true })
  reviewedAt?: Date | null;
}

/** แถวในคิวตรวจของแอดมิน — เพิ่มข้อมูลผู้ดูแลกับผู้ตัดสิน */
@ObjectType({ description: 'คำขอเปลี่ยนวิชาชีพในคิวตรวจของแอดมิน' })
export class AdminProfessionChangeRequest extends ProfessionChangeRequest {
  @Field(() => String, { nullable: true })
  caregiverNumber?: string | null;

  @Field()
  caregiverName!: string;

  /** ชื่อแอดมินที่ตัดสิน (approved / rejected) */
  @Field(() => String, { nullable: true })
  reviewerName?: string | null;
}

@ObjectType({ description: 'คิวคำขอเปลี่ยนวิชาชีพแบบแบ่งหน้า' })
export class AdminProfessionChangeRequestPage {
  @Field(() => [AdminProfessionChangeRequest])
  items!: AdminProfessionChangeRequest[];

  @Field(() => Int)
  total!: number;

  @Field(() => Int)
  page!: number;

  @Field(() => Int)
  totalPages!: number;
}
