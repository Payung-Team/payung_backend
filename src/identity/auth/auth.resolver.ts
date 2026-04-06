/**
 * AuthResolver — GraphQL Resolver สำหรับ Authentication
 *
 * Resolver คืออะไร?
 * - คือ "ตัวรับ request" จาก GraphQL
 * - เหมือน Controller ใน REST API แต่สำหรับ GraphQL
 * - @Mutation = รับ request ที่เปลี่ยนแปลงข้อมูล (login, register, updateProfile)
 * - @Query   = รับ request ที่แค่อ่านข้อมูล (me)
 *
 * Resolver ไม่ควรมี business logic ซับซ้อน — มันแค่รับ request แล้วส่งต่อให้ Service ทำงาน
 */
import { Resolver, Mutation, Query, Args } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
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

@Resolver()
export class AuthResolver {
  // NestJS จะ inject services เข้ามาอัตโนมัติ (Dependency Injection)
  // - AuthService = จัดการ login/register (Supabase Auth)
  // - UserService = จัดการ CRUD ของ users table (findById, updateProfile)
  constructor(
    private authService: AuthService,
    private userService: UserService,
  ) {}

  /**
   * Login mutation — ใช้ใน GraphQL Playground แบบนี้:
   *
   * mutation {
   *   login(input: { email: "user@example.com", password: "123456" }) {
   *     accessToken
   *     refreshToken
   *     user { id email displayName role }
   *   }
   * }
   *
   * @Args('input') = ดึงค่า "input" จาก GraphQL arguments
   */
  @Mutation(() => AuthPayload, { description: 'Login user with email and password' })
  async login(
    @Args('input') input: LoginInput,
  ): Promise<AuthPayload> {
    return this.authService.login(input);
  }

  @Mutation(() => AuthPayload)
  async register(@Args('input') input: RegisterInput): Promise<AuthPayload> {
    return this.authService.register(input);
  }

  // ─── Profile endpoints (ต้อง login ก่อน) ──────────────────────────────

  /**
   * me query — ดึงข้อมูล user ที่ login อยู่
   *
   * query {
   *   me {
   *     id email displayName avatarUrl role isActive createdAt updatedAt
   *   }
   * }
   *
   * ต้อง login ก่อน (ส่ง Bearer token ใน header) — SupabaseAuthGuard ตรวจ JWT
   * @CurrentUser() = ดึง user จาก token ที่ Guard decode + inject แล้ว
   */
  @Query(() => User, { name: 'me', description: 'Get current logged-in user' })
  @UseGuards(SupabaseAuthGuard)
  async me(@CurrentUser() user: AuthUser): Promise<User> {
    // ใช้ findById เพราะ Guard ให้ internal user id มาแล้ว
    return this.userService.findById(user.id);
  }

  /**
   * updateProfile mutation — อัปเดตโปรไฟล์ user (displayName และ/หรือ avatarUrl)
   *
   * mutation {
   *   updateProfile(input: { displayName: "สมชาย" }) {
   *     id displayName avatarUrl updatedAt
   *   }
   * }
   *
   * ต้อง login ก่อน (ส่ง Bearer token ใน header)
   * input เป็น partial update — ส่งเฉพาะ field ที่ต้องการเปลี่ยน
   */
  @Mutation(() => User, { description: 'Update current user profile' })
  @UseGuards(SupabaseAuthGuard)
  async updateProfile(
    @CurrentUser() user: AuthUser,
    @Args('input') input: UpdateProfileInput,
  ): Promise<User> {
    // ส่ง input ตรงๆ ได้เลย เพราะ shape ตรงกับ UserService.updateProfile()
    return this.userService.updateProfile(user.id, input);
  }
}
