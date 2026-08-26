import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import {
  GROUP_MEMBERSHIP_CACHE,
  GroupMembershipContext,
  RequestWithMembership,
} from '../types/group-membership.type';
import { GROUP_ROLE_KEY, GroupRoleMetadata } from './group-role.decorator';

/**
 * @GroupMembership() — หยิบผลการเช็คสมาชิกภาพที่ FamilyGroupGuard โหลดไว้แล้ว
 *
 * จุดประสงค์เดียว: ไม่ให้ service ไปคิวรี่ family_group_members ซ้ำอีกรอบ
 * ทั้งที่ guard เพิ่งอ่านมาหมาด ๆ ใน request เดียวกัน (ข้อกำหนด "avoids N+1" ของการ์ด)
 *
 * @example
 * async renameFamilyGroup(
 *   @Args('input') input: RenameFamilyGroupInput,
 *   @GroupMembership() membership: GroupMembershipContext,   // ← รู้เลยว่าเป็น OWNER
 * ) { ... }
 *
 * ⚠ ใช้ได้เฉพาะ resolver ที่ติด @GroupRole() + FamilyGroupGuard เท่านั้น
 *   ถ้าไม่ติด จะได้ค่า undefined (guard ไม่เคยรัน = ไม่มีอะไรใน cache)
 *   จึงประกาศ return type เป็น GroupMembershipContext (ไม่ใช่ | undefined) — สัญญาว่า
 *   "ถ้าใช้ถูกวิธี ค่านี้มีเสมอ" เพราะ guard จะ throw ทิ้งไปก่อนถ้าไม่ใช่สมาชิก
 */
export const GroupMembership = createParamDecorator(
  (
    _data: unknown,
    ctx: ExecutionContext,
  ): GroupMembershipContext | undefined => {
    const gqlCtx = GqlExecutionContext.create(ctx);
    const req = gqlCtx.getContext<{ req: RequestWithMembership }>().req;
    const cache = req[GROUP_MEMBERSHIP_CACHE];
    if (!cache) {
      return undefined;
    }

    // อ่าน metadata ตัวเดียวกับที่ guard ใช้ เพื่อหา groupId ของ resolver นี้
    // (ไม่เดาจากขนาด Map เพราะ 1 request อาจมีหลายกลุ่มปนกันได้)
    const meta = Reflect.getMetadata(GROUP_ROLE_KEY, ctx.getHandler()) as
      | GroupRoleMetadata
      | undefined;
    const idArg = meta?.idArg ?? 'groupId';

    const args = gqlCtx.getArgs<Record<string, unknown>>();
    const direct = args[idArg];
    if (typeof direct === 'string') {
      return cache.get(direct);
    }
    const input = args.input as Record<string, unknown> | undefined;
    const nested = input?.[idArg];
    if (typeof nested === 'string') {
      return cache.get(nested);
    }
    return undefined;
  },
);
