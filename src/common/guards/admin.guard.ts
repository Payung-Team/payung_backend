/**
 * AdminGuard (PYG-132) — Shorthand guard สำหรับ endpoint ที่ admin เท่านั้นเข้าได้
 *
 * ทำไมต้องมี AdminGuard แยก (ทั้งที่มี RolesGuard อยู่แล้ว)?
 * - ใช้ง่ายกว่า: เขียนแค่ @UseGuards(SupabaseAuthGuard, AdminGuard)
 *   แทน @UseGuards(SupabaseAuthGuard, RolesGuard) + @Roles(3) สองบรรทัด
 * - อ่านโค้ดง่ายขึ้น: เห็น AdminGuard ปุ๊บรู้ทันทีว่าเป็น endpoint admin
 * - ปลอดภัยกว่า: ไม่มีโอกาสลืมใส่ @Roles(3) แล้วทำให้ user ธรรมดาเข้าได้
 *
 * Flow:
 *   1. ต้องรันหลัง SupabaseAuthGuard (เพราะต้องการ req.user)
 *   2. SupabaseAuthGuard ก็ได้ check isSuspended แล้ว — ถ้าโดน ban จะ throw 403 ก่อนถึงตรงนี้
 *   3. ที่นี่ check แค่ role === 3 (admin)
 *
 * วิธีใช้:
 *   @Resolver()
 *   @UseGuards(SupabaseAuthGuard, AdminGuard)
 *   export class AdminResolver { ... }
 *
 * หรือใช้ที่ method เดียว:
 *   @Mutation(() => Boolean)
 *   @UseGuards(SupabaseAuthGuard, AdminGuard)
 *   async suspendUser(...) { ... }
 *
 * ⚠️ ต้องลงทะเบียน AdminGuard ใน providers ของ module ที่ใช้ด้วย!
 * (ตาม convention ของทีม — เหมือน SupabaseAuthGuard, RolesGuard ที่ provide ใน
 *  AuthModule, KycModule, IdentityModule)
 *
 * ตัวอย่าง:
 *   @Module({
 *     providers: [SupabaseAuthGuard, AdminGuard, MyAdminResolver, ...],
 *   })
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { GqlContext } from '../types/gql-context.type';

/** Role number ของ admin — อ้างอิงจาก User.role ใน schema.prisma */
export const ADMIN_ROLE = 3;

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    // ดึง user จาก GraphQL context (inject โดย SupabaseAuthGuard)
    const ctx = GqlExecutionContext.create(context);
    const user = ctx.getContext<GqlContext>().req.user;

    // Defensive check — SupabaseAuthGuard ควรจะ inject user แล้ว
    // ถ้าไม่มี = developer ลืมใส่ SupabaseAuthGuard ก่อน AdminGuard
    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    // เช็ค role ตรงๆ — แค่ admin (role=3) เท่านั้น
    // ไม่ต้อง check isSuspended อีก เพราะ SupabaseAuthGuard ทำให้แล้ว
    if (user.role !== ADMIN_ROLE) {
      throw new ForbiddenException('Admin access required');
    }

    return true;
  }
}
