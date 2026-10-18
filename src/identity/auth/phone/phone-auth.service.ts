/**
 * PhoneAuthService — สมัคร / ล็อกอิน / ผูกเบอร์ด้วยเบอร์โทร (PYG-603 · story PYG-562)
 *
 * Contract: docs/pyg601-phone-auth-api-contract.md (PYG-601)
 *
 * ── ภาพรวม ─────────────────────────────────────────────────────────────────
 *   Supabase Auth สร้างรหัส ส่ง SMS และตรวจรหัส (มติ 7 ต.ค.) — service นี้ทำส่วนที่ Supabase ไม่ทำ:
 *   - ตรวจรูปแบบเบอร์ก่อนส่ง SMS (R7) และแปลงเป็นรูปมาตรฐาน (R4)
 *   - ตัดสินว่าเบอร์นี้ "ขอรหัสเพื่อจุดประสงค์นี้ได้ไหม" (ซ้ำ / ยังไม่สมัคร / ยังไม่ยืนยัน — E1, E4, E5, E6)
 *   - คุมความถี่และนับครั้งที่กรอกผิด (R8, E7–E11) ผ่าน PhoneOtpTracker
 *   - สร้างแถว public.users + บันทึกความยินยอม หลังผู้ใช้ยอมรับเงื่อนไขเท่านั้น (E12, PYG-474)
 *   - คืน AuthPayload รูปเดียวกับ login / register เดิม (S07-AC5)
 *
 * ── R10 (สำคัญ) ──────────────────────────────────────────────────────────────
 *   ห้ามมีรหัส OTP / verificationToken / access token / เบอร์เต็ม ใน log หรือ error ทุกจุดในไฟล์นี้
 *   log เบอร์ผ่าน maskPhone() เท่านั้น
 */
import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { GraphQLError } from 'graphql';
import type { User as PrismaUserRow } from '@prisma/client';
import { PrismaService } from '../../../common/prisma.service';
import { ROLE_ID } from '../../../common/constants/roles.constant';
import type { AuthUser } from '../../../common/decorators/current-user.decorator';
import type { RequestEvidence } from '../../../common/utils/request-evidence';
import { CONSENT_SOURCE } from '../../../consent/consent.constants';
import { ConsentService } from '../../../consent/consent.service';
import { CaregiverService } from '../../kyc/caregiver.service';
import type { AuthPayload } from '../../models/auth-payload.model';
import type { User } from '../entities/user.entity';
import { UserService } from '../user.service';
import {
  type LinkPhoneInput,
  type LoginWithPhoneInput,
  type PhoneOtpRequestPayload,
  PhoneOtpPurpose,
  type PhoneVerificationPayload,
  type RequestPhoneOtpInput,
  type SignUpWithPhoneInput,
  type VerifyPhoneOtpInput,
} from './dto/phone-auth.dto';
import { PHONE_AUTH_CONFIG, type PhoneAuthConfig } from './phone-auth.config';
import {
  otpRateLimitedError,
  PHONE_AUTH_ERROR,
  PhoneAuthError,
  phoneAuthUnavailableError,
} from './phone-auth.errors';
import {
  PhoneAuthGateway,
  PhoneGatewayError,
  type PhoneSession,
} from './phone-auth.gateway';
import {
  isSamePhone,
  maskPhone,
  parseThaiMobile,
  profilePhoneVariants,
  type ThaiMobile,
} from './phone-number';
import { type OtpChannel, PhoneOtpTracker } from './phone-otp-tracker';
import { PhoneVerificationTokenService } from './phone-verification-token.service';

/**
 * รูปแบบรหัสที่ยอมส่งต่อให้ Supabase ตรวจ — ตัวเลข 4–10 หลัก
 * ความยาวจริงตั้งที่ Supabase ("SMS OTP Length" = 6) ตั้งหลวมไว้ ไม่งั้นวันที่ทีมเปลี่ยนความยาวใน
 * Dashboard ทุกรหัสจะถูกปฏิเสธที่ชั้นนี้ · รหัสที่ผิดรูปแบบถือเป็น "กรอกผิด" 1 ครั้ง (ไม่เรียก Supabase)
 */
