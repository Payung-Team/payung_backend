import { UseGuards } from '@nestjs/common';
import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import {
  AuthUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { ServicePackageService } from './service-package.service';
import { RecommendedServicePackages } from './service-package.types';

@Resolver()
@UseGuards(SupabaseAuthGuard)
export class RecommendedServicePackagesResolver {
  constructor(private readonly packages: ServicePackageService) {}

  @Query(() => RecommendedServicePackages)
  recommendedServicePackages(
    @CurrentUser() actor: AuthUser,
    @Args('careRecipientId', { type: () => ID }) careRecipientId: string,
    @Args('selectedServiceType', { type: () => String, nullable: true })
    selectedServiceType?: string | null,
  ) {
    return this.packages.recommended(
      actor.id,
      careRecipientId,
      selectedServiceType,
    );
  }

  @Query(() => RecommendedServicePackages, {
    description:
      'ชุดบริการที่แนะนำตอนจองแทนสมาชิกกลุ่มครอบครัว — ใช้โปรไฟล์เดียวกับที่ createBookingOnBehalf(memberUserId) จะผูกจริง. ' +
      'ผู้เรียกและสมาชิกต้อง ACTIVE ในกลุ่มนี้ · ไม่ผ่านสิทธิ์ = ASSESSMENT_ACCESS_DENIED · สมาชิกยังไม่มีโปรไฟล์/ผลประเมิน = careGroup null',
  })
  recommendedServicePackagesForMember(
    @CurrentUser() actor: AuthUser,
    @Args('groupId', { type: () => ID }) groupId: string,
    @Args('memberUserId', { type: () => ID }) memberUserId: string,
    @Args('selectedServiceType', { type: () => String, nullable: true })
    selectedServiceType?: string | null,
  ) {
    return this.packages.recommendedForMember(
      actor.id,
      groupId,
      memberUserId,
      selectedServiceType,
    );
  }
}
