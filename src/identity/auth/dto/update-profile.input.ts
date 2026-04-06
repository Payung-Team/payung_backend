/* eslint-disable @typescript-eslint/no-unsafe-call */
/**
 * UpdateProfileInput — DTO สำหรับ updateProfile mutation
 *
 * ใช้อัปเดตโปรไฟล์ user (displayName และ/หรือ avatarUrl)
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

  /** URL รูปโปรไฟล์ — ต้องเป็น URL ที่ถูกต้อง */
  @Field({ nullable: true, description: 'Avatar image URL' })
  @IsOptional()
  @IsUrl({}, { message: 'Avatar URL must be a valid URL' })
  @MaxLength(500, { message: 'Avatar URL must be at most 500 characters' })
  avatarUrl?: string;
}
