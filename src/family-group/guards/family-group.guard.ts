import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { PrismaService } from '../../common/prisma.service';
import { GqlContext } from '../../common/types/gql-context.type';
import {
  GROUP_ROLE_KEY,
  GroupRoleMetadata,
} from '../decorators/group-role.decorator';
import { GROUP_ROLE, MEMBER_STATUS } from '../family-group.constants';
import { NotAMemberError, NotGroupOwnerError } from '../family-group.errors';
import {
  GROUP_MEMBERSHIP_CACHE,
  GroupMembershipContext,
  RequestWithMembership,
} from '../types/group-membership.type';

/**
 * FamilyGroupGuard (PYG-412) — ด่านตรวจสิทธิ์ "ภายในกลุ่มครอบครัว"
 *
 * ต่างจาก RolesGuard ยังไง?
 *   RolesGuard ตรวจ role ระดับ "ทั้งระบบ" (1=ผู้รับบริการ 2=ผู้ดูแล 3=แอดมิน)
 *   guard ตัวนี้ตรวจ role ระดับ "ต่อกลุ่ม" (OWNER/MEMBER) ซึ่งคนคนเดียวกัน
 *   เป็น OWNER ของกลุ่ม A และเป็น MEMBER ของกลุ่ม B พร้อมกันได้
 *   → สองเรื่องนี้ไม่มีทางรวมเป็น guard เดียวกันได้ และทั้งคู่ต้องผ่านทั้งคู่
 *
 * ประกอบร่างกับของเดิมได้เลย ไม่มีอะไรต้องแก้:
 *   @UseGuards(SupabaseAuthGuard, RolesGuard, FamilyGroupGuard)
 *   - ไม่มี @Roles()     → RolesGuard ปล่อยผ่าน
 *   - ไม่มี @GroupRole() → guard นี้ปล่อยผ่าน
 *   ⚠ ต้องอยู่ "หลัง" SupabaseAuthGuard เสมอ เพราะต้องการ req.user
 *
 * ── เรื่อง N+1 (ข้อกำหนดตรงจากการ์ด) ──────────────────────────────────────
 * ผลการเช็คถูก cache ไว้บน request (Map<groupId, GroupMembershipContext>)
 * ทำไมถึงจำเป็น: GraphQL 1 request ยิงได้หลาย operation และ resolver/field resolver
 * หลายตัวอาจอยากรู้ "ฉันเป็นอะไรในกลุ่มนี้" — ถ้าไม่ cache จะกลายเป็นคิวรี่ซ้ำ
 * ตารางเดิมหลายรอบต่อ 1 request ทั้งที่คำตอบเปลี่ยนไม่ได้ภายใน request เดียว
 * service อ่าน cache นี้ต่อผ่าน @GroupMembershipContext() แทนที่จะไปคิวรี่ซ้ำอีกรอบ
 */
