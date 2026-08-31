/**
 * AdminModule — Module สำหรับ admin operations
 *
 * ประกอบด้วย:
 * - AdminResolver      : GraphQL resolver สำหรับ admin queries/mutations
 * - AdminService       : Business logic (KYC list, approve, reject + audit)
 * - Guards             : SupabaseAuthGuard + RolesGuard
 *
 * Imports:
 * - KycModule          : export CaregiverService → ใช้ getDocumentsWithSignedUrls ใน adminKycDetail
 * - NotificationModule : export NotificationService → trigger in-app notification หลัง approve/reject
 * - EmailModule        : export EmailService → trigger email หลัง approve/reject
 *
 * Notes:
 * - PrismaService + SupabaseService มาจาก CommonModule (@Global) → ไม่ต้อง import ซ้ำ
 * - RolesGuard ต้องการ Reflector ซึ่ง NestJS inject ให้อัตโนมัติ
 */
import { Module } from '@nestjs/common';
import { AdminResolver } from './admin.resolver';
import { AdminService } from './admin.service';
import { AdminCleanupService } from './admin-cleanup.service';
import { UserCleanupService } from './user-cleanup.service';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { KycModule } from '../identity/kyc/kyc.module';
import { NotificationModule } from '../notification/notification.module';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [
    KycModule,           // exports CaregiverService
    NotificationModule,  // exports NotificationService
    EmailModule,         // exports EmailService
  ],
  providers: [
    AdminResolver,
    AdminService,
    AdminCleanupService,
    UserCleanupService,
    SupabaseAuthGuard,
    RolesGuard,
  ],
})
export class AdminModule { }