/**
 * CaregiverResolver — GraphQL Resolver สำหรับ caregiver profile management
 *
 * แยกออกจาก KycResolver เพราะ:
 * - KycResolver จัดการ KYC submission flow
 * - CaregiverResolver จัดการ caregiver profile & availability toggle
 *
 * mutations:
 * - setSearchable(isSearchable: Boolean!): Caregiver
 *   → เปิด/ปิดการแสดงในผลค้นหา
 *   → Guard: kycStatus ต้องเป็น 'verified' (ตรวจใน CaregiverService)
 */
import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { CaregiverService } from './caregiver.service';
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
export class CaregiverResolver {
  constructor(private caregiverService: CaregiverService) { }

  /**
   * setSearchable mutation — toggle availability ของ caregiver
   *
   * mutation {
   *   setSearchable(isSearchable: true) {
   *     id isSearchable kycStatus
   *   }
   * }
   *
   * Guard:
   * - ต้องเป็น caregiver (role = 2)
   * - ต้อง login อยู่ (SupabaseAuthGuard)
   * - kycStatus ต้องเป็น 'verified' — ตรวจสอบใน CaregiverService
   *   → ForbiddenException ถ้าไม่ใช่ ('ต้องผ่านการยืนยันตัวตนก่อน')
   *
   * ผลลัพธ์:
   * - ถ้าค่าเปลี่ยน   → log analytics event + return updated Caregiver
   * - ถ้าค่าเหมือนเดิม → log analytics event (changed: false) + return Caregiver
   */
  @Mutation(() => Caregiver, {
    description: 'Toggle caregiver availability in search results (verified only)',
  })
  @Roles(2) // 2 = caregiver role เท่านั้น
  async setSearchable(
    @CurrentUser() user: AuthUser,
    @Args('isSearchable') isSearchable: boolean,
  ): Promise<Caregiver> {
    return this.caregiverService.setSearchableByUser(user.id, isSearchable);
  }
}
