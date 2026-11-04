import { UseGuards } from '@nestjs/common';
import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ROLE_ID } from '../common/constants/roles.constant';
import { AdminCaregiverWorkService } from './admin-caregiver-work.service';
import { AdminCaregiverWorkInfo } from './dto/admin-caregiver-work.dto';

@Resolver()
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles(ROLE_ID.ADMIN, ROLE_ID.SUPER_ADMIN)
export class AdminCaregiverWorkResolver {
  constructor(private readonly service: AdminCaregiverWorkService) {}

  @Query(() => AdminCaregiverWorkInfo, {
    description: 'Admin only: สถานะรับงาน ตารางวันรับงาน ระดับผู้ดูแล และบัญชีรับเงิน (เลขบัญชีเฉพาะ 4 ตัวท้าย) — ใช้ users.id',
  })
  adminCaregiverWorkInfo(@Args('userId', { type: () => ID }) userId: string): Promise<AdminCaregiverWorkInfo> {
    return this.service.get(userId);
  }
}
