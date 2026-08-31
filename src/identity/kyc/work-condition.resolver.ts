/**
 * WorkConditionResolver — PYG-188
 *
 * GraphQL surface ของ "เงื่อนไขการทำงาน" ของ caregiver:
 * - query    myWorkCondition         → ดึงค่าปัจจุบัน (availability + jobTypes + serviceArea)
 * - mutation updateWorkCondition(input) → upsert ทั้ง 3 ส่วน (partial update ได้)
 *
 * Guard (decorator-level):
 * - SupabaseAuthGuard → ต้องมี JWT ที่ valid
 * - RolesGuard + @Roles(CAREGIVER) → ต้องเป็น caregiver เท่านั้น
 * - เงื่อนไข kycStatus='verified' ตรวจต่อใน WorkConditionService
 *   (ไม่บังคับ is_searchable — ดูเหตุผลใน work-condition.service.ts)
 *
 * แยก resolver ออกจาก CaregiverResolver ตาม style ของทีม (1 concern = 1 resolver)
 */
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { WorkConditionService } from './work-condition.service';
import { WorkCondition } from './entities/work-condition.entity';
import { UpdateWorkConditionInput } from './dto/work-condition.input';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { ROLE_ID } from '../../common/constants/roles.constant';
import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';

@Resolver()
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles(ROLE_ID.CAREGIVER) // 2 = caregiver เท่านั้น
export class WorkConditionResolver {
  constructor(private readonly workConditionService: WorkConditionService) {}

  /**
   * myWorkCondition — ดึงเงื่อนไขการทำงานของ caregiver ที่ login อยู่
   *
   * query {
   *   myWorkCondition {
   *     availability { dayOfWeek timeSlot isActive }
   *     serviceLocations
   *     jobTypes
   *     serviceArea { province district }
   *   }
   * }
   */
  @Query(() => WorkCondition, {
    description:
      "Returns the current caregiver's work condition (availability + service locations + job types + service area). Verified caregivers only.",
  })
  async myWorkCondition(
    @CurrentUser() user: AuthUser,
  ): Promise<WorkCondition> {
    return this.workConditionService.getByUserId(user.id);
  }

  /**
   * updateWorkCondition — upsert เงื่อนไขการทำงาน (replace-all ต่อ section)
   *
   * mutation {
   *   updateWorkCondition(input: {
   *     availability: [{ dayOfWeek: 1, timeSlot: "morning", isActive: true }]
   *     serviceLocations: ["at_home", "accompany_outside"]
   *     jobTypes: ["general_care", "physiotherapy"]
   *     serviceArea: { province: "กรุงเทพมหานคร", district: "บางรัก" }
   *   }) {
   *     availability { dayOfWeek timeSlot isActive }
   *     serviceLocations
   *     jobTypes
   *     serviceArea { province district }
   *   }
   * }
   */
  @Mutation(() => WorkCondition, {
    description:
      'Upsert the caregiver work condition. Each section is optional (partial update): ' +
      'omit a section to keep it unchanged, or send [] to clear it. Verified caregivers only.',
  })
  async updateWorkCondition(
    @CurrentUser() user: AuthUser,
    @Args('input') input: UpdateWorkConditionInput,
  ): Promise<WorkCondition> {
    return this.workConditionService.updateByUserId(user.id, input);
  }
}
