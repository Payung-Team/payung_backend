/**
 * AuthService — Business logic สำหรับ Authentication (login, register, logout)
 *
 * ทำไมแยก Service ออกจาก Resolver?
 * - Resolver = ตัวรับ GraphQL request (เหมือนพนักงานต้อนรับ)
 * - Service  = ตัวทำงานจริง (เหมือนพ่อครัว)
 * - แยกกันทำให้โค้ดเป็นระเบียบ ง่ายต่อการ test และ maintain
 *
 * Flow การ login:
 *   Client ส่ง email+password → Resolver รับ → Service ทำงาน:
 *   1. ส่ง email+password ไป Supabase Auth ตรวจสอบ
 *   2. ถ้าถูกต้อง → ได้ session (token) กลับมา
 *   3. ใช้ supabase_uid ไปหา user ในตาราง users ของเรา
 *   4. ส่ง { accessToken, refreshToken, user } กลับไปให้ client
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GraphQLError } from 'graphql';
import { createClient } from '@supabase/supabase-js';
import { SupabaseService } from '../../common/supabase.service';
import { PrismaService } from '../../common/prisma.service';
import { LoginInput } from './dto/login.input';
import { AuthPayload } from '../models/auth-payload.model';
import { RegisterInput } from './dto/register.input';
import { RequestPasswordResetResponse } from './dto/request-password-reset.response';
import { UpdatePasswordResponse } from './dto/update-password.response';
import { CaregiverService } from '../kyc/caregiver.service';
import { ConsentService } from '../../consent/consent.service';
import { CONSENT_SOURCE } from '../../consent/consent.constants';
import type { RequestEvidence } from '../../common/utils/request-evidence';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly prismaService: PrismaService,
    private readonly configService: ConfigService,
    private readonly caregiverService: CaregiverService,
    // PYG-474: ตรวจและบันทึกความยินยอม PDPA ตอนสมัคร
    private readonly consentService: ConsentService,
  ) {}

  /**
   * Login ด้วย email + password
   * @param input - { email, password } ที่ client ส่งมา
   * @returns AuthPayload - { accessToken, refreshToken, user }
   * @throws UnauthorizedException - ถ้า email/password ไม่ถูกต้อง หรือไม่เจอ user
   */
  async login(input: LoginInput): Promise<AuthPayload> {
    const supabase = this.supabaseService.getClient();

    // ขั้นตอนที่ 1: ส่ง email+password ไปให้ Supabase Auth ตรวจสอบ
    // signInWithPassword จะเช็คว่า email นี้มีอยู่จริงไหม และ password ตรงไหม
    // ถ้าถูกต้อง → ได้ data.session (มี access_token + refresh_token)
    // ถ้าผิด → ได้ error กลับมา
    const { data, error } = await supabase.auth.signInWithPassword({
      email: input.email,
      password: input.password,
    });

    // ขั้นตอนที่ 2: ถ้า Supabase บอกว่า login ไม่ผ่าน → โยน error กลับไปบอก client
    if (error || !data.session) {
      throw new UnauthorizedException('Invalid email or password');
    }

    // ขั้นตอนที่ 3: ดึงข้อมูล user จาก database ของเรา
    // ทำไมต้องดึงจาก DB ของเราด้วย?
    // → เพราะ Supabase Auth เก็บแค่ email+password
    //   แต่เราต้องการข้อมูลเพิ่ม เช่น role, displayName, isActive
    //   ซึ่งเก็บในตาราง users ของเรา
    // data.user.id คือ supabase_uid ที่เราใช้เชื่อมโยงกับ user ในระบบเรา
    const user = await this.prismaService.user.findUnique({
      where: { supabaseUid: data.user.id },
    });

    // ขั้นตอนที่ 4: ถ้าไม่เจอ user ในตาราง users ของเรา
    // → แปลว่า Supabase มี account นี้ แต่ยังไม่เคย register ผ่านระบบเรา
    //   (เช่น สร้าง user ตรงใน Supabase dashboard โดยไม่ผ่าน register mutation)
    if (!user) {
      throw new UnauthorizedException('User account not found');
    }

    // ขั้นตอนที่ 5: บันทึก last_login_at (fire-and-forget)
    void this.prismaService.user.update({
      where: { id: user.id },
      data: { last_login_at: new Date() },
    }).catch(() => {/* non-critical */});

    // ขั้นตอนที่ 6: ส่งผลลัพธ์กลับให้ client
    return {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName ?? undefined,
        avatarUrl: user.avatarUrl ?? undefined,
        phone: user.phone ?? undefined,
        address: user.address ?? undefined,
        bio: user.bio ?? undefined,
        role: user.role,
        isActive: user.isActive,
        isSuspended: !user.isActive || user.is_deleted,
        mustChangePassword: user.must_change_password,
        emailPreferences: user.emailPreferences,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
    };
  }

  /**
   * Register ด้วย email + password + role + ความยินยอม PDPA
   *
   * Flow:
   *   0. (PYG-474) ตรวจความยินยอม — ขาดข้อบังคับ/เวอร์ชันไม่ตรง → ปฏิเสธทันที
   *   1. สร้าง user ใน Supabase Auth (จัดการ password ให้)
   *   2. INSERT row ลง users table ของเรา + บันทึกความยินยอมลง user_consents
   *      ในทรานแซคชันเดียวกัน (PYG-474)
   *   3. คืน { accessToken, refreshToken, user } เหมือน login
   *
   * ทำไมต้อง 2 ขั้น?
   *   Supabase Auth รู้แค่ email+password
   *   users table ของเราเก็บข้อมูล business เช่น role, displayName
   *   ต้องสร้างทั้งสองพร้อมกันเสมอ ถ้าขาดอันใดอันหนึ่ง → ระบบพัง
   *
   * @param evidence IP + user agent ที่ resolver ดึงจาก request — หลักฐานประกอบความยินยอม
   */
  async register(
    input: RegisterInput,
    evidence: RequestEvidence,
  ): Promise<AuthPayload> {
    // ── ขั้นตอนที่ 0 (PYG-474): ตรวจความยินยอม "ก่อน" สร้างอะไรทั้งนั้น ──────
    // ★ ต้องอยู่ก่อน supabase.auth.signUp — ถ้าไปตรวจทีหลัง คำขอที่ไม่ยินยอมจะได้บัญชี
    //   Supabase Auth ค้างไว้ (ที่อยู่นอกทรานแซคชันของเรา) แล้วต้องไล่ลบทีหลัง
    //   ตรงกับเงื่อนไขของการ์ด: "ไม่มี required consent ครบ → ปฏิเสธ และไม่สร้าง user"
    // ★ อยู่นอก try/catch ด้านล่างโดยตั้งใจ — catch นั้นแปลงทุก error เป็น 500
    //   ถ้า ConsentError ไปอยู่ในนั้น FE จะไม่ได้ code CONSENT_REQUIRED
    const consents = input.consents ?? [];
    this.consentService.assertAnswersForSource(consents, CONSENT_SOURCE.REGISTER);

    const supabase = this.supabaseService.getClient();

    // ── ขั้นตอนที่ 1: สร้าง user ใน Supabase Auth ──────────────────────
    // signUp จะ hash password ให้อัตโนมัติ (ไม่เก็บ plain text)
    // ถ้า email ซ้ำ Supabase จะ return error
    const { data, error } = await supabase.auth.signUp({
      email: input.email,
      password: input.password,
    });

    // ── ขั้นตอนที่ 2: handle errors จาก Supabase ───────────────────────
    if (error) {
      // email ซ้ำ — Supabase ส่ง message นี้มา
      if (error.message.toLowerCase().includes('already registered')) {
        throw new ConflictException('Email is already in use');
      }

      // password อ่อนเกินไป (Supabase ตรวจสอบ policy)
      if (error.message.toLowerCase().includes('password')) {
        throw new BadRequestException(error.message);
      }

      // error อื่นๆ ที่ไม่คาดคิด
      throw new InternalServerErrorException('Registration failed');
    }

    // ตรวจว่าได้ user กลับมาจริงๆ (กรณี edge case)
    if (!data.user || !data.session) {
      throw new InternalServerErrorException(
        'Registration failed: no user returned',
      );
    }

    // ── ขั้นตอนที่ 3: สร้าง row ใน users table ของเรา + บันทึกความยินยอม ──
    // ทำหลังจาก Supabase สำเร็จเท่านั้น
    // supabase_uid คือ bridge ที่เชื่อม Supabase Auth ↔ users table เรา
    let user;
    try {
      // Generate caregiverNumber ก่อน ถ้า role เป็น caregiver
      let caregiverNumber: string | undefined;
      if (input.role === 2) {
        caregiverNumber = await this.caregiverService.generateCaregiverNumber();
      }

      const createData = {
        supabaseUid: data.user.id, // UUID จาก Supabase
        email: input.email,
        role: input.role, // role ส่งมาเป็นตัวเลข (1 หรือ 2)
        displayName: input.email.split('@')[0], // default จาก email prefix
        isActive: true,
        // หากเป็น caregiver (role=2) ให้สร้าง row ในตาราง caregiver ด้วย
        ...(input.role === 2 ? {
          caregiver: {
            create: {
              caregiverNumber, // เพิ่ม caregiverNumber ตั้งแต่แรก
              kycStatus: 'none',
            }
          }
        } : {})
      };

      // PYG-474 — ★ users + user_consents ต้องอยู่ในทรานแซคชันเดียวกัน
      //   ถ้าแยกกันแล้วฝั่ง consent ล้ม จะได้ user ที่ไม่มีหลักฐานความยินยอมค้างใน DB
      //   (ตรงข้ามกับเงื่อนไขของการ์ด) และแก้ย้อนหลังไม่ได้เพราะ user_consents เป็น append-only
      //   ล้มตรงไหนก็ตาม → DB ย้อนกลับทั้งคู่ แล้ว catch ด้านล่างลบบัญชี Supabase ตามไปด้วย
      user = await this.prismaService.$transaction(async (tx) => {
        const created = await tx.user.create({ data: createData });
        // ★ บันทึกทุกข้อที่ส่งมา รวมข้อที่ไม่ยินยอม (เช่น marketing = false)
        //   การปฏิเสธก็เป็นข้อเท็จจริงที่ต้องพิสูจน์ได้ว่า "เราถามแล้ว และเขาตอบว่าไม่"
        await this.consentService.recordMany(tx, created.id, consents, {
          ...evidence,
          source: CONSENT_SOURCE.REGISTER,
        });
        return created;
      });

      // ★ ไม่ log อีเมล/ข้อมูลที่สมัคร (โค้ดเดิม console.log ทั้งก้อน) — เป็นข้อมูลส่วนบุคคล
      //   ที่ไม่จำเป็นต้องอยู่ใน log ตาม PDPA · id + role พอสำหรับไล่ปัญหา
      this.logger.log({
        event: 'auth.register.user_created',
        userId: user.id,
        role: user.role,
        consentCount: consents.length,
      });
    } catch (err: any) {
      // ถ้า user สร้างล้มเหลว ให้ลบ user จาก Supabase ด้วย
      this.logger.error({
        event: 'auth.register.db_failed',
        supabaseUid: data.user.id,
        reason: err?.message,
      });

      // ลองลบ Supabase user — ใช้ admin client (service role) ตัวกลางของ SupabaseService
      // แทนการสร้าง client ใหม่ทุกครั้ง (PYG-474: ให้เทส mock ได้ และไม่สร้าง client ซ้ำซ้อน)
      try {
        const { error: deleteError } = await this.supabaseService
          .getAdminClient()
          .auth.admin.deleteUser(data.user.id);
        // deleteUser ไม่ throw — คืน error กลับมาแทน ต้องเช็คเอง ไม่งั้นลบไม่สำเร็จแล้วไม่มีใครรู้
        if (deleteError) {
          this.logger.error({
            event: 'auth.register.rollback_failed',
            supabaseUid: data.user.id,
            reason: deleteError.message,
          });
        }
      } catch (deleteErr) {
        this.logger.error({
          event: 'auth.register.rollback_failed',
          supabaseUid: data.user.id,
          reason: deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
        });
      }

      if (err.code === 'P2002') {
        throw new ConflictException('Email is already in use');
      }
      throw new InternalServerErrorException('Failed to create user account in database: ' + err.message);
    }

    // ── ขั้นตอนที่ 4: คืนผลลัพธ์เหมือน login ──────────────────────────
    return {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName ?? undefined,
        avatarUrl: user.avatarUrl ?? undefined,
        phone: user.phone ?? undefined,
        address: user.address ?? undefined,
        bio: user.bio ?? undefined,
        role: user.role,
        isActive: user.isActive,
        isSuspended: !user.isActive || user.is_deleted,
        mustChangePassword: user.must_change_password,
        emailPreferences: user.emailPreferences,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
    };
  }

  /**
   * confirmOAuthRole — แก้ไข role ให้ตรงกับที่ผู้ใช้เลือกไว้ก่อนกด "สมัครด้วย Google"
   *
   * ทำไมต้องมี mutation นี้?
   *   register() (ด้านบน) รับ input.role มาจาก client โดยตรง แต่ signInWithOAuth()
   *   (Register.tsx) ไม่มีช่องทางส่ง role ไปกับ Supabase OAuth redirect เลย —
   *   บัญชีที่ auth.users trigger สร้างให้จึงตกไปใช้ role default = 1 (patient) เสมอ
   *   ไม่ว่าผู้ใช้จะเลือก "ผู้ดูแล" ไว้ก่อนกด Google ก็ตาม
   *
   *   Frontend เก็บ role ที่เลือกไว้ใน localStorage ก่อน redirect แล้วเรียก mutation
   *   นี้ทันทีที่กลับมาที่ /auth/callback เพื่อ "แก้" ให้ตรงกับที่เลือกไว้
   *
   * Guard rails (กันไม่ให้กลายเป็นช่องทาง escalate role ของบัญชีเก่า):
   *   - รับได้แค่ role 1 (patient) หรือ 2 (caregiver) เท่านั้น ห้ามตั้งเป็น admin
   *   - ใช้ได้เฉพาะบัญชีที่เพิ่งสร้างใหม่ (อายุ < 15 นาที) และยัง role default (1)
   *     และยังไม่มี caregiver row — เงื่อนไขอื่นนอกเหนือจากนี้ถือเป็น no-op
   *     (คืนค่า user ปัจจุบันเฉยๆ ไม่ throw เพราะกรณีปกติคือ role ตรงอยู่แล้ว)
   */
  async confirmOAuthRole(userId: string, role: number): Promise<AuthPayload['user']> {
    if (role !== 1 && role !== 2) {
      throw new BadRequestException('Invalid role');
    }

    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
      include: { caregiver: true },
    });

    if (!user) {
      throw new UnauthorizedException('User account not found');
    }

    const ACCOUNT_AGE_LIMIT_MS = 15 * 60 * 1000;
    const isEligibleForCaregiverFix =
      role === 2 &&
      user.role === 1 &&
      !user.caregiver &&
      Date.now() - user.createdAt.getTime() < ACCOUNT_AGE_LIMIT_MS;

    let finalUser = user;
    if (isEligibleForCaregiverFix) {
      const caregiverNumber = await this.caregiverService.generateCaregiverNumber();
      finalUser = await this.prismaService.user.update({
        where: { id: user.id },
        data: {
          role: 2,
          caregiver: { create: { caregiverNumber, kycStatus: 'none' } },
        },
        include: { caregiver: true },
      });
    }

    return {
      id: finalUser.id,
      email: finalUser.email,
      displayName: finalUser.displayName ?? undefined,
      avatarUrl: finalUser.avatarUrl ?? undefined,
      phone: finalUser.phone ?? undefined,
      address: finalUser.address ?? undefined,
      bio: finalUser.bio ?? undefined,
      role: finalUser.role,
      isActive: finalUser.isActive,
      isSuspended: !finalUser.isActive || finalUser.is_deleted,
      mustChangePassword: finalUser.must_change_password,
      emailPreferences: finalUser.emailPreferences,
      createdAt: finalUser.createdAt,
      updatedAt: finalUser.updatedAt,
    };
  }

  /**
   * Logout session
   *
   * กระบวนการ:
   * 1. สร้าง temp client ชั่วคราวที่มี Auth Header เป็น token ปัจจุบัน
   * 2. เรียก signOut() เพื่อทำลาย session ของ token นั้นๆ บน Supabase
   * 3. บันทึก logout event ในฐานข้อมูล
   * 
   * ทำไมต้องบันทึก logout?
   * - ติดตามเมื่อ user ออกระบบ
   * - ใช้สำหรับการ audit trail
   * - หากต้องการ invalidate refresh token ด้วย
   */
  async logout(accessToken: string): Promise<boolean> {
    const supabaseUrl = this.configService.getOrThrow<string>('SUPABASE_URL');
    const supabaseKey = this.configService.getOrThrow<string>('SUPABASE_ANON_KEY');

    const tempClient = createClient(supabaseUrl, supabaseKey, {
      global: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    });

    // ขั้นตอนที่ 1: ทำลาย session บน Supabase
    const { error } = await tempClient.auth.signOut();

    if (error) {
      throw new InternalServerErrorException('Logout failed: ' + error.message);
    }

    // ขั้นตอนที่ 2: หา user และบันทึก logout event (optional)
    // ได้ session data จาก accessToken เพื่อหา user
    try {
      const { data } = await tempClient.auth.getUser();
      
      if (data.user) {
        // เราสามารถบันทึก logout event ที่นี่
        // เช่น update lastLogout timestamp, log activity, หรือสิ่งอื่นๆ
        // ตัวอย่าง:
        // await this.prismaService.user.update({
        //   where: { supabaseUid: data.user.id },
        //   data: { lastLogoutAt: new Date() },
        // });
      }
    } catch {
      // ถ้ามี error ตอน get user ไม่ต้องไป throw
      // เพราะ signOut() สำเร็จแล้ว ส่วน logging เป็น optional
    }

    return true;
  }

  /**
   * Send a password reset email to the given address.
   *
   * Always returns success=true regardless of whether the email exists in the
   * system, to prevent user enumeration attacks.  Supabase errors (e.g. rate
   * limit) are logged internally but never surfaced to the caller.
   *
   * @param email - Target email address
   */
  async requestPasswordReset(email: string): Promise<RequestPasswordResetResponse> {
    const supabase   = this.supabaseService.getClient();
    const frontendUrl = this.configService.get<string>('FRONTEND_URL', 'http://localhost:5173');

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${frontendUrl}/reset-password`,
    });

    if (error) {
      this.logger.error({ event: 'password_reset.request_failed', email, msg: error.message });
    }

    return {
      success: true,
      message: 'หากอีเมลนี้มีอยู่ในระบบ ลิงก์รีเซ็ตรหัสผ่านจะถูกส่งไปยังอีเมลของคุณ',
    };
  }

  /**
   * Update the password of the currently authenticated user.
   *
   * The caller must hold a valid Supabase session obtained from the
   * password-reset magic link (passed as the Bearer token).  A scoped
   * temporary client is created per-request so that updateUser() targets
   * the correct account — the same pattern used by logout().
   *
   * @param accessToken - Bearer token extracted from the Authorization header
   * @param newPassword - New password (min-length validated at DTO level)
   * @throws GraphQLError if Supabase rejects the update (expired link, etc.)
   */
  async updatePassword(
    accessToken: string,
    newPassword: string,
  ): Promise<UpdatePasswordResponse> {
    const supabaseUrl = this.configService.getOrThrow<string>('SUPABASE_URL');
    const supabaseKey = this.configService.getOrThrow<string>('SUPABASE_ANON_KEY');

    const tempClient = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    const { error } = await tempClient.auth.updateUser({ password: newPassword });

    if (error) {
      this.logger.error({ event: 'password_reset.update_failed', msg: error.message });
      throw new GraphQLError(
        'ไม่สามารถเปลี่ยนรหัสผ่านได้ ลิงก์อาจหมดอายุ กรุณาขอลิงก์ใหม่',
      );
    }

    return { success: true, message: 'เปลี่ยนรหัสผ่านสำเร็จ' };
  }
}
