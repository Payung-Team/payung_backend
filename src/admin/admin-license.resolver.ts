/**
 * AdminLicenseResolver — แอดมินอนุมัติ/ปฏิเสธใบประกอบวิชาชีพ (PYG-587 / PYG-558)
 *
 * Guards: SupabaseAuthGuard + RolesGuard (admin / super admin เท่านั้น) — แบบเดียวกับ AdminProfilePhotoResolver
 * ข้อมูลใบประกอบฯ สำหรับหน้า review อยู่ใน adminKycDetail { profession license { ... } }
 */
import { Args, ID, Mutation, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { AdminLicenseService } from './admin-license.service';
import { LicenseReviewResult, RejectLicenseInput } from './dto/admin-license.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ROLE_ID } from '../common/constants/roles.constant';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';

@Resolver()
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles(ROLE_ID.ADMIN, ROLE_ID.SUPER_ADMIN)
export class AdminLicenseResolver {
  constructor(private readonly licenseService: AdminLicenseService) {}

  @Mutation(() => LicenseReviewResult, {
    description:
      'Admin only: Approve a pending professional license. Fails with LICENSE_EXPIRED if the expiry has passed. ' +
      'Records kyc_reviews (license_approved) and notifies the caregiver.',
  })
  async approveLicense(
    @Args('documentId', { type: () => ID }) documentId: string,
    @CurrentUser() admin: AuthUser,
  ): Promise<LicenseReviewResult> {
    return this.licenseService.approve(documentId, admin);
  }

  @Mutation(() => LicenseReviewResult, {
    description:
      'Admin only: Reject a pending professional license. reason is required (LICENSE_REJECT_REASON_REQUIRED). ' +
      'Records kyc_reviews (license_rejected) and notifies the caregiver.',
  })
  async rejectLicense(
    @Args('input') input: RejectLicenseInput,
    @CurrentUser() admin: AuthUser,
  ): Promise<LicenseReviewResult> {
    return this.licenseService.reject(input, admin);
  }
}
