/* eslint-disable @typescript-eslint/no-unsafe-call */
import { InputType, Field, Int, Float } from '@nestjs/graphql';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { ValidThaiPhone } from '../../../common/validators/valid-thai-phone.validator';

/**
 * UpdateCaregiverInput — input สำหรับ updateCaregiverProfile mutation
 *
 * Whitelist fields: bio, hourlyRate, skills, experienceYears, phone
 * Locked fields (fullName, idCardNumber, gender, dateOfBirth) ไม่อยู่ใน DTO นี้
 * → GraphQL reject อัตโนมัติถ้า client ส่ง field ที่ไม่มีใน schema
 *
 * ทุก field optional — partial update (ส่งมาแค่ field ที่อยากเปลี่ยน)
 */
@InputType()
export class UpdateCaregiverInput {
  @Field({ nullable: true, description: 'Short bio / introduction' })
  @IsOptional()
  @IsString({ message: 'bio ต้องเป็นข้อความ' })
  @MaxLength(500, { message: 'bio ต้องไม่เกิน 500 ตัวอักษร' })
  bio?: string;

  @Field(() => Float, { nullable: true, description: 'Hourly rate in THB' })
  @IsOptional()
  @IsNumber({}, { message: 'ค่าบริการต้องเป็นตัวเลข' })
  @Min(0, { message: 'ค่าบริการต้องไม่น้อยกว่า 0 บาท' })
  hourlyRate?: number;

  @Field(() => [String], { nullable: true, description: 'List of caregiver skills' })
  @IsOptional()
  @IsArray({ message: 'ทักษะต้องเป็น array' })
  @ArrayMinSize(1, { message: 'กรุณาเลือกทักษะอย่างน้อย 1 รายการ' })
  @IsString({ each: true, message: 'ทักษะแต่ละรายการต้องเป็นข้อความ' })
  skills?: string[];

  @Field(() => Int, { nullable: true, description: 'Years of caregiving experience' })
  @IsOptional()
  @IsInt({ message: 'จำนวนปีประสบการณ์ต้องเป็นจำนวนเต็ม' })
  @Min(0, { message: 'จำนวนปีประสบการณ์ต้องไม่น้อยกว่า 0' })
  experienceYears?: number;

  @Field({ nullable: true, description: 'Contact phone number (Thai format)' })
  @IsOptional()
  @IsString({ message: 'เบอร์โทรต้องเป็นข้อความ' })
  @ValidThaiPhone({ message: 'เบอร์โทรศัพท์ไม่ถูกต้อง (เช่น 081-234-5678)' })
  phone?: string;

  @Field({ nullable: true, description: 'Address' })
  @IsOptional()
  @IsString({ message: 'ที่อยู่ต้องเป็นข้อความ' })
  address?: string;
}
