/**
 * IdentityResolver — GraphQL Resolver สำหรับ Identity queries
 *
 * Guards ที่ใช้:
 * - SupabaseAuthGuard = ตรวจสอบ JWT token
 * - RolesGuard        = เช็คว่า user มี role ที่อนุญาต
 *
 * ลำดับ Guard สำคัญ: Auth ก่อน → Roles ทีหลัง
 */
import { Resolver } from '@nestjs/graphql';

@Resolver()
export class IdentityResolver {
  // kycStatus query ย้ายไปอยู่ที่ KycResolver แล้ว
}