const OTP_CODE_PATTERN = /^\d{4,10}$/;

/** ผู้เรียกที่ล็อกอินอยู่ — ใช้กับ LINK (R6: ผูกกับบัญชีของผู้ถือ session เท่านั้น) */
export interface LinkCaller {
  user: AuthUser;
  /** access token จาก Authorization header — ใช้สั่ง Supabase ส่งรหัสในนามผู้ใช้คนนี้ */
  accessToken: string;
}

/** ข้อมูลประกอบคำขอขอรหัส */
export interface RequestOtpContext {
  /** IP สำหรับจำกัดอัตรา (rateLimitIpOf) — null = หาไม่ได้ ข้ามการนับต่อ IP */
  ip: string | null;
  /** null สำหรับ SIGNUP / LOGIN · ต้องมีสำหรับ LINK */
  caller: LinkCaller | null;
}

@Injectable()
export class PhoneAuthService {
  private readonly logger = new Logger(PhoneAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: PhoneAuthGateway,
    private readonly tracker: PhoneOtpTracker,
    private readonly tokens: PhoneVerificationTokenService,
    private readonly consentService: ConsentService,
    private readonly caregiverService: CaregiverService,
    private readonly userService: UserService,
    @Inject(PHONE_AUTH_CONFIG) private readonly config: PhoneAuthConfig,
  ) {}

  // ═══ requestPhoneOtp ═══════════════════════════════════════════════════════

  /**
   * ขอรหัสยืนยัน (contract §4.1) — ไม่คืนรหัส (R10)
   *
   * ลำดับ: รูปแบบเบอร์ → สถานะเบอร์ตามจุดประสงค์ → rate limit → กันกดซ้ำ → ส่ง
   * ★ ทุกการตรวจที่ปฏิเสธได้อยู่ "ก่อน" เรียก Supabase → คำขอที่ผิดไม่เสียค่า SMS (R7, E4, E10)
   */
  async requestOtp(
    input: RequestPhoneOtpInput,
    ctx: RequestOtpContext,
  ): Promise<PhoneOtpRequestPayload> {
    const phone = this.parsePhone(input.phone);
    const isLink = input.purpose === PhoneOtpPurpose.LINK;
    if (isLink && !ctx.caller) {
      // resolver ตรวจ token ให้แล้ว — ถึงตรงนี้ได้แปลว่าเรียก service ผิดวิธี (ปฏิเสธไว้ก่อน)
      throw new UnauthorizedException('Missing authorization token');
    }

    await this.assertPhoneUsableFor(
      input.purpose,
      phone,
      ctx.caller?.user ?? null,
    );

    const now = Date.now();
    const waitSeconds = this.tracker.sendWaitSeconds(phone.e164, ctx.ip, now);
    if (waitSeconds > 0) throw otpRateLimitedError(waitSeconds);

    // กดซ้ำขณะคำขอเดิมยังรอ Supabase อยู่ → ปฏิเสธ (กัน SMS ออกสองข้อความ)
    if (!this.tracker.tryBeginSend(phone.e164)) {
      throw otpRateLimitedError(this.config.resendCooldownSeconds);
    }

    const channel: OtpChannel = isLink ? 'phone_change' : 'sms';
    try {
      if (isLink) {
        await this.gateway.sendPhoneChangeOtp(
          ctx.caller!.accessToken,
          phone.e164,
        );
      } else {
        // SIGNUP: Supabase สร้างผู้ใช้ (ยังไม่ยืนยัน) ให้ถ้ายังไม่มี — ยังไม่มีแถวใน public.users (E12)
        // LOGIN: ต้องมีผู้ใช้อยู่แล้ว (เช็คไปแล้วข้างบน ตรงนี้กันกรณีแข่งกันอีกชั้น)
        await this.gateway.sendSmsOtp(
          phone.e164,
          input.purpose === PhoneOtpPurpose.SIGNUP,
        );
      }
      this.tracker.recordSent(channel, phone.e164, ctx.ip, now);
    } catch (err) {
      this.tracker.recordSendFailed(ctx.ip, now);
      throw this.toSendError(err, input.purpose, phone);
    } finally {
      this.tracker.endSend(phone.e164);
    }

    this.logger.log({
      event: 'phone_otp.sent',
      purpose: input.purpose,
      phone: maskPhone(phone),
      userId: ctx.caller?.user.id,
    });

    return {
      resendAfterSeconds: this.config.resendCooldownSeconds,
      expiresInSeconds: this.config.otpExpiresSeconds,
    };
  }