@Injectable()
export class FamilyGroupGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // ── 1. resolver นี้คุมด้วย @GroupRole() ไหม? ────────────────────────────
    const meta = this.reflector.getAllAndOverride<GroupRoleMetadata>(
      GROUP_ROLE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!meta) {
      return true; // ไม่เกี่ยวกับกลุ่ม → ไม่ใช่หน้าที่ guard นี้
    }

    const gqlCtx = GqlExecutionContext.create(context);

    // ── 2. ต้องมี user จาก SupabaseAuthGuard ────────────────────────────────
    // ไม่มี = developer ลืมเรียงลำดับ guard ให้ถูก (defensive)
    const req = gqlCtx.getContext<GqlContext>().req as RequestWithMembership;
    const user = req.user;
    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    // ── 3. หา groupId จาก argument ──────────────────────────────────────────
    const groupId = this.resolveGroupId(gqlCtx.getArgs(), meta.idArg);
    if (!groupId) {
      // resolver ติด @GroupRole ไว้แต่หา groupId ไม่เจอ = บั๊กฝั่งเรา ไม่ใช่ฝั่ง client
      // ต้อง "ปฏิเสธ" ไม่ใช่ปล่อยผ่าน ไม่งั้น resolver จะทำงานโดยไม่มีใครตรวจสิทธิ์เลย
      throw new ForbiddenException(
        `FamilyGroupGuard: หา argument '${meta.idArg}' ไม่เจอ — ตรวจชื่อ @Args ให้ตรงกับ @GroupRole`,
      );
    }

    // ── 4. โหลดสมาชิกภาพ (ใช้ cache ถ้าเคยโหลดใน request นี้แล้ว) ───────────
    const membership = await this.loadMembership(req, user.id, groupId);

    // ── 5. ตัดสิน ───────────────────────────────────────────────────────────
    // ไม่มีแถว ACTIVE = ไม่ใช่สมาชิก
    // ★ ตอบ NOT_A_MEMBER เหมือนกันหมด ไม่ว่ากลุ่มจะมีจริงหรือไม่ —
    //   ถ้าแยกเป็น GROUP_NOT_FOUND คนนอกจะยิง id มั่ว ๆ แล้วเดาได้ว่ากลุ่มไหนมีอยู่
    if (!membership) {
      throw new NotAMemberError();
    }

    // 'MEMBER' = อย่างน้อยเป็นสมาชิก (OWNER ผ่านด้วย)
    // 'OWNER'  = ต้องเป็นเจ้าของเท่านั้น
    if (
      meta.role === GROUP_ROLE.OWNER &&
      membership.role !== GROUP_ROLE.OWNER
    ) {
      throw new NotGroupOwnerError();
    }

    return true;
  }

  /**
   * หา groupId จาก args ของ GraphQL
   *
   * รองรับสองแบบที่โปรเจกต์นี้ใช้จริง โดยไม่ต้องระบุอะไรเพิ่ม:
   *   mutation createX(input: {...})  → args.input.groupId
   *   query familyGroup(groupId: ID)  → args.groupId
   *
   * ⚠ guard รัน "ก่อน" ValidationPipe → args ยังเป็น plain object ดิบ ๆ ที่ client ส่งมา
   *   จึงต้องเช็ค typeof เอง ห้ามเชื่อว่าเป็น string
   */
  private resolveGroupId(
    args: Record<string, unknown>,
    idArg: string,
  ): string | null {
    const direct = args[idArg];
    if (typeof direct === 'string' && direct.length > 0) {
      return direct;
    }

    const input = args.input;
    if (input && typeof input === 'object') {
      const nested = (input as Record<string, unknown>)[idArg];
      if (typeof nested === 'string' && nested.length > 0) {
        return nested;
      }
    }

    return null;
  }

  /**
   * อ่านสมาชิกภาพจากดีบี 1 ครั้งต่อ (request, groupId) แล้วจำไว้
   *
   * หมายเหตุ: cache นี้จำเฉพาะ "เจอ" — เคส "ไม่เจอ" จะ throw ทันทีที่ชั้นบน
   * request จึงจบก่อนที่จะมีใครถามซ้ำอยู่แล้ว
   */
  private async loadMembership(
    req: RequestWithMembership,
    userId: string,
    groupId: string,
  ): Promise<GroupMembershipContext | null> {
    const cache =
      req[GROUP_MEMBERSHIP_CACHE] ?? new Map<string, GroupMembershipContext>();
    req[GROUP_MEMBERSHIP_CACHE] = cache;

    const cached = cache.get(groupId);
    if (cached) {
      return cached;
    }

    // ใช้ unique (group_id, user_id) — คนหนึ่งมีได้แถวเดียวต่อกลุ่ม
    // แล้วค่อยกรอง ACTIVE ในโค้ด เพื่อให้เป็น index lookup ตรง ๆ ไม่ใช่ scan
    const row = await this.prisma.familyGroupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
      select: {
        id: true,
        groupId: true,
        userId: true,
        role: true,
        status: true,
      },
    });

    // ★ คนที่ status = REMOVED/LEFT ตกตรงนี้ = หมดสิทธิ์ทันทีที่ถูกเตะ/ออก
    //   (AC-BS-01 A3: "removed member loses all access immediately")
    if (!row || row.status !== MEMBER_STATUS.ACTIVE) {
      return null;
    }

    const membership: GroupMembershipContext = {
      membershipId: row.id,
      groupId: row.groupId,
      userId: row.userId,
      role:
        row.role === GROUP_ROLE.OWNER ? GROUP_ROLE.OWNER : GROUP_ROLE.MEMBER,
    };
    cache.set(groupId, membership);
    return membership;
  }
}
