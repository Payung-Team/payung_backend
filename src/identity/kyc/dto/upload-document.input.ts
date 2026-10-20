import { InputType, Field, Int } from '@nestjs/graphql';
import { IsDate, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength } from 'class-validator';

@InputType()
export class UploadDocumentInput {
  @Field({ description: 'Document type: id_card_front | id_card_selfie | certificate | professional_license | driving_license' })
  @IsString()
  @IsNotEmpty()
  @IsIn(['id_card_front', 'id_card_selfie', 'certificate', 'professional_license', 'driving_license'], {
    message: 'ประเภทเอกสารไม่ถูกต้อง',
  })
  docType!: string;

  /**
   * ที่อยู่ไฟล์ใน Supabase Storage — ส่งเป็น storage path (`<uid>/<file>`) ได้เลย
   * หรือส่ง URL เต็มของโปรเจกต์มาก็ได้ (เข้ากันได้กับ FE เดิม) แต่ฝั่ง server
   * จะแปลงเป็น path เสมอ
   *
   * ⚠️ ห้ามใช้ @IsUrl เป็นด่านความปลอดภัย — มันผ่าน https://example.com/id-card.jpg
   *    ซึ่งเคยหลุดลง DB จริงมาแล้ว การตรวจตัวจริงอยู่ที่ normalizeKycStoragePath()
   *    ใน KycDocumentService ซึ่งรู้ว่า "ใครเป็นคนเรียก" จึงเช็คเจ้าของโฟลเดอร์ได้
   */
  @Field({ description: 'Storage path (<uid>/<file>) หรือ URL เต็มของ bucket kyc-documents' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024, { message: 'เส้นทางไฟล์ยาวเกินกำหนด' })
  fileUrl!: string;

  @Field({ description: 'Original file name' })
  @IsString()
  @IsNotEmpty()
  fileName!: string;

  @Field(() => Int, { description: 'File size in bytes' })
  @IsInt()
  @Max(5 * 1024 * 1024, { message: 'ไฟล์ต้องไม่เกิน 5MB' })
  fileSize!: number;

  @Field({ description: 'MIME type: image/jpeg | image/png | application/pdf' })
  @IsString()
  @IsIn(['image/jpeg', 'image/png', 'application/pdf'], {
    message: 'ประเภทไฟล์ไม่รองรับ (รองรับ JPG, PNG, PDF)',
  })
  mimeType!: string;

  /**
   * PYG-587: เลขใบประกอบวิชาชีพ — บังคับเมื่อ docType = professional_license
   * ⚠ optional ที่ชั้น schema โดยตั้งใจ และ **ไม่มี** @IsNotEmpty/@MinLength: ความครบถ้วนตรวจที่ service
   *   เพื่อตอบ error code ของ contract (422) — decorator ตรงนี้จะตอบ BAD_REQUEST ก่อนถึง service (PYG-415)
   */
  @Field({
    nullable: true,
    description: 'Professional license number (required when docType = professional_license; trimmed, max 50)',
  })
  @IsOptional()
  @IsString()
  licenseNumber?: string;

  /**
   * PYG-587/597: วันหมดอายุ — บังคับเมื่อ docType = professional_license หรือ driving_license
   * (ใบขับขี่: วันหมดอายุเป็นวันนี้ยังรับ · ผ่านมาแล้วตอบ DRIVING_LICENSE_EXPIRED)
   * ส่ง 'YYYY-MM-DD' หรือ ISO ก็ได้ — server ใช้วันที่ตามปฏิทินไทย (Asia/Bangkok) และเก็บเป็นสิ้นวันนั้น
   */
  @Field({
    nullable: true,
    description: 'Document expiry date (Asia/Bangkok calendar day; must be after today)',
  })
  @IsOptional()
  @IsDate()
  expiresAt?: Date;
}
