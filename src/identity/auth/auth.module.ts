/**
 * AuthModule — Module สำหรับ Authentication
 *
 * NestJS ใช้ระบบ Module เพื่อจัดกลุ่มโค้ดที่เกี่ยวข้องกันไว้ด้วยกัน
 * - AuthResolver + AuthService อยู่ด้วยกันใน AuthModule
 * - UserResolver = field resolver สำหรับ User type (เช่น caregiver field) — PYG-90
 * - Module นี้ถูก import เข้า AppModule (app.module.ts) เพื่อให้ app รู้จัก
 *
 * ทำไม import KycModule?
 * - UserResolver ต้องใช้ CaregiverService เพื่อ resolve field me { caregiver }
 * - KycModule export CaregiverService ให้ module อื่น inject ได้ (PYG-90)
 *
 * providers = service/resolver ที่อยู่ใน module นี้
 * (ไม่ต้อง import CommonModule เพราะ CommonModule เป็น @Global() อยู่แล้ว)
 */
import { Module } from '@nestjs/common';
import { AuthResolver } from './auth.resolver';
import { UserResolver } from './user.resolver';
import { AuthService } from './auth.service';
import { UserService } from './user.service';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { KycModule } from '../kyc/kyc.module';

@Module({
  imports: [KycModule],  // PYG-90: ดึง CaregiverService มาใช้ใน UserResolver
  providers: [
    AuthResolver,
    UserResolver,        // PYG-90: field resolver สำหรับ User.caregiver
    AuthService,
    UserService,
    SupabaseAuthGuard,
  ],
})
export class AuthModule {}
