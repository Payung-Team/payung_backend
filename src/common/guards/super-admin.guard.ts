/**
 * SuperAdminGuard (PYG-152) — Shorthand guard สำหรับ endpoint ที่ super admin เท่านั้นเข้าได้
 *
 * ทำไมต้องมี SuperAdminGuard แยก (ทั้งที่มี RolesGuard อยู่แล้ว)?
 * - ใช้ง่ายกว่า: เขียนแค่ @UseGuards(SupabaseAuthGuard, SuperAdminGuard)
 *   แทน @UseGuards(SupabaseAuthGuard, RolesGuard) + @Roles(ROLE_ID.SUPER_ADMIN) สองบรรทัด
 * - อ่านโค้ดง่ายขึ้น: เห็น SuperAdminGuard ปุ๊บรู้ทันทีว่าเป็น endpoint super admin only
 * - ปลอดภัยกว่า: ไม่มีโอกาสลืมใส่ @Roles(ROLE_ID.SUPER_ADMIN) แล้วทำให้ admin/user ธรรมดาเข้าได้
 *
 * ความสัมพันธ์กับ AdminGuard (PYG-132):
 * - AdminGuard อนุญาตเฉพาะ role=3 (admin)
 * - SuperAdminGuard อนุญาตเฉพาะ role=4 (super_admin)
 * - หมายเหตุ: ปัจจุบัน AdminGuard ไม่ได้รวม super_admin เข้าไปด้วย (ตัดสินใจไว้ใน PYG-152 ว่า
 *   จะไม่เปลี่ยน behavior ของ AdminGuard ในตั๋วนี้ — ค่อยพิจารณาแยกเป็น ticket follow-up)
 *
 * Flow:
 *   1. ต้องรันหลัง SupabaseAuthGuard (เพราะต้องการ req.user)
 *   2. SupabaseAuthGuard ก็ได้ check isSuspended แล้ว — ถ้าโดน ban จะ throw 403 ก่อนถึงตรงนี้
 *   3. ที่นี่ check แค่ role === 4 (super_admin)
 *
 * วิธีใช้:
 *   @Resolver()
 *   @UseGuards(SupabaseAuthGuard, SuperAdminGuard)
 *   export class SuperAdminResolver { ... }
 *
 * หรือใช้ที่ method เดียว:
 *   @Mutation(() => Boolean)
 *   @UseGuards(SupabaseAuthGuard, SuperAdminGuard)
 *   async createAdmin(...) { ... }
 *
 * ⚠️ ต้องลงทะเบียน SuperAdminGuard ใน providers ของ module ที่ใช้ด้วย!
 * (ตาม convention ของทีม — เหมือน SupabaseAuthGuard, RolesGuard, AdminGuard)
 *
 * ตัวอย่าง:
 *   @Module({
 *     providers: [SupabaseAuthGuard, SuperAdminGuard, MySuperAdminResolver, ...],
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

/** Role number ของ super admin — อ้างอิงจาก User.role ใน schema.prisma (ROLE_ID.SUPER_ADMIN) */
export const SUPER_ADMIN_ROLE = 4;

@Injectable()
export class SuperAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    // ดึง user จาก GraphQL context (inject โดย SupabaseAuthGuard)
    const ctx = GqlExecutionContext.create(context);
    const user = ctx.getContext<GqlContext>().req.user;

    // Defensive check — SupabaseAuthGuard ควรจะ inject user แล้ว
    // ถ้าไม่มี = developer ลืมใส่ SupabaseAuthGuard ก่อน SuperAdminGuard
    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    // เช็ค role ตรงๆ — เฉพาะ super_admin (role=4) เท่านั้น
    // ไม่ต้อง check isSuspended อีก เพราะ SupabaseAuthGuard ทำให้แล้ว
    if (user.role !== SUPER_ADMIN_ROLE) {
      throw new ForbiddenException('Super admin access required');
    }

    return true;
  }
}
