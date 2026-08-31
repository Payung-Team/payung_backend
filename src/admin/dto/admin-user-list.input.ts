/**
 * AdminUserListInput — Input สำหรับ query adminUserList
 *
 * Filter/search/paginate รายการ users สำหรับ admin
 */
import { InputType, Field, Int, registerEnumType } from '@nestjs/graphql';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** Role filter enum — ให้ admin กรอง user ตาม role */
export enum RoleFilter {
  all = 'all',
  patient = 'patient',
  caregiver = 'caregiver',
  admin = 'admin',
  super_admin = 'super_admin',
}

registerEnumType(RoleFilter, {
  name: 'RoleFilter',
  description: 'Filter users by role. Use "all" to return every role.',
  valuesMap: {
    all: { description: 'Return all roles' },
    patient: { description: 'Role 1: Patient' },
    caregiver: { description: 'Role 2: Caregiver' },
    admin: { description: 'Role 3: Admin' },
    super_admin: { description: 'Role 4: Super Admin' },
  },
});

/** Map RoleFilter enum values → role IDs ใน DB */
export const ROLE_FILTER_MAP: Record<string, number> = {
  patient: 1,
  caregiver: 2,
  admin: 3,
  super_admin: 4,
};

@InputType()
export class AdminUserListInput {
  /** กรอง user ตาม role (ถ้าไม่ส่ง → ดูทุก role) */
  @Field(() => RoleFilter, {
    nullable: true,
    description: 'Filter by user role. Omit or "all" for every role.',
  })
  @IsOptional()
  @IsEnum(RoleFilter, { message: 'role ต้องเป็น all | patient | caregiver | admin | super_admin' })
  role?: RoleFilter;

  /** ค้นหาด้วย display_name หรือ email (case-insensitive partial match) */
  @Field({ nullable: true, description: 'Search by display name or email (case-insensitive)' })
  @IsOptional()
  @IsString({ message: 'search ต้องเป็นข้อความ' })
  search?: string;

  /** หน้าที่ต้องการ (เริ่มจาก 1) */
  @Field(() => Int, { nullable: true, description: 'Page number (1-based). Defaults to 1.' })
  @IsOptional()
  @IsInt({ message: 'page ต้องเป็นจำนวนเต็ม' })
  @Min(1, { message: 'page ต้องไม่น้อยกว่า 1' })
  page?: number;

  /** จำนวนรายการต่อหน้า (default 20, max 100) */
  @Field(() => Int, { nullable: true, description: 'Items per page (default: 20, max: 100).' })
  @IsOptional()
  @IsInt({ message: 'limit ต้องเป็นจำนวนเต็ม' })
  @Min(1, { message: 'limit ต้องไม่น้อยกว่า 1' })
  @Max(100, { message: 'limit ต้องไม่เกิน 100' })
  limit?: number;
}
