/**
 * IdentityResolver — GraphQL Resolver สำหรับ Identity queries
 *
 * Note: kycStatus query ย้ายไปอยู่ที่ KycResolver แล้ว (พร้อม KycStatusPayload)
 *
 * Guards ที่ใช้:
 * - SupabaseAuthGuard = ตรวจสอบ JWT token
 * - RolesGuard        = เช็คว่า user มี role ที่อนุญาต
 */
import { Resolver } from '@nestjs/graphql';

@Resolver()
export class IdentityResolver {
  // kycStatus ย้ายไป KycResolver แล้ว (PYG-xxx: kycStatus returns KycStatusPayload)
  // me query ย้ายไปอยู่ที่ AuthResolver แล้ว (พร้อม updateProfile)
}
