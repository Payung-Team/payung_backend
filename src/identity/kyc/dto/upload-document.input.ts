import { InputType, Field, Int } from '@nestjs/graphql';
import { IsIn, IsInt, IsNotEmpty, IsString, IsUrl, Max } from 'class-validator';

@InputType()
export class UploadDocumentInput {
  @Field({ description: 'Document type: id_card_front | id_card_selfie | certificate' })
  @IsString()
  @IsNotEmpty()
  @IsIn(['id_card_front', 'id_card_selfie', 'certificate'], {
    message: 'ประเภทเอกสารไม่ถูกต้อง',
  })
  docType!: string;

  @Field({ description: 'File URL in Supabase Storage' })
  @IsString()
  @IsNotEmpty()
  @IsUrl({}, { message: 'URL ไม่ถูกต้อง' })
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