  /**
   * เบอร์นี้ขอรหัสเพื่อจุดประสงค์นี้ได้หรือไม่ — ปฏิเสธด้วย code ที่บอกทางแก้
   *
   * "1 เบอร์ 1 บัญชี" (R3) ดูจาก auth.users เท่านั้น (มติ PYG-602) — public.users.phone เป็นแค่
   * เบอร์ในโปรไฟล์ที่ยังไม่ยืนยัน (มีเบอร์ซ้ำอยู่แล้ว 13 บัญชี) จึงไม่ใช้กันซ้ำ (E2: คนที่ยืนยันได้ก่อนได้เบอร์)
   */
  private async assertPhoneUsableFor(
    purpose: PhoneOtpPurpose,
    phone: ThaiMobile,
    caller: AuthUser | null,
  ): Promise<void> {
    const account = await this.gateway.findAccountByPhone(phone.supabase);

    switch (purpose) {
      case PhoneOtpPurpose.SIGNUP:
        // มีบัญชีในระบบเราใช้เบอร์นี้แล้ว → ให้ไปล็อกอินแทน (E4) · ตอบตอนขอรหัส ไม่เสียค่า SMS
        // ผู้ใช้ Supabase ที่ยังไม่มีแถวของเรา (สมัครค้างไว้) → สมัครต่อได้ (E12: "เบอร์นั้นสมัครใหม่ได้")
        if (account?.userId)
          throw new PhoneAuthError(PHONE_AUTH_ERROR.PHONE_ALREADY_IN_USE);
        return;

      case PhoneOtpPurpose.LOGIN:
        if (account?.userId) {
          if (account.phoneConfirmed) return;
          throw new PhoneAuthError(PHONE_AUTH_ERROR.PHONE_NOT_VERIFIED);
        }
        // E1: เบอร์อยู่ในโปรไฟล์ของผู้ใช้เดิมแต่ยังไม่เคยยืนยัน → บอกให้ล็อกอินด้วยอีเมลแล้วผูกเบอร์
        //   ★ ตอบต่างจาก "ไม่มีบัญชี" = เปิดเผยว่าเบอร์นี้มีในระบบ — ยอมรับตาม Design PYG-600
        //     ที่เลือกบอกตรง ๆ (E6) ถ้า story เคาะให้ตอบเหมือนกันทุกกรณี แก้ที่ฟังก์ชันนี้จุดเดียว
        if (await this.hasProfilePhone(phone)) {
          throw new PhoneAuthError(PHONE_AUTH_ERROR.PHONE_NOT_VERIFIED);
        }
        throw new PhoneAuthError(PHONE_AUTH_ERROR.PHONE_NOT_REGISTERED);

      case PhoneOtpPurpose.LINK:
        if (!account) return;
        if (caller && account.supabaseUid === caller.supabaseUid) {
          // เบอร์นี้เป็นเบอร์ล็อกอินของผู้เรียกอยู่แล้ว — Supabase จะไม่ส่งรหัส (เบอร์ไม่เปลี่ยน)
          // ผู้ใช้จะรอ SMS ที่ไม่มีวันมา → ตอบทันที และซ่อมเบอร์ในโปรไฟล์ให้ตรง (เกิดได้เมื่อเบอร์ใน
          // โปรไฟล์ถูกแก้ทีหลัง) ซึ่งปลอดภัยเพราะผู้ใช้เคยพิสูจน์ความเป็นเจ้าของเบอร์นี้แล้ว
          await this.prisma.user.update({
            where: { id: caller.id },
            data: { phone: phone.national },
          });
          throw new PhoneAuthError(
            PHONE_AUTH_ERROR.PHONE_ALREADY_IN_USE,
            'เบอร์นี้ผูกกับบัญชีของคุณอยู่แล้ว ใช้เข้าสู่ระบบได้เลย',
          );
        }
        // เบอร์ของบัญชีอื่น (E5) — รวมผู้ใช้ Supabase ที่สมัครค้างไว้ด้วย (Supabase บังคับ unique เอง
        // ส่งไปก็ได้ phone_exists อยู่ดี) · ดู contract §10 ข้อ 9
        throw new PhoneAuthError(PHONE_AUTH_ERROR.PHONE_ALREADY_IN_USE);
    }
  }

