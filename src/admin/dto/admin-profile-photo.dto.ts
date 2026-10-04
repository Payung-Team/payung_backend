/**
 * DTO ของการรีวิวรูปโปรไฟล์ผู้ดูแล (PYG-508 / การ์ดแม่ PYG-488)
 *
 * - AdminProfilePhotoQueueInput / Payload — คิว "รูปโปรไฟล์รออนุมัติ"
 *   (รวมผู้ดูแลที่ verified แล้วแต่เปลี่ยนรูป — คิว KYC เดิมกรองด้วย kycStatus จึงไม่เห็นคนกลุ่มนี้)
 * - AdminProfilePhotoReviewPayload — หน้าเทียบใบหน้า: รูปที่รออนุมัติ + รูปบัตร + รูปที่อนุมัติไว้เดิม
 * - RejectProfilePhotoInput — ปฏิเสธต้องมีเหตุผลเสมอ
 * - ProfilePhotoReviewResult — ผลของ approve / reject
 */
import { Field, ID, InputType, Int, ObjectType } from '@nestjs/graphql';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Caregiver } from '../../identity/kyc/entities/caregiver.entity';
import { KycDocument } from '../../identity/kyc/entities/kyc-document.entity';
import { KycReview } from '../../identity/kyc/entities/kyc-review.entity';

@InputType()
export class AdminProfilePhotoQueueInput {
  @Field({ nullable: true, description: 'Search by caregiver full name (case-insensitive partial match)' })
  @IsOptional()
  @IsString({ message: 'search ต้องเป็นข้อความ' })
  search?: string;

  @Field(() => Int, { nullable: true, description: 'Page number (1-based). Defaults to 1.' })
  @IsOptional()
  @IsInt({ message: 'page ต้องเป็นจำนวนเต็ม' })
  @Min(1, { message: 'page ต้องไม่น้อยกว่า 1' })
  page?: number;

  @Field(() => Int, { nullable: true, description: 'Items per page (default: 20, max: 100).' })
  @IsOptional()
  @IsInt({ message: 'limit ต้องเป็นจำนวนเต็ม' })
  @Min(1, { message: 'limit ต้องไม่น้อยกว่า 1' })
  @Max(100, { message: 'limit ต้องไม่เกิน 100' })
  limit?: number;
}

@ObjectType({ description: 'A caregiver profile photo awaiting admin review' })
export class ProfilePhotoQueueItem {
  @Field(() => ID, { description: 'kyc_documents.id of the pending profile photo' })
  documentId!: string;

  @Field(() => ID)
  caregiverId!: string;

  @Field({ nullable: true })
  caregiverNumber?: string;

  @Field()
  fullName!: string;

  @Field()
  email!: string;

  /** สถานะ KYC ของผู้ดูแล — 'verified' = เปลี่ยนรูปหลังผ่าน KYC แล้ว */
  @Field({ description: 'Caregiver KYC status: none | pending | verified | rejected' })
  kycStatus!: string;

  @Field({ description: 'When the pending photo was uploaded' })
  uploadedAt!: Date;

  /** มีรูปที่อนุมัติแล้วอยู่ก่อน = กำลังขอเปลี่ยนรูป */
  @Field({ description: 'True if the caregiver already has an approved profile photo' })
  hasApprovedPhoto!: boolean;
}

@ObjectType({ description: 'Paginated queue of pending caregiver profile photos' })
export class AdminProfilePhotoQueuePayload {
  @Field(() => [ProfilePhotoQueueItem])
  items!: ProfilePhotoQueueItem[];

  @Field(() => Int)
  total!: number;

  @Field(() => Int)
  page!: number;

  @Field(() => Int)
  totalPages!: number;
}

@ObjectType({ description: 'A profile photo document with a short-lived signed URL' })
export class ProfilePhotoDocument {
  @Field(() => ID)
  documentId!: string;

  @Field({ description: 'pending | approved | rejected' })
  reviewStatus!: string;

  @Field({ nullable: true, description: 'Signed URL (1 hr) — null if signing failed' })
  signedUrl?: string;

  @Field()
  uploadedAt!: Date;
}

@ObjectType({ description: 'Everything an admin needs to compare a profile photo with the ID card' })
export class AdminProfilePhotoReviewPayload {
  /** ข้อมูลผู้ดูแล — ใช้ชื่อตามบัตรเทียบกับรูป */
  @Field(() => Caregiver)
  caregiver!: Caregiver;

  /** รูปที่รออนุมัติ — null ถ้าไม่มีใบที่ pending (ตัดสินไปแล้ว / ยังไม่อัปโหลด) */
  @Field(() => ProfilePhotoDocument, { nullable: true })
  pendingPhoto?: ProfilePhotoDocument;

  /** signed URL ของรูปที่อนุมัติอยู่ตอนนี้ (users.avatar_url) — null ถ้ายังไม่เคยมี */
  @Field({ nullable: true, description: 'Signed URL of the currently approved photo' })
  approvedPhotoUrl?: string;

  /** เอกสารบัตรประชาชน (id_card_front / id_card_selfie) พร้อม signed URL — ลง audit ทุกครั้ง */
  @Field(() => [KycDocument])
  idCardDocuments!: KycDocument[];

  /** ประวัติรีวิวรูปโปรไฟล์ของผู้ดูแลคนนี้ เรียงล่าสุดก่อน */
  @Field(() => [KycReview])
  reviews!: KycReview[];
}

@InputType()
export class RejectProfilePhotoInput {
  @Field(() => ID)
  @IsUUID('all', { message: 'documentId ต้องเป็น UUID' })
  documentId!: string;

  @Field({ description: 'Reason shown to the caregiver (required)' })
  @IsString({ message: 'reason ต้องเป็นข้อความ' })
  @IsNotEmpty({ message: 'ต้องระบุเหตุผลที่ปฏิเสธ' })
  @MaxLength(500, { message: 'เหตุผลต้องไม่เกิน 500 ตัวอักษร' })
  reason!: string;
}

@ObjectType({ description: 'Result of approving or rejecting a profile photo' })
export class ProfilePhotoReviewResult {
  @Field(() => ID)
  documentId!: string;

  @Field(() => ID)
  caregiverId!: string;

  @Field({ description: 'approved | rejected' })
  reviewStatus!: string;

  @Field()
  reviewedAt!: Date;
}
