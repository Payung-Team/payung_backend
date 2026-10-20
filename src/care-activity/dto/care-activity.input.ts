/**
 * Input ของกิจกรรมการดูแล (PYG-634 · contract PYG-632)
 *
 * ★ ตรวจค่าจริงที่ CareActivityService ไม่ใช่ decorator (บทเรียน PYG-415: @Length ใน DTO ตอบ BAD_REQUEST
 *   ก่อนถึง service → FE ไม่ได้ code ตาม contract) · DTO เช็คแค่ชนิด
 * careLevel รับเป็น String ("BASIC") ไม่ใช่ enum — ค่าผิดไปถึง service แล้วได้ CARE_ACTIVITY_INVALID
 */
import { Field, InputType, Int } from '@nestjs/graphql';
import { IsBoolean, IsInt, IsOptional, IsString } from 'class-validator';

@InputType()
export class AdminCareActivitiesFilter {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  category?: string;

  @Field({ nullable: true, description: 'BASIC | INTERMEDIATE | ADVANCED' })
  @IsOptional()
  @IsString()
  careLevel?: string;

  @Field({ nullable: true, description: 'ไม่ส่ง = ทั้งที่เปิดและปิดใช้งาน' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field({ nullable: true, description: 'ค้นในชื่อไทย / อังกฤษ / รหัส' })
  @IsOptional()
  @IsString()
  search?: string;
}

@InputType()
export class CreateCareActivityInput {
  @Field()
  @IsString()
  nameTh!: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  nameEn?: string | null;

  @Field()
  @IsString()
  category!: string;

  @Field({ description: 'BASIC | INTERMEDIATE | ADVANCED' })
  @IsString()
  careLevel!: string;

  @Field(() => Int, { nullable: true, description: 'ไม่ส่ง = ต่อท้ายหมวด' })
  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

@InputType()
export class UpdateCareActivityInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  nameTh?: string;

  @Field(() => String, { nullable: true, description: 'ส่ง "" = ลบชื่ออังกฤษ' })
  @IsOptional()
  @IsString()
  nameEn?: string | null;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  category?: string;

  @Field({ nullable: true, description: 'BASIC | INTERMEDIATE | ADVANCED' })
  @IsOptional()
  @IsString()
  careLevel?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  sortOrder?: number;
}
