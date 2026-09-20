/**
 * AuthResolver — GraphQL Resolver สำหรับ Authentication
 *
 * Resolver คืออะไร?
 * - คือ "ตัวรับ request" จาก GraphQL
 * - เหมือน Controller ใน REST API แต่สำหรับ GraphQL
 * - @Mutation = รับ request ที่เปลี่ยนแปลงข้อมูล (login, register, logout, updateProfile)
 * - @Query   = รับ request ที่แค่อ่านข้อมูล (me)
 *
 * Resolver ไม่ควรมี business logic ซับซ้อน — มันแค่รับ request แล้วส่งต่อให้ Service ทำงาน
 */
import { UseGuards } from '@nestjs/common';
import { Resolver, Mutation, Query, Args, Context, Int } from '@nestjs/graphql';
import { AuthPayload } from '../models/auth-payload.model';
import { LoginInput } from './dto/login.input';
import { RegisterInput } from './dto/register.input';
import { UpdateProfileInput } from './dto/update-profile.input';
import { RequestPasswordResetInput } from './dto/request-password-reset.input';
import { RequestPasswordResetResponse } from './dto/request-password-reset.response';
import { UpdatePasswordInput } from './dto/update-password.input';
import { UpdatePasswordResponse } from './dto/update-password.response';
import { AuthService } from './auth.service';
import { UserService } from './user.service';
import { User } from './entities/user.entity';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { FieldLockGuard } from '../../common/guards/field-lock.guard';
import { FieldLock } from '../../common/decorators/field-lock.decorator';
import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';
import type { GqlContext } from '../../common/types/gql-context.type';

@Resolver()
export class AuthResolver {
  constructor(
    private authService: AuthService,
    private userService: UserService,
  ) {}

  @Mutation(() => AuthPayload, { description: 'Login user with email and password' })
  async login(@Args('input') input: LoginInput): Promise<AuthPayload> {
    return this.authService.login(input);
  }

  @Mutation(() => AuthPayload, { description: 'Register a new user' })
  async register(@Args('input') input: RegisterInput): Promise<AuthPayload> {
    return this.authService.register(input);
  }

  @Mutation(() => Boolean, { description: 'Logout user' })
  @UseGuards(SupabaseAuthGuard)
  async logout(@Context() ctx: GqlContext): Promise<boolean> {
    const token = ctx.req.headers.authorization!.split(' ')[1];
    return this.authService.logout(token);
  }

  /**
   * confirmOAuthRole (PYG bug fix) — เรียกจาก AuthCallback ทันทีหลังกลับจาก Google OAuth
   * เพื่อแก้ role ให้ตรงกับที่ผู้ใช้เลือกไว้ก่อนกด "สมัครด้วย Google" บนหน้า Register
   * (Supabase OAuth ไม่มีช่องส่ง role ผ่าน redirect ไป Google แล้วกลับมาได้เอง)
   *
   * No-op ปลอดภัยสำหรับ login ปกติ/บัญชีเก่า — ดู guard rails ใน AuthService.confirmOAuthRole
   */
  @Mutation(() => User, {
    description:
      'Fix a fresh Google OAuth signup account\'s role to match what the user picked before ' +
      'being redirected to Google. Safe no-op for existing accounts or already-correct roles.',
  })
  @UseGuards(SupabaseAuthGuard)
  async confirmOAuthRole(
    @CurrentUser() user: AuthUser,
    @Args('role', { type: () => Int, description: '1 = patient, 2 = caregiver' }) role: number,
  ): Promise<User> {
    return this.authService.confirmOAuthRole(user.id, role);
  }

  // ─── Profile endpoints (ต้อง login ก่อน) ──────────────────────────────

  @Query(() => User, { name: 'me', description: 'Get current logged-in user' })
  @UseGuards(SupabaseAuthGuard)
  async me(@CurrentUser() user: AuthUser): Promise<User> {
    return this.userService.findById(user.id);
  }

