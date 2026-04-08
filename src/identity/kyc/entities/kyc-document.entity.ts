/**
 * KycDocument Entity — GraphQL type สำหรับเอกสาร KYC
 *
 * เอกสาร KYC คือไฟล์ที่ caregiver อัปโหลดเพื่อยืนยันตัวตน เช่น:
 * - บัตรประชาชน (id_card)
 * - ใบรับรอง/ใบประกาศ (certificate)
 * - ใบอนุญาต (license)
 * - รูปถ่าย (photo)
 *
 * เอกสารจะถูกอัปโหลดก่อน แล้วค่อย link กับ caregiver ตอน submit KYC
 * ดังนั้น caregiverId จึงเป็น nullable (อาจยังไม่ได้ link)
 */
import { ObjectType, Field, ID, Int } from '@nestjs/graphql';

@ObjectType()
export class KycDocument {
  /** UUID ของเอกสาร */
  @Field(() => ID)
  id!: string;

  /** caregiver ที่เอกสารนี้ผูกอยู่ — null ถ้ายังไม่ได้ submit KYC */
  @Field({ nullable: true, description: 'Caregiver ID (null before KYC submit)' })
  caregiverId?: string;

  /** user ที่อัปโหลดเอกสารนี้ */
  @Field({ description: 'User who uploaded this document' })
  userId!: string;

  /**
   * ประเภทเอกสาร:
   * - "id_card"     = บัตรประชาชน
   * - "certificate" = ใบรับรอง
   * - "license"     = ใบอนุญาต
   * - "photo"       = รูปถ่าย
   */
  @Field({ description: 'Document type: id_card | certificate | license | photo' })
  docType!: string;

  /** URL สำหรับเข้าถึงไฟล์เอกสาร (เช่น Supabase Storage URL) */
  @Field({ description: 'File URL in storage' })
  fileUrl!: string;

  /** ชื่อไฟล์ต้นฉบับที่ผู้ใช้อัปโหลด */
  @Field({ description: 'Original file name' })
  fileName!: string;

  /** ขนาดไฟล์ (หน่วย bytes) — ใช้ตรวจสอบว่าไม่เกิน 10MB */
  @Field(() => Int, { description: 'File size in bytes' })
  fileSize!: number;

  /** MIME type ของไฟล์ เช่น "image/jpeg", "application/pdf" */
  @Field({ description: 'MIME type (e.g. image/jpeg, application/pdf)' })
  mimeType!: string;

  /** วันเวลาที่อัปโหลด */
  @Field({ description: 'Upload timestamp' })
  uploadedAt!: Date;
}
