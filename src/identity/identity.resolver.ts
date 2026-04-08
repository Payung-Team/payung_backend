/**
 * IdentityResolver — GraphQL Resolver สำหรับ Identity queries
 *
 * Guards ที่ใช้:
 * - SupabaseAuthGuard = ตรวจสอบ JWT token
 * - RolesGuard        = เช็คว่า user มี role ที่อนุญาต
 *
 * ลำดับ Guard สำคัญ: Auth ก่อน → Roles ทีหลัง
 */
import { Resolver, Query } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';

@Resolver()
export class IdentityResolver {
  // me query ย้ายไปอยู่ที่ AuthResolver แล้ว (พร้อม updateProfile)

  @Query(() => String, { description: 'Get KYC status of caregiver' })
  @UseGuards(SupabaseAuthGuard)
  kycStatus(): string {
    return 'PENDING';
  }
}