  /** มีบัญชี (ที่ยังไม่ถูกลบ) กรอกเบอร์นี้ไว้ในโปรไฟล์หรือไม่ — ทุกรูปแบบการเขียนเบอร์ */
  private async hasProfilePhone(phone: ThaiMobile): Promise<boolean> {
    const row = await this.prisma.user.findFirst({
      where: { phone: { in: profilePhoneVariants(phone) }, is_deleted: false },
      select: { id: true },
    });
    return row !== null;
  }

  /** แปลงความล้มเหลวตอนส่งรหัสเป็น error ของ contract */
  private toSendError(
    err: unknown,
    purpose: PhoneOtpPurpose,
    phone: ThaiMobile,
  ): Error {
    const failure = asGatewayError(err);
    this.logger.warn({
      event: 'phone_otp.send_failed',
      purpose,
      phone: maskPhone(phone),
      kind: failure.kind,
      detail: redactPhones(failure.detail),
    });
    switch (failure.kind) {
      case 'rate_limited':
        return otpRateLimitedError(
          failure.retryAfterSeconds ?? this.config.resendCooldownSeconds,
        );
      case 'phone_taken':
        return new PhoneAuthError(PHONE_AUTH_ERROR.PHONE_ALREADY_IN_USE);
      case 'no_account':
        return new PhoneAuthError(PHONE_AUTH_ERROR.PHONE_NOT_REGISTERED);
      case 'phone_invalid':
        return new PhoneAuthError(PHONE_AUTH_ERROR.PHONE_INVALID_FORMAT);
      case 'session_invalid':
        // LINK: token หมดอายุระหว่างทาง (หลังผ่าน guard) → ให้ FE พาไปล็อกอินใหม่
        return new UnauthorizedException('Invalid or expired token');
      default:
        // sms_failed / unavailable — E11: ผู้ใช้เห็นข้อความ และไม่นับเป็นการกรอกผิด
        return new PhoneAuthError(PHONE_AUTH_ERROR.SMS_SEND_FAILED);
    }
  }

  // ═══ verifyPhoneOtp (SIGNUP) ═══════════════════════════════════════════════

  /**
   * ตรวจรหัสของการสมัคร → ตั๋วสำหรับสร้างบัญชีหลังยอมรับเงื่อนไข (contract §4.2)
   * ★ ยังไม่สร้างแถวใน public.users (E12, PYG-474)
   */
  async verifySignupOtp(
    input: VerifyPhoneOtpInput,
  ): Promise<PhoneVerificationPayload> {
    if (input.purpose !== PhoneOtpPurpose.SIGNUP) {
      throw new GraphQLError(
        'verifyPhoneOtp ใช้กับการสมัคร (SIGNUP) เท่านั้น — ล็อกอินใช้ loginWithPhone, ผูกเบอร์ใช้ linkPhone',
        { extensions: { code: 'BAD_USER_INPUT' } },
      );
    }
    const phone = this.parsePhone(input.phone);
    const session = await this.verifyCode('sms', phone, input.code, (code) =>
      this.gateway.verifySmsOtp(phone.e164, code),
    );

    // มีคนผูกเบอร์นี้สำเร็จระหว่างที่ผู้ใช้รอ SMS → รหัสเปิด session ของบัญชีนั้นได้
    // ★ ห้ามคืนอะไรที่มี session ของบัญชีนั้น — ตอบว่าเบอร์มีเจ้าของแล้ว ให้ไปล็อกอิน
    if (await this.hasUserFor(session.supabaseUid)) {
      throw new PhoneAuthError(PHONE_AUTH_ERROR.PHONE_ALREADY_IN_USE);
    }

    const ttl = this.config.verificationTokenTtlSeconds;
    const verificationToken = this.tokens.seal(
      { uid: session.supabaseUid, phone: phone.e164, rt: session.refreshToken },
      ttl,
      Date.now(),
    );
    this.logger.log({
      event: 'phone_signup.verified',
      phone: maskPhone(phone),
    });
    return { verificationToken, expiresInSeconds: ttl };
  }

