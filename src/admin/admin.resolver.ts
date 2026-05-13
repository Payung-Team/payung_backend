/**
 * AdminResolver — GraphQL Resolver สำหรับ admin operations
 *
 * Queries:
 * - adminKycList(input: AdminKycListInput!): AdminKycListPayload
 *   → ดูรายการ KYC submissions ทั้งหมด (เฉพาะ admin เท่านั้น)
 *
 * Guards (ทำงานตามลำดับ):
 * 1. SupabaseAuthGuard — ตรวจ JWT + inject req.user
 * 2. RolesGuard        — ตรวจว่า user.role === 3 (ADMIN)
 */
import { Resolver, Query, Args } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminKycListInput } from './dto/admin-kyc-list.input';
import { AdminKycListPayload } from './dto/admin-kyc-list.payload';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ROLE_ID } from '../common/constants/roles.constant';

@Resolver()
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles(ROLE_ID.ADMIN)
export class AdminResolver {
  constructor(private readonly adminService: AdminService) {}

  /**
   * adminKycList — ดึงรายการ KYC submissions พร้อม filter/search/pagination
   *
   * @example
   * query {
   *   adminKycList(input: { status: pending, page: 1, limit: 20 }) {
   *     items { id fullName kycStatus submittedAt documentCount }
   *     total
   *     page
   *     totalPages
   *   }
   * }
   *
   * @param input - AdminKycListInput (status, search, page, limit)
   * @returns AdminKycListPayload (items, total, page, totalPages)
   */
  @Query(() => AdminKycListPayload, {
    description:
      'Admin only: Get paginated list of caregiver KYC submissions. ' +
      'Filter by status, search by name. Pending items shown first.',
  })
  async adminKycList(
    @Args('input') input: AdminKycListInput,
  ): Promise<AdminKycListPayload> {
    return this.adminService.adminKycList(input);
  }
}
