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
import { Resolver, Mutation, Query, Args, Context } from '@nestjs/graphql';
import { AuthPayload } from '../models/auth-payload.model';
import { LoginInput } from './dto/login.input';
import { RegisterInput } from './dto/register.input';
import { UpdateProfileInput } from './dto/update-profile.input';
import { AuthService } from './auth.service';
import { UserService } from './user.service';
import { User } from './entities/user.entity';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
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

  // ─── Profile endpoints (ต้อง login ก่อน) ──────────────────────────────

  @Query(() => User, { name: 'me', description: 'Get current logged-in user' })
  @UseGuards(SupabaseAuthGuard)
  async me(@CurrentUser() user: AuthUser): Promise<User> {
    return this.userService.findById(user.id);
  }

  @Mutation(() => User, { description: 'Update current user profile' })
  @UseGuards(SupabaseAuthGuard)
  async updateProfile(
    @CurrentUser() user: AuthUser,
    @Args('input') input: UpdateProfileInput,
  ): Promise<User> {
    return this.userService.updateProfile(user.id, input);
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
