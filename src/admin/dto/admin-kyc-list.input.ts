/**
 * AdminKycListInput — Input สำหรับ query adminKycList
 *
 * ใช้กรอง/ค้นหา/paginate รายการ KYC submissions สำหรับหน้า admin dashboard
 *
 * Fields:
 * - status  : กรองตาม KYC status (all | pending | verified | rejected)
 * - search  : ค้นหาชื่อ caregiver (ILIKE)
 * - page    : หน้าที่ต้องการ (เริ่มจาก 1)
 * - limit   : จำนวนรายการต่อหน้า (default 20)
 */
import { InputType, Field, Int, registerEnumType } from '@nestjs/graphql';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** KYC status ที่ admin ใช้กรอง (เพิ่ม "all" สำหรับดูทั้งหมด) */
export enum KycStatusFilter {
  all = 'all',
  pending = 'pending',
  verified = 'verified',
  rejected = 'rejected',
}

registerEnumType(KycStatusFilter, {
  name: 'KycStatusFilter',
  description: 'Filter KYC list by status. Use "all" to return every status.',
  valuesMap: {
    all: { description: 'Return all statuses' },
    pending: { description: 'Awaiting admin review' },
    verified: { description: 'KYC approved' },
    rejected: { description: 'KYC rejected, caregiver can resubmit' },
  },
});

@InputType()
export class AdminKycListInput {
  /**
   * กรองตาม KYC status
   * ถ้าไม่ส่ง → ดึงทุก status (เทียบเท่า "all")
   */
  @Field(() => KycStatusFilter, {
    nullable: true,
    description: 'Filter by KYC status. Omit or use "all" to return every status.',
  })
  @IsOptional()
  @IsEnum(KycStatusFilter, { message: 'status ต้องเป็น all | pending | verified | rejected' })
  status?: KycStatusFilter;

  /**
   * ค้นหาด้วยชื่อ caregiver (ILIKE — case-insensitive partial match)
   * เช่น search = "สมชาย" จะหา fullName ที่มีคำว่า "สมชาย"
   */
  @Field({ nullable: true, description: 'Search by caregiver full name (case-insensitive partial match)' })
  @IsOptional()
  @IsString({ message: 'search ต้องเป็นข้อความ' })
  search?: string;

  /**
   * หน้าที่ต้องการ (เริ่มจาก 1)
   * default = 1
   */
  @Field(() => Int, {
    nullable: true,
    description: 'Page number (1-based). Defaults to 1.',
  })
  @IsOptional()
  @IsInt({ message: 'page ต้องเป็นจำนวนเต็ม' })
  @Min(1, { message: 'page ต้องไม่น้อยกว่า 1' })
  page?: number;

  /**
   * จำนวนรายการต่อหน้า
   * default = 20, สูงสุด = 100
   */
  @Field(() => Int, {
    nullable: true,
    description: 'Items per page (default: 20, max: 100).',
  })
  @IsOptional()
  @IsInt({ message: 'limit ต้องเป็นจำนวนเต็ม' })
  @Min(1, { message: 'limit ต้องไม่น้อยกว่า 1' })
  @Max(100, { message: 'limit ต้องไม่เกิน 100' })
  limit?: number;
}
