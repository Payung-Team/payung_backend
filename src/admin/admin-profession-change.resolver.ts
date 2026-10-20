/**
 * AdminProfessionChangeResolver — แอดมินตรวจคำขอเปลี่ยนวิชาชีพ (PYG-575 · S01-AC6 · contract PYG-573 §4.6)
 *
 * Queries:
 * - adminProfessionChangeRequests(input)       — คิว (default pending เรียงเก่าสุดก่อน) / ประวัติตามสถานะ
 *
 * Mutations:
 * - approveProfessionChangeRequest(id)         — อนุมัติ → caregivers.profession = ค่าใหม่ (ทรานแซคชันเดียวกับ log)
 * - rejectProfessionChangeRequest(input)       — ปฏิเสธพร้อมเหตุผล (บังคับ) · วิชาชีพคงเดิม
 *
 * Logic อยู่ใน ProfessionChangeService (KycModule export ให้) — ที่นี่แค่ guard + ส่งต่อ
 * Guards: SupabaseAuthGuard + RolesGuard (admin / super admin) — แบบเดียวกับ AdminProfilePhotoResolver
 */
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ROLE_ID } from '../common/constants/roles.constant';
import {
  AuthUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { ProfessionChangeService } from '../identity/kyc/profession-change.service';
import {
  AdminProfessionChangeRequestPage,
  ProfessionChangeRequest,
} from '../identity/kyc/entities/profession-change-request.entity';
import {
  AdminProfessionChangeRequestsInput,
  RejectProfessionChangeInput,
} from '../identity/kyc/dto/profession-change.input';

@Resolver()
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles(ROLE_ID.ADMIN, ROLE_ID.SUPER_ADMIN)
export class AdminProfessionChangeResolver {
  constructor(
    private readonly professionChangeService: ProfessionChangeService,
  ) {}

  @Query(() => AdminProfessionChangeRequestPage, {
    description:
      'Admin only: profession change requests by status (default pending, oldest first; ' +
      'other statuses newest decision first).',
  })
  async adminProfessionChangeRequests(
    @Args('input', { nullable: true })
    input?: AdminProfessionChangeRequestsInput,
  ): Promise<AdminProfessionChangeRequestPage> {
    return this.professionChangeService.adminList(input ?? {});
  }

  @Mutation(() => ProfessionChangeRequest, {
    description:
      "Admin only: approve a pending profession change — updates the caregiver's profession.",
  })
  async approveProfessionChangeRequest(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() admin: AuthUser,
  ): Promise<ProfessionChangeRequest> {
    return this.professionChangeService.approve(admin, id);
  }

  @Mutation(() => ProfessionChangeRequest, {
    description:
      'Admin only: reject a pending profession change with a reason (required). Profession is kept.',
  })
  async rejectProfessionChangeRequest(
    @Args('input') input: RejectProfessionChangeInput,
    @CurrentUser() admin: AuthUser,
  ): Promise<ProfessionChangeRequest> {
    return this.professionChangeService.reject(admin, input);
  }
}
