/**
 * AdminDrivingLicenseResolver — แอดมินอนุมัติ/ปฏิเสธใบขับขี่ (PYG-597 / PYG-561 · S06-AC4)
 *
 * Guards: SupabaseAuthGuard + RolesGuard (admin / super admin เท่านั้น)
 * ข้อมูลสำหรับหน้า review อยู่ใน adminKycDetail { drivingLicense { ... } drivingLicenseReviews { ... } }
 */
import { Args, ID, Mutation, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { AdminDrivingLicenseService } from './admin-driving-license.service';
import { LicenseReviewResult, RejectLicenseInput } from './dto/admin-license.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ROLE_ID } from '../common/constants/roles.constant';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';

@Resolver()
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles(ROLE_ID.ADMIN, ROLE_ID.SUPER_ADMIN)
export class AdminDrivingLicenseResolver {
  constructor(private readonly service: AdminDrivingLicenseService) {}

  @Mutation(() => LicenseReviewResult, {
    description:
      'Admin only: Approve a pending driving license (documentId = drivingLicense.documentId). ' +
      'Fails with DRIVING_LICENSE_EXPIRED if past its expiry day. Records kyc_reviews (driving_license_approved).',
  })
  async approveDrivingLicense(
    @Args('documentId', { type: () => ID }) documentId: string,
    @CurrentUser() admin: AuthUser,
  ): Promise<LicenseReviewResult> {
    return this.service.approve(documentId, admin);
  }

  @Mutation(() => LicenseReviewResult, {
    description:
      'Admin only: Reject a pending driving license. reason is required (REJECT_REASON_REQUIRED). ' +
      'Records kyc_reviews (driving_license_rejected) with the reason; the caregiver sees it in kycStatus.drivingLicense.',
  })
  async rejectDrivingLicense(
    @Args('input') input: RejectLicenseInput,
    @CurrentUser() admin: AuthUser,
  ): Promise<LicenseReviewResult> {
    return this.service.reject(input, admin);
  }
}
