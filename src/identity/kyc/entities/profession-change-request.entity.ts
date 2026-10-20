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
   * ใบประกอบวิชาชีพที่แนบมากับคำขอ (PYG-663) — null เมื่อวิชาชีพใหม่ไม่ต้องมีใบ หรือคำขอเก่าก่อน PYG-663
   * licenseDocument ไม่มี signedUrl โดยตั้งใจ: ไฟล์ดูได้ที่ kycStatus (เจ้าของ) / adminKycDetail (แอดมิน · ลง audit)
   */
  @Field(() => String, {
    nullable: true,
    description:
      'License number of the attached professional license (null when none)',
  })
  licenseNumber?: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      "Expiry of the attached license 'YYYY-MM-DD' (Asia/Bangkok) · null when none",
  })
  licenseExpiresAt?: string | null;

  @Field(() => KycDocument, {
    nullable: true,
    description:
      'Attached professional license (no signedUrl here — view it via kycStatus / adminKycDetail)',
  })
  licenseDocument?: KycDocument | null;

  /** ภายใน (ไม่อยู่ใน GraphQL) — id ใบที่แนบ อ่านจาก field_changes ของแถว request */
  licenseDocumentId?: string | null;

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
