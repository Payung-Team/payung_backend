/* eslint-disable @typescript-eslint/no-unsafe-call */
/**
 * UpdateProfileInput — DTO สำหรับ updateProfile mutation
 *
 * ใช้อัปเดตโปรไฟล์ user (displayName, phone, address, bio, avatarUrl)
 * ทุก field เป็น optional — ส่งเฉพาะ field ที่ต้องการเปลี่ยน (partial update)
 */
import { InputType, Field } from '@nestjs/graphql';
import { IsOptional, IsString, IsUrl, MaxLength, MinLength } from 'class-validator';

@InputType()
export class UpdateProfileInput {
  /** ชื่อที่แสดงในแอป — 1-50 ตัวอักษร */
  @Field({ nullable: true, description: 'Display name of the user' })
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'Display name must not be empty' })
  @MaxLength(50, { message: 'Display name must be at most 50 characters' })
  displayName?: string;

  /** เบอร์โทรศัพท์ — 0-10 ตัวอักษร */
  @Field({ nullable: true, description: 'Phone number' })
  @IsOptional()
  @IsString()
  @MaxLength(10, { message: 'Phone number must be at most 10 characters' })
  phone?: string;

  /** ที่อยู่ — 0-200 ตัวอักษร */
  @Field({ nullable: true, description: 'User address' })
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: 'Address must be at most 200 characters' })
  address?: string;

  /** ตำบล/แขวง — 0-100 ตัวอักษร */
  @Field({ nullable: true, description: 'Sub-district (ตำบล/แขวง)' })
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: 'Sub-district must be at most 100 characters' })
  subDistrict?: string;

  /** อำเภอ/เขต — 0-100 ตัวอักษร */
  @Field({ nullable: true, description: 'District (อำเภอ/เขต)' })
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: 'District must be at most 100 characters' })
  district?: string;

  /** จังหวัด — 0-100 ตัวอักษร */
  @Field({ nullable: true, description: 'Province (จังหวัด)' })
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: 'Province must be at most 100 characters' })
  province?: string;

  /** รหัสไปรษณีย์ — 0-10 ตัวอักษร */
  @Field({ nullable: true, description: 'Postal code (รหัสไปรษณีย์)' })
  @IsOptional()
  @IsString()
  @MaxLength(10, { message: 'Postal code must be at most 10 characters' })
  postalCode?: string;

  /** เกี่ยวกับตัวเอง — 0-300 ตัวอักษร */
  @Field({ nullable: true, description: 'Bio or personal description' })
  @IsOptional()
  @IsString()
  @MaxLength(300, { message: 'Bio must be at most 300 characters' })
  bio?: string;

  /** URL รูปโปรไฟล์ — ต้องเป็น URL ที่ถูกต้อง */
  @Field({ nullable: true, description: 'Avatar image URL' })
  @IsOptional()
  @IsUrl({}, { message: 'Avatar URL must be a valid URL' })
  @MaxLength(500, { message: 'Avatar URL must be at most 500 characters' })
  avatarUrl?: string;
}