  // ═══ signUpWithPhone ═══════════════════════════════════════════════════════

  /**
   * สร้างบัญชีด้วยเบอร์ที่ยืนยันแล้ว (contract §4.3) — response รูปเดียวกับ register
   *
   * ลำดับ (สำคัญ):
   *   1. ความยินยอม — ก่อนทุกอย่าง แบบเดียวกับ register (PYG-474)
   *   2. ตั๋ว — ปลอม / หมดอายุ → PHONE_VERIFICATION_EXPIRED
   *   3. บัญชีมีอยู่แล้วหรือยัง — ★ ต้องก่อนแตะ refresh token: Supabase จับการใช้ refresh token ซ้ำ
   *      แล้วอาจเพิกถอน session ทั้งสาย ถ้าคนส่งตั๋วเดิมซ้ำหลังสมัครเสร็จ session ที่เพิ่งได้จะหลุด
   *   4. แลก refresh token เป็น session ใหม่
   *   5. users + user_consents (+ caregivers) ในทรานแซคชันเดียว
   */
  async signUp(
    input: SignUpWithPhoneInput,
    evidence: RequestEvidence,
  ): Promise<AuthPayload> {
    // ── 1. ความยินยอม ──
    const consents = input.consents ?? [];
    this.consentService.assertAnswersForSource(
      consents,
      CONSENT_SOURCE.REGISTER,
    );

    // ── 2. ตั๋ว ──
    const claims = this.tokens.open(input.verificationToken, Date.now());
    const phone = claims ? parseThaiMobile(claims.phone) : null;
    if (!claims || !phone) {
      throw new PhoneAuthError(PHONE_AUTH_ERROR.PHONE_VERIFICATION_EXPIRED);
    }

    // ── 3. สมัครไปแล้ว (ส่งตั๋วซ้ำ / กดสมัครสองครั้ง) ──
    if (await this.hasUserFor(claims.uid)) {
      throw new PhoneAuthError(PHONE_AUTH_ERROR.PHONE_ALREADY_IN_USE);
    }

    // ── 4. session ──
    let session: PhoneSession;
    try {
      session = await this.gateway.refreshSession(claims.rt);
    } catch (err) {
      const failure = asGatewayError(err);
      if (failure.kind === 'session_invalid') {
        throw new PhoneAuthError(PHONE_AUTH_ERROR.PHONE_VERIFICATION_EXPIRED);
      }
      this.logger.error({
        event: 'phone_signup.refresh_failed',
        kind: failure.kind,
        detail: redactPhones(failure.detail),
      });
      throw phoneAuthUnavailableError();
    }
    if (session.supabaseUid !== claims.uid) {
      // ไม่ควรเกิด — refresh token ของคนหนึ่งให้ session ของอีกคนไม่ได้ · ปฏิเสธไว้ก่อน
      this.logger.error({ event: 'phone_signup.uid_mismatch' });
      throw new PhoneAuthError(PHONE_AUTH_ERROR.PHONE_VERIFICATION_EXPIRED);
    }

    // ── 5. สร้างบัญชี ──
    const isCaregiver = input.role === ROLE_ID.CAREGIVER;
    const caregiverNumber = isCaregiver
      ? await this.caregiverService.generateCaregiverNumber()
      : undefined;

    let created: PrismaUserRow;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            supabaseUid: claims.uid,
            // email ไม่ใส่ = NULL — บัญชีนี้ไม่มีอีเมล (PYG-602 ถอด NOT NULL แล้ว)
            // ★ phone ต้องมีเสมอ ไม่งั้นชน CHECK users_email_or_phone_check
            phone: phone.national,
            role: input.role,
            // ไม่มีอีเมลให้ตัด prefix เป็นชื่อเริ่มต้นแบบ register → null
            // FE แสดงเบอร์แทนผ่าน accountContact() · Onboarding ทับด้วยชื่อจริงได้ (isSystemDefaultDisplayName)
            displayName: null,
            isActive: true,
            ...(isCaregiver
              ? {
                  caregiver: { create: { caregiverNumber, kycStatus: 'none' } },
                }
              : {}),
          },
        });
        // ★ บันทึกทุกข้อที่ส่งมา รวมข้อที่ไม่ยินยอม — เหตุผลเดียวกับ register (PYG-474)
        await this.consentService.recordMany(tx, user.id, consents, {
          ...evidence,
          source: CONSENT_SOURCE.REGISTER,
        });
        return user;
      });
    } catch (err) {
      // สองคำขอสมัครด้วยตั๋ว/เบอร์เดียวกันพร้อมกัน → supabase_uid ชน unique → ได้บัญชีเดียว
      if (isUniqueViolationOn(err, 'supabase')) {
        throw new PhoneAuthError(PHONE_AUTH_ERROR.PHONE_ALREADY_IN_USE);
      }
      this.logger.error({
        event: 'phone_signup.db_failed',
        reason: err instanceof Error ? err.message : String(err),
      });
      // ★ ไม่ลบผู้ใช้ Supabase (ต่างจาก register) — เบอร์ยืนยันแล้วจริง ผู้ใช้ลองสมัครใหม่ได้เลย (E12)
      throw new InternalServerErrorException('Failed to create user account');
    }

    // ★ ไม่ log เบอร์/อีเมล — id + role พอสำหรับไล่ปัญหา (แนวเดียวกับ register)
    this.logger.log({
      event: 'auth.phone_signup.user_created',
      userId: created.id,
      role: created.role,
      consentCount: consents.length,
    });

    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      user: this.userService.mapToEntity(created),
    };
  }

  // ═══ loginWithPhone ════════════════════════════════════════════════════════

  /** ล็อกอินด้วยเบอร์และรหัส (contract §4.4) — response รูปเดียวกับ login อีเมล (S07-AC5) */
  async login(input: LoginWithPhoneInput): Promise<AuthPayload> {
    const phone = this.parsePhone(input.phone);
    const session = await this.verifyCode('sms', phone, input.code, (code) =>
      this.gateway.verifySmsOtp(phone.e164, code),
    );

    const user = await this.prisma.user.findUnique({
      where: { supabaseUid: session.supabaseUid },
    });
    if (!user) {
      // ยืนยันรหัสผ่านแต่ไม่มีบัญชีในระบบเรา (สมัครค้างไว้) — ปกติถูกกันตั้งแต่ขอรหัสแล้ว
      throw new PhoneAuthError(PHONE_AUTH_ERROR.PHONE_NOT_REGISTERED);
    }

    // บันทึก last_login_at แบบเดียวกับ login อีเมล (fire-and-forget)
    void this.prisma.user
      .update({ where: { id: user.id }, data: { last_login_at: new Date() } })
      .catch(() => {
        /* non-critical */
      });

    this.logger.log({ event: 'auth.phone_login', userId: user.id });
    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      user: this.userService.mapToEntity(user),
    };
  }

  // ═══ linkPhone ═════════════════════════════════════════════════════════════

  /**
   * ผูกเบอร์กับบัญชีของผู้ที่ล็อกอินอยู่ (contract §4.5 · S07-AC6)
   * R6: ไม่มี userId ใน input — ผูกกับ caller (จาก session) เท่านั้น
   */
  async link(caller: AuthUser, input: LinkPhoneInput): Promise<User> {
    const phone = this.parsePhone(input.phone);
    const result = await this.verifyCode(
      'phone_change',
      phone,
      input.code,
      (code) => this.gateway.verifyPhoneChangeOtp(phone.e164, code),
    );

    if (result.supabaseUid !== caller.supabaseUid) {
      // รหัสนี้เป็นของการผูกเบอร์ของผู้ใช้อื่น (คนละคนขอผูกเบอร์เดียวกัน) — Supabase ผูกให้เจ้าของรหัสไปแล้ว
      // ผู้เรียกไม่ได้อะไร และไม่บอกว่าเป็นของใคร
      this.logger.warn({
        event: 'phone_link.uid_mismatch',
        userId: caller.id,
        phone: maskPhone(phone),
      });
      throw new PhoneAuthError(PHONE_AUTH_ERROR.OTP_INVALID);
    }

    // Supabase ผูกเบอร์ล็อกอินแล้ว → เขียนเบอร์ในโปรไฟล์ให้ตรงกัน (me.phone + phoneVerified ตรงกันทันที)
    const updated = await this.prisma.user.update({
      where: { id: caller.id },
      data: { phone: phone.national },
    });
    this.logger.log({
      event: 'phone_link.linked',
      userId: caller.id,
      phone: maskPhone(phone),
    });
    return this.userService.mapToEntity(updated);
  }

  // ═══ User.phoneVerified ════════════════════════════════════════════════════

  /**
   * เบอร์ในโปรไฟล์คือเบอร์ที่ยืนยันแล้วและใช้ล็อกอินได้หรือไม่ (contract §4.6)
   *
   * ต้องตรงสองข้อ: Supabase ยืนยันเบอร์ล็อกอินแล้ว **และ** เป็นเบอร์เดียวกับในโปรไฟล์
   * ★ ถ้าดูแค่ข้อแรก: ผู้ใช้ที่แก้เบอร์ในโปรไฟล์เป็นเบอร์อื่นทีหลัง จะเห็นป้าย "ยืนยันแล้ว" ติดเบอร์ที่ไม่เคยยืนยัน
   */
  async isPhoneVerified(
    userId: string,
    profilePhone: string | null | undefined,
  ): Promise<boolean> {
    if (!profilePhone) return false;
    const status = await this.gateway.loginPhoneStatus(userId);
    return (
      Boolean(status?.confirmed) && isSamePhone(status?.phone, profilePhone)
    );
  }

  // ═══ ภายใน ═════════════════════════════════════════════════════════════════

  private parsePhone(raw: string): ThaiMobile {
    const phone = parseThaiMobile(raw);
    if (!phone) throw new PhoneAuthError(PHONE_AUTH_ERROR.PHONE_INVALID_FORMAT);
    return phone;
  }

  private async hasUserFor(supabaseUid: string): Promise<boolean> {
    const row = await this.prisma.user.findUnique({
      where: { supabaseUid },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * ตรวจรหัสพร้อมนับครั้งที่กรอก — ใช้ร่วมกันทั้ง verifyPhoneOtp / loginWithPhone / linkPhone
   *
   *   1. จองครั้งที่กรอก (ครบแล้ว → OTP_ATTEMPTS_EXCEEDED ไม่เรียก Supabase · E9)
   *   2. รหัสผิดรูปแบบ → นับเป็นกรอกผิด ไม่เรียก Supabase
   *   3. ส่งให้ Supabase ตรวจ
   *      - ผ่าน → ลืมรหัสชุดนี้
   *      - รหัสถูกปฏิเสธ → OTP_EXPIRED / OTP_ATTEMPTS_EXCEEDED / OTP_INVALID
   *      - ระบบล้ม → คืนครั้งที่จองไว้ (ไม่นับเป็นกรอกผิด · E11) แล้วแปลง error
   */
  private async verifyCode<T>(
    channel: OtpChannel,
    phone: ThaiMobile,
    rawCode: string,
    check: (code: string) => Promise<T>,
  ): Promise<T> {
    if (!this.tracker.reserveAttempt(channel, phone.e164, Date.now())) {
      throw new PhoneAuthError(PHONE_AUTH_ERROR.OTP_ATTEMPTS_EXCEEDED);
    }

    const code = typeof rawCode === 'string' ? rawCode.trim() : '';
    if (!OTP_CODE_PATTERN.test(code)) {
      throw this.rejectionError(channel, phone);
    }

    try {
      const result = await check(code);
      this.tracker.markVerified(channel, phone.e164);
      return result;
    } catch (err) {
      const failure = asGatewayError(err);
      if (failure.kind === 'otp_rejected')
        throw this.rejectionError(channel, phone);

      this.tracker.refundAttempt(channel, phone.e164);
      switch (failure.kind) {
        case 'rate_limited':
          throw otpRateLimitedError(
            failure.retryAfterSeconds ?? this.config.resendCooldownSeconds,
          );
        case 'phone_taken':
          throw new PhoneAuthError(PHONE_AUTH_ERROR.PHONE_ALREADY_IN_USE);
        case 'no_account':
          throw new PhoneAuthError(PHONE_AUTH_ERROR.PHONE_NOT_REGISTERED);
        case 'phone_invalid':
          throw new PhoneAuthError(PHONE_AUTH_ERROR.PHONE_INVALID_FORMAT);
        default:
          this.logger.error({
            event: 'phone_otp.verify_failed',
            channel,
            phone: maskPhone(phone),
            kind: failure.kind,
            detail: redactPhones(failure.detail),
          });
          throw phoneAuthUnavailableError();
      }
    }
  }

  /** รหัสถูกปฏิเสธ → error ตามสถานะของรหัสชุดนั้น (ไม่ log รหัส — R10) */
  private rejectionError(
    channel: OtpChannel,
    phone: ThaiMobile,
  ): PhoneAuthError {
    const verdict = this.tracker.rejectionVerdict(
      channel,
      phone.e164,
      Date.now(),
    );
    this.logger.log({
      event: 'phone_otp.rejected',
      channel,
      phone: maskPhone(phone),
      verdict,
    });
    switch (verdict) {
      case 'expired':
        return new PhoneAuthError(PHONE_AUTH_ERROR.OTP_EXPIRED);
      case 'exceeded':
        return new PhoneAuthError(PHONE_AUTH_ERROR.OTP_ATTEMPTS_EXCEEDED);
      default:
        return new PhoneAuthError(PHONE_AUTH_ERROR.OTP_INVALID);
    }
  }
}

/** อะไรก็ตามที่ gateway โยนมา → PhoneGatewayError (error ที่ไม่รู้จัก = unavailable) */
function asGatewayError(err: unknown): PhoneGatewayError {
  if (err instanceof PhoneGatewayError) return err;
  return new PhoneGatewayError(
    'unavailable',
    undefined,
    err instanceof Error ? err.message : String(err),
  );
}

/**
 * ลบเลขที่ยาวพอจะเป็นเบอร์ออกจากข้อความก่อนเขียน log (R10)
 * ข้อความ error ของผู้ให้บริการ SMS บางเจ้าใส่เบอร์ปลายทางมาด้วย เช่น "The 'To' number +66… is not valid"
 */
function redactPhones(text: string | undefined): string | undefined {
  return text?.replace(/\+?\d[\d\s-]{7,}\d/g, '[phone]');
}

/** Prisma P2002 (unique ชน) บนคอลัมน์ที่ชื่อมีคำนี้หรือไม่ */
function isUniqueViolationOn(err: unknown, columnHint: string): boolean {
  const e = err as { code?: unknown; meta?: { target?: unknown } } | null;
  if (!e || e.code !== 'P2002') return false;
  const target = e.meta?.target;
  // Prisma ใส่ target เป็น array ของชื่อ field หรือเป็นชื่อ constraint (string) แล้วแต่ฐานข้อมูล
  const text = Array.isArray(target)
    ? target.join(',')
    : typeof target === 'string'
      ? target
      : '';
  return text.toLowerCase().includes(columnHint);
}
