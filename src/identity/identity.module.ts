import { Module } from '@nestjs/common';
import { KycModule } from './kyc/kyc.module';
import { IdentityResolver } from './identity.resolver';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';

@Module({
  imports: [KycModule], // ต้องใช้ imports ไม่ใช่ providers สำหรับ Module
  providers: [IdentityResolver, SupabaseAuthGuard, RolesGuard],
})
export class IdentityModule {}
