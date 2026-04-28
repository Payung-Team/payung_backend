/**
 * KycModule — Module สำหรับ KYC (Know Your Customer)
 *
 * NestJS ใช้ระบบ Module เพื่อจัดกลุ่มโค้ดที่เกี่ยวข้องกันไว้ด้วยกัน
 * - KycResolver + KycService อยู่ด้วยกันใน KycModule
 * - Module นี้ถูก import เข้า AppModule (app.module.ts) เพื่อให้ app รู้จัก
 *
 * ทำไมต้อง provide Guards ไว้ที่นี่ด้วย?
 * - Guards ที่ใช้ @UseGuards() บน class ต้อง injectable ได้ใน module นั้น
 * - SupabaseAuthGuard inject SupabaseService + PrismaService (มาจาก @Global() CommonModule)
 * - RolesGuard inject Reflector (มาจาก NestJS core โดยอัตโนมัติ)
 *
 * Dependency Graph:
 * KycResolver → KycService → { PrismaService, CaregiverService }
 * CaregiverService → { PrismaService, SupabaseService }
 *
 * providers = service/resolver/guard ที่อยู่ใน module นี้
 */
import { Module } from '@nestjs/common';
import { KycResolver } from './kyc.resolver';
import { KycService } from './kyc.service';
import { CaregiverResolver } from './caregiver.resolver';
import { CaregiverService } from './caregiver.service';
import { KycDocumentService } from './kyc-document.service';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { NotificationModule } from '../../notification/notification.module';
import { EmailModule } from '../../email/email.module';

@Module({
  // PYG-97: ดึง NotificationService + EmailService มา inject ใน KycService + CaregiverService
  // เพื่อ trigger notification/email ตอน KYC submit/resubmit/verify/reject
  imports: [NotificationModule, EmailModule],
  providers: [
    KycResolver,
    KycService,
    CaregiverResolver,      // setSearchable mutation
    CaregiverService,       // CRUD สำหรับ caregivers table + signed URL generation
    KycDocumentService,     // CRUD สำหรับ kyc_documents table
    SupabaseAuthGuard,
    RolesGuard,
  ],
  // export CaregiverService → AuthModule's UserResolver inject ไปใช้ทำ field resolver
  // me { caregiver { ... } } (PYG-90)
  exports: [CaregiverService],
})
export class KycModule { }
