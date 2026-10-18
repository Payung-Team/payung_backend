/**
 * PhoneAuthResolver — GraphQL ของการสมัคร / ล็อกอิน / ผูกเบอร์ด้วยเบอร์โทร (PYG-603)
 *
 * Contract: docs/pyg601-phone-auth-api-contract.md (PYG-601) · FE: payung_frontend/src/graphql/phoneAuth.ts
 *
 * resolver นี้แค่รับคำขอ ดึงข้อมูลจาก request (IP, token, user agent) แล้วส่งต่อให้ PhoneAuthService
 * ★ IP / user agent อ่านจาก request ฝั่ง server เสมอ ไม่ให้ FE ส่งมาเอง (ค่าที่ client ส่งมาปลอมได้)
 */
import { UseGuards } from '@nestjs/common';
import { Args, Context, Mutation, Resolver } from '@nestjs/graphql';
import {
  AuthUser,
  CurrentUser,
} from '../../../common/decorators/current-user.decorator';
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard';
import type { GqlContext } from '../../../common/types/gql-context.type';
import {
  rateLimitIpOf,
  requestEvidenceOf,
} from '../../../common/utils/request-evidence';
import { AuthPayload } from '../../models/auth-payload.model';
import { User } from '../entities/user.entity';
import {
  LinkPhoneInput,
  LoginWithPhoneInput,
  PhoneOtpPurpose,
  PhoneOtpRequestPayload,
  PhoneVerificationPayload,
  RequestPhoneOtpInput,
  SignUpWithPhoneInput,
  VerifyPhoneOtpInput,
} from './dto/phone-auth.dto';
import { type LinkCaller, PhoneAuthService } from './phone-auth.service';

@Resolver()
export class PhoneAuthResolver {
  constructor(
    private readonly phoneAuth: PhoneAuthService,
    // ใช้ตรวจ token เฉพาะ requestPhoneOtp(LINK) — ดูเหตุผลที่ SupabaseAuthGuard.authenticateRequest
    private readonly authGuard: SupabaseAuthGuard,
  ) {}

  /**
   * requestPhoneOtp — ขอรหัสยืนยันทาง SMS
   *
   * ★ public (ไม่ติด @UseGuards) เพราะ SIGNUP/LOGIN ใช้ตอนยังไม่มี session
   *   แต่ LINK ต้องล็อกอิน → ตรวจ token ด้วยตรรกะเดียวกับ SupabaseAuthGuard (รวมเช็คบัญชีถูกระงับ)
   */
  @Mutation(() => PhoneOtpRequestPayload, {
    description:
      'ขอรหัสยืนยันทาง SMS — SIGNUP/LOGIN ไม่ต้องล็อกอิน · LINK ต้องส่ง Authorization header ' +
      '· ไม่คืนรหัส · error: PHONE_INVALID_FORMAT, PHONE_ALREADY_IN_USE, PHONE_NOT_REGISTERED, ' +
      'PHONE_NOT_VERIFIED, OTP_RATE_LIMITED (+resendAfterSeconds), SMS_SEND_FAILED',
  })
  async requestPhoneOtp(
    @Args('input') input: RequestPhoneOtpInput,
    @Context() ctx: GqlContext,
  ): Promise<PhoneOtpRequestPayload> {
    let caller: LinkCaller | null = null;
    if (input.purpose === PhoneOtpPurpose.LINK) {
      // throw UNAUTHENTICATED / FORBIDDEN เองถ้า token ใช้ไม่ได้หรือบัญชีถูกระงับ
      const user = await this.authGuard.authenticateRequest(ctx.req);
      // authenticateRequest ผ่าน = header เป็น "Bearer <token>" แน่นอน
      const accessToken = ctx.req.headers.authorization!.split(' ')[1];
      caller = { user, accessToken };
    }
    return this.phoneAuth.requestOtp(input, {
      ip: rateLimitIpOf(ctx.req),
      caller,
    });
  }

  @Mutation(() => PhoneVerificationPayload, {
    description:
      'ตรวจรหัสของการสมัคร (purpose: SIGNUP) → verificationToken สำหรับ signUpWithPhone ' +
      '· ยังไม่สร้างบัญชี · error: OTP_INVALID, OTP_EXPIRED, OTP_ATTEMPTS_EXCEEDED, PHONE_ALREADY_IN_USE',
  })
  async verifyPhoneOtp(
    @Args('input') input: VerifyPhoneOtpInput,
  ): Promise<PhoneVerificationPayload> {
    return this.phoneAuth.verifySignupOtp(input);
  }

  /** IP + user agent เป็นหลักฐานประกอบความยินยอม (PDPA) — แบบเดียวกับ register */
  @Mutation(() => AuthPayload, {
    description:
      'สร้างบัญชีด้วยเบอร์ที่ยืนยันแล้ว (หลังยอมรับเงื่อนไข) — response รูปเดียวกับ register ' +
      '· error: PHONE_VERIFICATION_EXPIRED, PHONE_ALREADY_IN_USE, CONSENT_*',
  })
  async signUpWithPhone(
    @Args('input') input: SignUpWithPhoneInput,
    @Context() ctx: GqlContext,
  ): Promise<AuthPayload> {
    return this.phoneAuth.signUp(input, requestEvidenceOf(ctx.req));
  }

  @Mutation(() => AuthPayload, {
    description:
      'ล็อกอินด้วยเบอร์และรหัส — response รูปเดียวกับ login อีเมล ' +
      '· error: OTP_INVALID, OTP_EXPIRED, OTP_ATTEMPTS_EXCEEDED, PHONE_NOT_REGISTERED',
  })
  async loginWithPhone(
    @Args('input') input: LoginWithPhoneInput,
  ): Promise<AuthPayload> {
    return this.phoneAuth.login(input);
  }

  /** R6: ผูกกับบัญชีของผู้ถือ session เท่านั้น — ไม่มี userId ใน input */
  @Mutation(() => User, {
    description:
      'ผูกเบอร์กับบัญชีที่ล็อกอินอยู่ หลังยืนยันรหัส (ขอรหัสด้วย requestPhoneOtp purpose LINK) ' +
      '· error: OTP_INVALID, OTP_EXPIRED, OTP_ATTEMPTS_EXCEEDED, PHONE_ALREADY_IN_USE',
  })
  @UseGuards(SupabaseAuthGuard)
  async linkPhone(
    @CurrentUser() user: AuthUser,
    @Args('input') input: LinkPhoneInput,
  ): Promise<User> {
    return this.phoneAuth.link(user, input);
  }
}
