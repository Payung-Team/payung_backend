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
import { ConfigService } from '@nestjs/config';
import { AuthResolver } from './auth.resolver';
import { UserResolver } from './user.resolver';
import { AuthService } from './auth.service';
import { UserService } from './user.service';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { FieldLockGuard } from '../../common/guards/field-lock.guard';
import { KycModule } from '../kyc/kyc.module';
import { ConsentModule } from '../../consent/consent.module';
import { PhoneAuthResolver } from './phone/phone-auth.resolver';
import { PhoneAuthService } from './phone/phone-auth.service';
import { PhoneAuthGateway } from './phone/phone-auth.gateway';
import { SupabasePhoneAuthGateway } from './phone/supabase-phone-auth.gateway';
import { PhoneOtpTracker } from './phone/phone-otp-tracker';
import { PhoneVerificationTokenService } from './phone/phone-verification-token.service';
import {
  PHONE_AUTH_CONFIG,
  type PhoneAuthConfig,
  phoneAuthConfigFactory,
} from './phone/phone-auth.config';

@Module({
  // PYG-90: KycModule ให้ CaregiverService กับ UserResolver
  // PYG-538: ConsentModule ให้ ConsentService — completeOnboarding ต้องตรวจและบันทึกความยินยอม
  imports: [KycModule, ConsentModule],
  providers: [
    AuthResolver,
    UserResolver,        // PYG-90: field resolver สำหรับ User.caregiver
    AuthService,
    UserService,
    SupabaseAuthGuard,
    FieldLockGuard, // PYG-146: ใช้กับ updateProfile

    // ── PYG-603: สมัคร / ล็อกอิน / ผูกเบอร์ด้วยเบอร์โทร (Supabase Auth OTP) ──
    PhoneAuthResolver,
    PhoneAuthService,
    PhoneVerificationTokenService,
    // ค่าที่ตั้งได้ (R8) — อ่าน env ครั้งเดียวตอนบูต
    {
      provide: PHONE_AUTH_CONFIG,
      useFactory: phoneAuthConfigFactory,
      inject: [ConfigService],
    },
    // ★ ตัวนับต้องเป็นตัวเดียวทั้งแอป (provider ของ module = singleton) ไม่งั้นการจำกัดไม่มีผล
    {
      provide: PhoneOtpTracker,
      useFactory: (config: PhoneAuthConfig) => new PhoneOtpTracker(config),
      inject: [PHONE_AUTH_CONFIG],
    },
    // ตัวจริงคุยกับ Supabase — unit test สลับเป็นตัวปลอมได้ (การ์ด: "มีตัวปลอมสำหรับ test")
    { provide: PhoneAuthGateway, useClass: SupabasePhoneAuthGateway },
  ],
})
export class AuthModule {}
