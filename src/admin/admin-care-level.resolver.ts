/**
 * AdminCareLevelResolver — GraphQL ของระดับผู้ดูแลฝั่งแอดมิน (PYG-581 · contract PYG-579 §4)
 *
 * Mutation:
 * - setCaregiverCareLevel(input: SetCaregiverCareLevelInput!): SetCaregiverCareLevelPayload!
 *   → แก้ระดับของผู้ดูแลที่ KYC อนุมัติแล้ว (ระดับแรกเลือกตอน approveKyc)
 *
 * Query:
 * - caregiverCareLevelHistory(caregiverId: ID!): [CareLevelChange!]!
 *   → ประวัติการเปลี่ยนระดับ ใหม่ไปเก่า
 *
 * Guards: เหมือน AdminResolver — SupabaseAuthGuard (JWT) → RolesGuard (role 3 admin / 4 super admin)
 * ผู้ดูแล (2) และผู้สูงอายุ (1) ถูกปฏิเสธด้วย FORBIDDEN ก่อนถึง service
 */
import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ROLE_ID } from '../common/constants/roles.constant';
import {
  AuthUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { AdminCareLevelService } from './admin-care-level.service';
import {
  CareLevelChange,
  SetCaregiverCareLevelInput,
  SetCaregiverCareLevelPayload,
} from './dto/care-level.dto';

@Resolver()
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles(ROLE_ID.ADMIN, ROLE_ID.SUPER_ADMIN)
export class AdminCareLevelResolver {
  constructor(private readonly adminCareLevelService: AdminCareLevelService) {}

  /**
   * @example
   * mutation {
   *   setCaregiverCareLevel(input: {
   *     caregiverId: "uuid-here"
   *     level: "INTERMEDIATE"
   *     reason: "ผ่านอบรมหลักสูตรผู้ช่วยพยาบาลแล้ว"
   *   }) {
   *     changed
   *     careLevel { level setBy setByName setAt needsReview }
   *   }
   * }
   */
  @Mutation(() => SetCaregiverCareLevelPayload, {
    description:
      'Admin only: set or change the care level of a VERIFIED caregiver. ' +
      'The first level of a new caregiver is chosen in approveKyc(careLevel). ' +
      'Same level already set by an admin = no-op (changed: false). ' +
      'Errors: CARE_LEVEL_REQUIRED, CARE_LEVEL_INVALID, CARE_LEVEL_REASON_REQUIRED, CARE_LEVEL_KYC_NOT_VERIFIED.',
  })
  async setCaregiverCareLevel(
    @Args('input') input: SetCaregiverCareLevelInput,
    @CurrentUser() admin: AuthUser,
  ): Promise<SetCaregiverCareLevelPayload> {
    return this.adminCareLevelService.setCaregiverCareLevel(input, admin);
  }

  /**
   * @example
   * query {
   *   caregiverCareLevelHistory(caregiverId: "uuid-here") {
   *     id oldLevel newLevel changedBy changedByName reason source createdAt
   *   }
   * }
   */
  @Query(() => [CareLevelChange], {
    description:
      'Admin only: care level change history of a caregiver, newest first',
  })
  async caregiverCareLevelHistory(
    @Args('caregiverId', { type: () => ID }) caregiverId: string,
  ): Promise<CareLevelChange[]> {
    return this.adminCareLevelService.careLevelHistory(caregiverId);
  }
}
