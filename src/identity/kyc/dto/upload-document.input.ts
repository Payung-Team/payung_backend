import { InputType, Field, Int } from '@nestjs/graphql';
import { IsIn, IsInt, IsNotEmpty, IsString, Max, MaxLength } from 'class-validator';

@InputType()
export class UploadDocumentInput {
  @Field({ description: 'Document type: id_card_front | id_card_selfie | certificate' })
  @IsString()
  @IsNotEmpty()
  @IsIn(['id_card_front', 'id_card_selfie', 'certificate'], {
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
}
