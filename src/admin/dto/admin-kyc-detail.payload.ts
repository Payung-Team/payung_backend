/**
 * AdminKycDetailPayload — Output type สำหรับ query adminKycDetail
 *
 * ประกอบด้วย:
 * - caregiver   : ข้อมูลโปรไฟล์ครบถ้วนรวม sensitive fields (idCardNumber, phone, bio)
 * - documents   : รายการเอกสาร KYC พร้อม signed URLs (หมดอายุ 1 ชั่วโมง)
 * - reviews     : ประวัติการ review ทั้งหมดของ caregiver คนนี้ เรียงล่าสุดก่อน
 * - resubmitCount : จำนวนครั้งที่ resubmit หลังถูก reject
 */
import { ObjectType, Field, Int } from '@nestjs/graphql';
import { Caregiver } from '../../identity/kyc/entities/caregiver.entity';
import { KycDocument } from '../../identity/kyc/entities/kyc-document.entity';
import { KycReview } from '../../identity/kyc/entities/kyc-review.entity';
import { CaregiverEditLog } from '../../identity/kyc/entities/caregiver-edit-log.entity';

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
}