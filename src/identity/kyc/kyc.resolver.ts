/**
 * KycResolver — GraphQL Resolver สำหรับ KYC (Know Your Customer)
 *
 * Resolver คืออะไร?
 * - คือ "ตัวรับ request" จาก GraphQL
 * - เหมือน Controller ใน REST API แต่สำหรับ GraphQL
 * - @Mutation = รับ request ที่เปลี่ยนแปลงข้อมูล (submitKyc)
 * - @Query    = รับ request ที่ดึงข้อมูล (kycStatus, myCaregiverProfile)
 *
 * Guard ที่ใช้:
 * - SupabaseAuthGuard = ตรวจสอบ JWT token ก่อนทุก request
 * - RolesGuard        = เช็คว่า user มี role ที่อนุญาตไหม
 *
 * ลำดับ Guard สำคัญมาก: Auth ก่อน → Roles ทีหลัง
 * เพราะ RolesGuard ต้องการ req.user ที่ SupabaseAuthGuard inject แล้ว
 *
 * Resolver ไม่ควรมี business logic ซับซ้อน — มันแค่รับ request แล้วส่งต่อให้ Service ทำงาน
 */
import { Args, Mutation, Resolver, Query } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { KycService } from './kyc.service';
import { KycInput } from './dto/kyc.input';
import { KycStatusPayload } from './dto/kyc-status.payload';
import { Caregiver } from './entities/caregiver.entity';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';

@Resolver()
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class KycResolver {
  // NestJS จะ inject KycService เข้ามาอัตโนมัติ (Dependency Injection)
  constructor(private kycService: KycService) {}

  /**
   * submitKyc mutation — ใช้ใน GraphQL Playground แบบนี้:
   *
   * mutation {
   *   submitKyc(input: {
   *     fullName: "สมชาย ใจดี"
   *     idCardNumber: "1234567890123"
   *     phone: "0812345678"
   *     skills: ["elder_care", "first_aid"]
   *     experienceYears: 3
   *     hourlyRate: 150.0
   *     bio: "มีประสบการณ์ดูแลผู้สูงอายุ"
   *     documentIds: ["uuid-1", "uuid-2"]
   *   }) {
   *     id kycStatus kycSubmittedAt
   *   }
   * }
   *
   * @CurrentUser() = ดึง user ที่ login อยู่จาก JWT token (inject โดย SupabaseAuthGuard)
   * @Args('input') = ดึงค่า "input" จาก GraphQL arguments
   */
  @Mutation(() => Caregiver, {
    description: 'Submit KYC information (caregiver only)',
  })
  @Roles(2) // 2 = caregiver role เท่านั้น
  async submitKyc(
    @CurrentUser() user: AuthUser,
    @Args('input') input: KycInput,
  ): Promise<Caregiver> {
    return this.kycService.submitKyc(user, input);
  }

  /**
   * kycStatus query — ดึงข้อมูล KYC status ครบสำหรับ Status Page
   *
   * query {
   *   kycStatus {
   *     status
   *     submittedAt
   *     verifiedAt
   *     rejectedAt
   *     rejectedReason
   *     caregiver { id fullName kycStatus }
   *     documents { id docType fileName signedUrl }
   *   }
   * }
   *
   * รองรับทุก status:
   * - "none"     → { status: 'none', documents: [] }
   * - "pending"  → { status, submittedAt, caregiver, documents[] }
   * - "verified" → { status, submittedAt, verifiedAt, caregiver, documents[] }
   * - "rejected" → { status, submittedAt, rejectedAt, rejectedReason, caregiver, documents[] }
   */
  @Query(() => KycStatusPayload, {
    description: 'Get KYC status with full details for the Status Page',
  })
  @Roles(2) // 2 = caregiver role เท่านั้น
  async kycStatus(@CurrentUser() user: AuthUser): Promise<KycStatusPayload> {
    return this.kycService.getKycStatus(user.id);
  }

  @Query(() => Caregiver, {
    description: 'Get current caregiver profile',
  })
  @Roles(2) // 2 = caregiver role เท่านั้น
  async myCaregiverProfile(@CurrentUser() user: AuthUser): Promise<Caregiver> {
    return this.kycService.getCaregiverByUserId(user.id);
  }

  /**
   * resubmitKyc mutation — ยื่น KYC ใหม่หลังถูก reject
   *
   * mutation {
   *   resubmitKyc(input: {
   *     fullName: "สมชาย ใจดี"
   *     idCardNumber: "1234567890123"
   *     phone: "0812345678"
   *     skills: ["elder_care"]
   *     experienceYears: 3
   *     hourlyRate: 150.0
   *     documentIds: ["uuid-new-1", "uuid-new-2"]
   *   }) {
   *     id kycStatus kycSubmittedAt resubmitCount
   *   }
   * }
   *
   * Guard:
   * - ต้องเป็น caregiver (role = 2)
   * - ต้อง login อยู่ (SupabaseAuthGuard)
   * - kycStatus ต้องเป็น 'rejected' — ตรวจสอบใน KycService
   *   - none     → BadRequestException
   *   - pending  → ConflictException
   *   - verified → ConflictException
   */
  @Mutation(() => Caregiver, {
    description: 'Resubmit KYC after rejection (caregiver only, status must be rejected)',
  })
  @Roles(2) // 2 = caregiver role เท่านั้น
  async resubmitKyc(
    @CurrentUser() user: AuthUser,
    @Args('input') input: KycInput,
  ): Promise<Caregiver> {
    return this.kycService.resubmitKyc(user, input);
  }
}