  // PYG-146: FieldLockGuard เช็คก่อนว่า field ที่จะแก้ถูก admin lock ไว้ไหม
  // ลำดับ guard: SupabaseAuthGuard (inject user) → FieldLockGuard (ใช้ user)
  // @FieldLock('USER') บอก guard ว่า mutation นี้แก้ข้อมูลในตาราง users
  @Mutation(() => User, { description: 'Update current user profile' })
  @UseGuards(SupabaseAuthGuard, FieldLockGuard)
  @FieldLock('USER')
  async updateProfile(
    @CurrentUser() user: AuthUser,
    @Args('input') input: UpdateProfileInput,
  ): Promise<User> {
    return this.userService.updateProfile(user.id, input);
  }

  /**
   * completePasswordChange — ล้าง mustChangePassword flag หลัง admin-invited user เปลี่ยน password
   *
   * Flow (FE side):
   *   1. FE เรียก supabase.auth.updateUser({ password: newPassword }) — เปลี่ยน password จริง
   *   2. FE เรียก mutation นี้ — ล้าง flag ใน DB
   *   3. FE redirect ไป dashboard
   *
   * ไม่รับ input — ทำงานบน currentUser ที่ authenticated อยู่เสมอ
   *
   * @throws BadRequestException ถ้า mustChangePassword เป็น false อยู่แล้ว
   */
  @Mutation(() => User, {
    description: 'Clear the mustChangePassword flag after the user has changed their password via Supabase Auth. ' +
      'Call this AFTER supabase.auth.updateUser({ password }) succeeds on the frontend.',
  })
  @UseGuards(SupabaseAuthGuard)
  async completePasswordChange(@CurrentUser() user: AuthUser): Promise<User> {
    return this.userService.completePasswordChange(user.id);
  }

  // ─── Password reset (PYG-236) ───────────────────────────────────────────

  /**
   * requestPasswordReset — ส่งอีเมลรีเซ็ตรหัสผ่าน (public endpoint, no auth required)
   *
   * Always returns success=true to prevent user enumeration.
   */
  @Mutation(() => RequestPasswordResetResponse, {
    description:
      'Send a password reset link to the given email address. ' +
      'Always returns success=true regardless of whether the email exists.',
  })
  async requestPasswordReset(
    @Args('input') input: RequestPasswordResetInput,
  ): Promise<RequestPasswordResetResponse> {
    return this.authService.requestPasswordReset(input.email);
  }

  /**
   * updatePassword (PYG-237) — ตั้งรหัสผ่านใหม่หลังจากคลิก reset link ในอีเมล
   *
   * Requires a valid Supabase session obtained from the password-reset magic
   * link — the frontend sets the session from the URL hash before calling this.
   */
  @Mutation(() => UpdatePasswordResponse, {
    description:
      "Update the current user's password. " +
      'Requires a valid session established via the password-reset magic link.',
  })
  @UseGuards(SupabaseAuthGuard)
  async updatePassword(
    @Args('input') input: UpdatePasswordInput,
    @Context() ctx: GqlContext,
  ): Promise<UpdatePasswordResponse> {
    const token = ctx.req.headers.authorization!.split(' ')[1];
    return this.authService.updatePassword(token, input.newPassword);
  }

  /**
   * updateEmailPreference (PYG-97) — เปิด/ปิดรับอีเมลแจ้งเตือน
   *
   * mutation {
   *   updateEmailPreference(enabled: false) { id emailPreferences }
   * }
   *
   * เมื่อ false → EmailService จะ skip การส่งอีเมลทุกชนิดให้ user คนนี้
   * (in-app notification ยังคงทำงานปกติ — ปิดเฉพาะ email)
   */
  @Mutation(() => User, {
    description: 'Toggle email notification preference',
  })
  @UseGuards(SupabaseAuthGuard)
  async updateEmailPreference(
    @CurrentUser() user: AuthUser,
    @Args('enabled', { type: () => Boolean }) enabled: boolean,
  ): Promise<User> {
    return this.userService.updateEmailPreference(user.id, enabled);
  }
}
