/**
 * DTO ของการตรวจใบประกอบวิชาชีพ (PYG-587 · contract PYG-585)
 */
import { Field, ID, InputType, ObjectType } from '@nestjs/graphql';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

@InputType()
export class RejectLicenseInput {
  @Field(() => ID, { description: 'kyc_documents.id ของใบประกอบฯ (LicenseInfo.documentId)' })
  @IsUUID('all', { message: 'documentId ต้องเป็น UUID' })
  documentId!: string;

  /**
   * ⚠ nullable ที่ชั้น schema + ไม่มี @IsNotEmpty โดยตั้งใจ — ความว่าง/มีแต่ช่องว่างตรวจที่ service
   *   เพื่อตอบ LICENSE_REJECT_REASON_REQUIRED (422) ไม่ใช่ BAD_REQUEST ของ DTO (PYG-415)
   */
  @Field({ nullable: true, description: 'Reason shown to the caregiver (required — blank is rejected)' })
  @IsOptional()
  @IsString({ message: 'reason ต้องเป็นข้อความ' })
  @MaxLength(500, { message: 'เหตุผลต้องไม่เกิน 500 ตัวอักษร' })
  reason?: string;
}

@ObjectType({ description: 'Result of approving or rejecting a professional license' })
export class LicenseReviewResult {
  @Field(() => ID)
  documentId!: string;

  @Field(() => ID)
  caregiverId!: string;

  @Field({ description: 'approved | rejected' })
  status!: string;

  @Field()
  reviewedAt!: Date;
}
