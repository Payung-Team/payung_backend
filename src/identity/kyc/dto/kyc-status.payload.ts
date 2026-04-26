/**
 * KycStatusPayload — GraphQL output type สำหรับ kycStatus query
 *
 * Return object ที่ประกอบด้วย:
 * - status          : KYC status ปัจจุบัน (none | pending | verified | rejected)
 * - submittedAt     : วันเวลาที่ submit
 * - verifiedAt      : วันเวลาที่ admin approve
 * - rejectedAt      : วันเวลาที่ admin reject (จาก KycReview ล่าสุด)
 * - rejectedReason  : เหตุผลที่ reject
 * - caregiver       : ข้อมูล caregiver profile
 * - documents       : รายการเอกสาร KYC พร้อม signed URL
 */
import { ObjectType, Field } from '@nestjs/graphql';
import { Caregiver } from '../entities/caregiver.entity';
import { KycDocument } from '../entities/kyc-document.entity';

@ObjectType()
export class KycStatusPayload {
  /**
   * สถานะ KYC ปัจจุบัน:
   * - "none"     = ยังไม่เคย submit
   * - "pending"  = submit แล้ว รอ review
   * - "verified" = ผ่านแล้ว
   * - "rejected" = ไม่ผ่าน
   */
  @Field({ description: 'KYC status: none | pending | verified | rejected' })
  status!: string;

  /** วันเวลาที่ submit KYC — null ถ้ายังไม่เคย submit */
  @Field({ nullable: true, description: 'When KYC was submitted' })
  submittedAt?: Date;

  /** วันเวลาที่ admin verify KYC — null ถ้ายังไม่ผ่าน */
  @Field({ nullable: true, description: 'When KYC was verified by admin' })
  verifiedAt?: Date;

  /** วันเวลาที่ admin reject KYC — null ถ้ายังไม่ถูก reject */
  @Field({ nullable: true, description: 'When KYC was rejected by admin' })
  rejectedAt?: Date;

  /** เหตุผลที่ reject — null ถ้าไม่ถูก reject หรือไม่มีเหตุผล */
  @Field({ nullable: true, description: 'Reason for rejection (if rejected)' })
  rejectedReason?: string;

  /** ข้อมูล caregiver profile — null ถ้ายังไม่เคย submit */
  @Field(() => Caregiver, {
    nullable: true,
    description: 'Caregiver profile (null if never submitted)',
  })
  caregiver?: Caregiver;

  /**
   * รายการเอกสาร KYC พร้อม signed URL (หมดอายุ 1 ชั่วโมง)
   * - array ว่างถ้ายังไม่มีเอกสาร
   */
  @Field(() => [KycDocument], {
    description: 'KYC documents with temporary signed URLs (1hr expiry)',
  })
  documents!: KycDocument[];
}
