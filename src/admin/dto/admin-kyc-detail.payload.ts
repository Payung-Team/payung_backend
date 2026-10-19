/**
 * AdminKycDetailPayload — Output type สำหรับ query adminKycDetail
 *
 * ประกอบด้วย:
 * - caregiver   : ข้อมูลโปรไฟล์ครบถ้วนรวม sensitive fields (idCardNumber, phone, bio)
 * - documents   : รายการเอกสาร KYC พร้อม signed URLs (หมดอายุ 1 ชั่วโมง)
 * - reviews     : ประวัติการ review ทั้งหมดของ caregiver คนนี้ เรียงล่าสุดก่อน
 * - resubmitCount : จำนวนครั้งที่ resubmit หลังถูก reject
 */
import { ObjectType, Field, ID, Int } from '@nestjs/graphql';
import { Caregiver } from '../../identity/kyc/entities/caregiver.entity';
import { KycDocument } from '../../identity/kyc/entities/kyc-document.entity';
import { KycReview } from '../../identity/kyc/entities/kyc-review.entity';
import { CaregiverEditLog } from '../../identity/kyc/entities/caregiver-edit-log.entity';
import { PayoutAccountSummary } from '../../identity/kyc/entities/payout-account.entity';
import { DrivingLicenseInfo } from '../../identity/kyc/driving-license/driving-license-info.entity';
import { LicenseInfo } from '../../identity/kyc/license/license-info.entity';
import { CaregiverCareLevelInfo } from './care-level.dto';

/** PYG-266: payout summary สำหรับ admin — เพิ่ม hasOmiseRecipient เหนือ base summary */
@ObjectType({ description: 'Caregiver payout bank account summary for admin review' })
export class AdminPayoutAccountSummary extends PayoutAccountSummary {
  @Field(() => Boolean) hasOmiseRecipient!: boolean;
}

@ObjectType({ description: 'Full KYC detail for a single caregiver (admin only)' })
export class AdminKycDetailPayload {
    /** ข้อมูลโปรไฟล์ caregiver ครบถ้วน */
    @Field(() => Caregiver, { description: 'Caregiver profile' })
    caregiver!: Caregiver;

    /** รายการเอกสาร KYC พร้อม signed URLs (หมดอายุ 1 ชั่วโมง) */
    @Field(() => [KycDocument], { description: 'KYC documents with signed URLs (1hr expiry)' })
    documents!: KycDocument[];

    /** ประวัติการ review ทั้งหมด เรียงล่าสุดก่อน */
    @Field(() => [KycReview], { description: 'Review history, newest first' })
    reviews!: KycReview[];

    /** จำนวนครั้งที่ resubmit KYC หลังถูก reject */
    @Field(() => Int, { description: 'Number of times KYC was resubmitted after rejection' })
    resubmitCount!: number;

    /** ประวัติการแก้ไขข้อมูล/เอกสารของ caregiver — admin เห็นว่าแก้อะไรบ้าง เรียงล่าสุดก่อน */
    @Field(() => [CaregiverEditLog], { description: 'Edit history showing field changes, newest first' })
    editHistory!: CaregiverEditLog[];

    /** บัญชีธนาคารรับเงิน (masked) — undefined ถ้า caregiver ยังไม่เคยกรอก (optional) */
    @Field(() => AdminPayoutAccountSummary, {
        nullable: true,
        description: 'Payout bank account summary (masked — never the full account number)',
    })
    payoutAccount?: AdminPayoutAccountSummary;

    /** PYG-508: kyc_documents.id ของรูปโปรไฟล์ที่รออนุมัติ — null ถ้าไม่มี (FE ใช้ลิงก์ไปหน้ารีวิวรูป) */
    @Field(() => ID, {
        nullable: true,
        description: 'Pending profile photo document id (null if none awaiting review)',
    })
    pendingProfilePhotoDocumentId?: string;

    /** PYG-587: วิชาชีพของผู้ดูแล */
    @Field({ nullable: true, description: 'Caregiver profession: general_caregiver | nurse | physiotherapist' })
    profession?: string;

    /** PYG-587: ใบประกอบฯ ล่าสุด — เลข ไฟล์ (signed URL) วันหมดอายุ สถานะ เหตุผลปฏิเสธ · null ถ้าไม่เคยแนบ */
    @Field(() => LicenseInfo, { nullable: true, description: 'Latest professional license for review' })
    license?: LicenseInfo;

    /** PYG-597: ใบขับขี่ - ผลตรวจ ไฟล์ (signed URL) วันหมดอายุ isExpired เหตุผลปฏิเสธล่าสุด */
    @Field(() => DrivingLicenseInfo, { description: 'Driving license review info (status none when never uploaded)' })
    drivingLicense!: DrivingLicenseInfo;

    /** PYG-597: ประวัติการตรวจใบขับขี่ทุกรอบ ใหม่สุดก่อน (อนุมัติ/ปฏิเสธ + เหตุผล) */
    @Field(() => [KycReview], { description: 'Driving license review history, newest first' })
    drivingLicenseReviews!: KycReview[];

    /**
     * PYG-581: ระดับปัจจุบัน + ผู้กำหนด + เวลา (S02-AC3) — ไม่เป็น null เสมอ
     * ยังไม่มีระดับ = level เป็น null · ค่าเริ่มต้นจาก migration ที่ยังไม่ทบทวน = needsReview เป็น true (E3)
     */
    @Field(() => CaregiverCareLevelInfo, {
        description: 'Current care level with who set it and when (level is null when not set yet)',
    })
    careLevelInfo!: CaregiverCareLevelInfo;
}
