/**
 * IdentityResolver — GraphQL Resolver สำหรับ Identity queries
 *
 * Guards ที่ใช้:
 * - SupabaseAuthGuard = ตรวจสอบ JWT token
 * - RolesGuard        = เช็คว่า user มี role ที่อนุญาต
 *
 * ลำดับ Guard สำคัญ: Auth ก่อน → Roles ทีหลัง
 */
import { Resolver, Query } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { User } from './auth/entities/user.entity';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import {
  CurrentUser,
  AuthUser,
} from '../common/decorators/current-user.decorator';

@Resolver()
export class IdentityResolver {
  // ─── Protected: ดึงข้อมูล user ที่ login อยู่ ─────────────────────────
  @Query(() => User, { name: 'me', description: 'Get current logged-in user' })
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  getMe(@CurrentUser() user: AuthUser): User {
    return {
      id: user.id,
      email: user.email,
      displayName: undefined,
      role: user.role,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  @Query(() => String, { description: 'Get KYC status of caregiver' })
  @UseGuards(SupabaseAuthGuard)
  kycStatus(): string {
    return 'PENDING';
  }
}
