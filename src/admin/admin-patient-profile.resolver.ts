import { UseGuards } from '@nestjs/common';
import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ROLE_ID } from '../common/constants/roles.constant';
import { AdminPatientProfileService } from './admin-patient-profile.service';
import { AdminPatientProfile } from './dto/admin-patient-profile.dto';

@Resolver()
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles(ROLE_ID.ADMIN, ROLE_ID.SUPER_ADMIN)
export class AdminPatientProfileResolver {
  constructor(private readonly service: AdminPatientProfileService) {}

  @Query(() => AdminPatientProfile, {
    description: 'Admin only: โปรไฟล์ผู้ใช้ (ผู้จอง) + ผู้รับการดูแลและแบบประเมิน ADL + สรุปการจอง — ใช้ users.id',
  })
  adminPatientProfile(@Args('userId', { type: () => ID }) userId: string): Promise<AdminPatientProfile> {
    return this.service.get(userId);
  }
}
