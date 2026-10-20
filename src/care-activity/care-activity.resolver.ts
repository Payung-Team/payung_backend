/**
 * CareActivityResolver (PYG-634 · contract PYG-632)
 *
 * - careActivities                         — หน้าจอง: เฉพาะที่เปิดใช้งาน (ผู้ใช้ที่ล็อกอินทุก role)
 * - adminCareActivities(filter)            — แอดมิน: รวมที่ปิดใช้งาน
 * - createCareActivity / updateCareActivity / setCareActivityActive — แอดมินเท่านั้น (R3) · ไม่มีลบ (R4)
 *
 * role อื่นเรียก operation ของแอดมิน → RolesGuard ตอบ FORBIDDEN (แบบเดียวกับ resolver แอดมินอื่น)
 */
import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ROLE_ID } from '../common/constants/roles.constant';
import { CareActivityService } from './care-activity.service';
import { CareActivity } from './entities/care-activity.entity';
import {
  AdminCareActivitiesFilter,
  CreateCareActivityInput,
  UpdateCareActivityInput,
} from './dto/care-activity.input';

@Resolver(() => CareActivity)
@UseGuards(SupabaseAuthGuard)
export class CareActivityResolver {
  constructor(private readonly careActivityService: CareActivityService) {}

  @Query(() => [CareActivity], {
    description:
      'Active care activities for the booking page, ordered by category then sortOrder',
  })
  careActivities(): Promise<CareActivity[]> {
    return this.careActivityService.activeList();
  }
}

@Resolver()
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles(ROLE_ID.ADMIN, ROLE_ID.SUPER_ADMIN)
export class AdminCareActivityResolver {
  constructor(private readonly careActivityService: CareActivityService) {}

  @Query(() => [CareActivity], {
    description:
      'Admin only: all care activities including inactive ones, filtered by category / careLevel / isActive / search',
  })
  adminCareActivities(
    @Args('filter', { type: () => AdminCareActivitiesFilter, nullable: true })
    filter?: AdminCareActivitiesFilter,
  ): Promise<CareActivity[]> {
    return this.careActivityService.adminList(filter ?? {});
  }

  @Mutation(() => CareActivity, {
    description:
      'Admin only: add a care activity. CARE_ACTIVITY_DUPLICATE when the name exists in the same category.',
  })
  createCareActivity(
    @Args('input') input: CreateCareActivityInput,
  ): Promise<CareActivity> {
    return this.careActivityService.create(input);
  }

  @Mutation(() => CareActivity, {
    description:
      'Admin only: edit a care activity. Existing bookings keep their snapshot.',
  })
  updateCareActivity(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateCareActivityInput,
  ): Promise<CareActivity> {
    return this.careActivityService.update(id, input);
  }

  @Mutation(() => CareActivity, {
    description:
      'Admin only: deactivate / reactivate a care activity (there is no delete)',
  })
  setCareActivityActive(
    @Args('id', { type: () => ID }) id: string,
    @Args('isActive') isActive: boolean,
  ): Promise<CareActivity> {
    return this.careActivityService.setActive(id, isActive);
  }
}
