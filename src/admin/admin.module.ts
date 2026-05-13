/**
 * AdminModule — Module สำหรับ admin operations
 *
 * ประกอบด้วย:
 * - AdminResolver : GraphQL resolver สำหรับ admin queries/mutations
 * - AdminService  : Business logic (KYC list, approve/reject ในอนาคต)
 * - Guards        : SupabaseAuthGuard + RolesGuard (inject โดย CommonModule ซึ่งเป็น @Global)
 *
 * Guards notes:
 * - PrismaService + SupabaseService มาจาก CommonModule (@Global) → ไม่ต้อง import ซ้ำ
 * - RolesGuard ต้องการ Reflector ซึ่ง NestJS inject ให้อัตโนมัติ
 */
import { Module } from '@nestjs/common';
import { AdminResolver } from './admin.resolver';
import { AdminService } from './admin.service';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { KycModule } from 'src/identity/kyc/kyc.module';

@Module({
  imports: [KycModule],
  providers: [
    AdminResolver,
    AdminService,
    SupabaseAuthGuard,
    RolesGuard,
  ],
})
export class AdminModule { }