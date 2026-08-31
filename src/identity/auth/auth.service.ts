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

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly prismaService: PrismaService,
    private readonly configService: ConfigService,
    private readonly caregiverService: CaregiverService,
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
   * Register ด้วย email + password + role
   *
   * Flow:
   *   1. สร้าง user ใน Supabase Auth (จัดการ password ให้)
   *   2. INSERT row ลง users table ของเรา (เก็บ role, displayName ฯลฯ)
   *   3. คืน { accessToken, refreshToken, user } เหมือน login
   *
   * ทำไมต้อง 2 ขั้น?
   *   Supabase Auth รู้แค่ email+password
   *   users table ของเราเก็บข้อมูล business เช่น role, displayName
   *   ต้องสร้างทั้งสองพร้อมกันเสมอ ถ้าขาดอันใดอันหนึ่ง → ระบบพัง
   */
  async register(input: RegisterInput): Promise<AuthPayload> {
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

    // ── ขั้นตอนที่ 3: สร้าง row ใน users table ของเรา ─────────────────
    // ทำหลังจาก Supabase สำเร็จเท่านั้น
    // supabase_uid คือ bridge ที่เชื่อม Supabase Auth ↔ users table เรา
    let user;
    try {
      // Generate caregiverNumber ก่อน ถ้า role เป็น caregiver
      let caregiverNumber: string | undefined;
      if (input.role === 2) {
        caregiverNumber = await this.caregiverService.generateCaregiverNumber();
        console.log('[AuthService.register] Generated caregiverNumber:', caregiverNumber);
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

      console.log('[AuthService.register] Creating user with data:', JSON.stringify(createData, null, 2));

      user = await this.prismaService.user.create({
        data: createData,
      });

      console.log('[AuthService.register] User created successfully:', user.id);
    } catch (err: any) {
      // ถ้า user สร้างล้มเหลว ให้ลบ user จาก Supabase ด้วย
      console.error('[AuthService.register] Failed to create user in database:', err);
      
      // ลองลบ Supabase user
      try {
        const adminAuthClient = createClient(
          this.configService.getOrThrow<string>('SUPABASE_URL'),
          this.configService.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY'),
        );
        await adminAuthClient.auth.admin.deleteUser(data.user.id);
      } catch (deleteErr) {
        console.error('[AuthService.register] Failed to rollback Supabase user:', deleteErr);
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
