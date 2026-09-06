import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { FamilyGroupService } from './family-group.service';
import { CreateFamilyGroupInput } from './dto/create-family-group.input';
import { RenameFamilyGroupInput } from './dto/rename-family-group.input';
import { RemoveMemberInput } from './dto/remove-member.input';
import { TransferOwnershipInput } from './dto/transfer-ownership.input';
import { CreateJoinLinkInput } from './dto/create-join-link.input';
import {
  DeleteFamilyGroupResult,
  FamilyGroup,
  LeaveFamilyGroupResult,
} from './entities/family-group.entity';
import {
  FamilyGroupJoinLink,
  JoinLinkPreview,
} from './entities/family-group-join-link.entity';
import { GroupRole } from './decorators/group-role.decorator';
import { FamilyGroupGuard } from './guards/family-group.guard';
import { GROUP_ROLE } from './family-group.constants';
import {
  AuthUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';

/**
 * FamilyGroupResolver (PYG-412) — GraphQL ของ "สร้าง/จัดการกลุ่มครอบครัว"
 *
 * ── ลำดับ guard (ห้ามสลับ) ────────────────────────────────────────────────
 *   SupabaseAuthGuard → RolesGuard → FamilyGroupGuard
 *   1. SupabaseAuthGuard  ตรวจ JWT + เช็คบัญชีถูกระงับ แล้ว inject req.user
 *   2. RolesGuard         ตรวจ role ระดับระบบ — ไฟล์นี้ไม่ได้ใช้ @Roles() เลย
 *                         (AC-BS-01 A1: "any authenticated user can create a group"
 *                          ทั้งผู้รับบริการและผู้ดูแลต่างก็มีครอบครัวของตัวเอง)
 *                         ที่ยังใส่ไว้ในโซ่เพราะมันปล่อยผ่านเมื่อไม่มี @Roles()
 *                         → วันที่ต้องจำกัด role จริง ๆ แค่เติม @Roles() ที่เมธอด จบ
 *   3. FamilyGroupGuard   ตรวจสิทธิ์ "ในกลุ่มนั้น ๆ" ตาม @GroupRole()
 *
 * ── ทำไม userId มาจาก @CurrentUser() ไม่ใช่จาก input ──────────────────────
 *   ค่าใน input มาจาก client ปลอมได้ ส่วน @CurrentUser() มาจาก JWT ที่ Supabase
 *   เซ็นแล้ว ปลอมไม่ได้ → ทุก mutation ในไฟล์นี้จึงส่ง user.id เข้า service เสมอ
 */
@Resolver(() => FamilyGroup)
@UseGuards(SupabaseAuthGuard, RolesGuard, FamilyGroupGuard)
export class FamilyGroupResolver {
  constructor(private readonly familyGroupService: FamilyGroupService) {}

  // ═══════════════════════════════════════════════════════════════════════
  //  Queries
  // ═══════════════════════════════════════════════════════════════════════

  @Query(() => [FamilyGroup], {
    description:
      'กลุ่มครอบครัวทั้งหมดที่ฉันเป็นสมาชิกอยู่ (ใหม่สุดก่อน) พร้อมรายชื่อสมาชิกและบทบาทของฉันในแต่ละกลุ่ม. ไม่มีกลุ่ม = คืน array ว่าง ไม่ใช่ error.',
  })
  // ไม่ติด @GroupRole เพราะยังไม่รู้ว่ากลุ่มไหน — ตัวคิวรี่เองกรองเฉพาะกลุ่มที่เราเป็นสมาชิก ACTIVE
  async myFamilyGroups(@CurrentUser() user: AuthUser): Promise<FamilyGroup[]> {
    return this.familyGroupService.myFamilyGroups(user.id);
  }

  @Query(() => FamilyGroup, {
    description:
      'รายละเอียดกลุ่มเดียว — เฉพาะสมาชิกที่ยัง ACTIVE เท่านั้น. คนนอกกลุ่มจะได้ NOT_A_MEMBER เสมอ ไม่ว่ากลุ่มนั้นจะมีอยู่จริงหรือไม่ (กันเดา id).',
  })
  @GroupRole(GROUP_ROLE.MEMBER)
  async familyGroup(
    @Args('groupId', { type: () => ID }) groupId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<FamilyGroup> {
    return this.familyGroupService.familyGroup(user.id, groupId);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Mutations
  // ═══════════════════════════════════════════════════════════════════════

  @Mutation(() => FamilyGroup, {
    description:
      'สร้างกลุ่มครอบครัวใหม่ — ผู้สร้างกลายเป็นเจ้าของ (OWNER) ทันที. ผู้ใช้ที่ล็อกอินแล้วทุกคนสร้างได้ และสร้างได้หลายกลุ่ม.',
  })
  // ไม่ติด @GroupRole — ยังไม่มีกลุ่มให้ตรวจสิทธิ์
  async createFamilyGroup(
    @Args('input') input: CreateFamilyGroupInput,
    @CurrentUser() user: AuthUser,
  ): Promise<FamilyGroup> {
    return this.familyGroupService.createFamilyGroup(user.id, input);
  }

  @Mutation(() => FamilyGroup, {
    description:
      'เปลี่ยนชื่อกลุ่ม (เจ้าของเท่านั้น). ชื่อว่างหรือเกิน 80 ตัวอักษร → GROUP_NAME_INVALID.',
  })
  @GroupRole(GROUP_ROLE.OWNER) // guard อ่าน groupId จาก input.groupId ให้เอง
  async renameFamilyGroup(
    @Args('input') input: RenameFamilyGroupInput,
    @CurrentUser() user: AuthUser,
  ): Promise<FamilyGroup> {
    return this.familyGroupService.renameFamilyGroup(user.id, input);
  }

  @Mutation(() => DeleteFamilyGroupResult, {
    description:
      'ลบกลุ่ม (เจ้าของเท่านั้น). สมาชิก/คำเชิญ/ฟีดกิจกรรม ถูกลบตาม. ★ โปรไฟล์ผู้รับบริการและประวัติการจอง "ไม่ถูกลบ" — แค่ถูกตัดความเชื่อมโยงกับกลุ่ม (family_group_id = null).',
  })
  @GroupRole(GROUP_ROLE.OWNER)
  async deleteFamilyGroup(
    @Args('groupId', { type: () => ID }) groupId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<DeleteFamilyGroupResult> {
    return this.familyGroupService.deleteFamilyGroup(user.id, groupId);
  }

  @Mutation(() => LeaveFamilyGroupResult, {
    description:
      'ออกจากกลุ่มด้วยตัวเอง — คืน id + ชื่อกลุ่มที่เพิ่งออกมา เพราะหลังออกแล้วจะอ่านกลุ่มนั้นไม่ได้อีก. ★ เจ้าของออกเองไม่ได้ → LAST_OWNER ต้องโอนสิทธิ์ให้คนอื่นหรือลบกลุ่มก่อน.',
  })
  @GroupRole(GROUP_ROLE.MEMBER) // เจ้าของก็ผ่าน guard แต่จะไปตกที่ LAST_OWNER ใน service
  async leaveFamilyGroup(
    @Args('groupId', { type: () => ID }) groupId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<LeaveFamilyGroupResult> {
    return this.familyGroupService.leaveFamilyGroup(user.id, groupId);
  }

  @Mutation(() => FamilyGroup, {
    description:
      'นำสมาชิกออกจากกลุ่ม (เจ้าของเท่านั้น) — สิทธิ์ทั้งหมดของคนนั้นหายทันที. นำตัวเองออกไม่ได้ → LAST_OWNER.',
  })
  @GroupRole(GROUP_ROLE.OWNER)
  async removeMember(
    @Args('input') input: RemoveMemberInput,
    @CurrentUser() user: AuthUser,
  ): Promise<FamilyGroup> {
    return this.familyGroupService.removeMember(user.id, input);
  }

  @Mutation(() => FamilyGroup, {
    description:
      'โอนสิทธิ์เจ้าของให้สมาชิกคนอื่นในกลุ่ม (เจ้าของเท่านั้น) — ผู้เรียกจะกลายเป็นสมาชิกธรรมดาทันที. เป้าหมายต้องเป็นสมาชิก ACTIVE อยู่แล้ว มิฉะนั้น MEMBER_NOT_FOUND.',
  })
  @GroupRole(GROUP_ROLE.OWNER)
  async transferOwnership(
    @Args('input') input: TransferOwnershipInput,
    @CurrentUser() user: AuthUser,
  ): Promise<FamilyGroup> {
    return this.familyGroupService.transferOwnership(user.id, input);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  PYG-416 · SCR-FG2-001 — ลิงก์เข้าร่วมกลุ่ม
  //
  //  ★ ทุกตัวที่คืน FamilyGroupJoinLink ต้องมี @GroupRole('OWNER') เสมอ
  //    เพราะ type นั้นมี url เต็มอยู่ข้างใน = ใครได้ไปก็เข้ากลุ่มได้
  //    (service ตรวจ assertOwner ซ้ำอีกชั้นอยู่แล้ว แต่ guard ทำให้พลาดยากขึ้นหนึ่งชั้น)
  // ═══════════════════════════════════════════════════════════════════════

  @Query(() => FamilyGroupJoinLink, {
    description:
      'ลิงก์เข้าร่วมที่ยังใช้ได้ของกลุ่ม (เจ้าของเท่านั้น) — ใช้ตอนกดปุ่มคัดลอกลิงก์ซ้ำ ' +
      'โยน JOIN_LINK_NOT_FOUND ถ้ากลุ่มยังไม่เคยสร้างลิงก์ หรือลิงก์ถูกยกเลิกไปแล้ว',
  })
  @GroupRole(GROUP_ROLE.OWNER)
  async groupJoinLink(
    @Args('groupId', { type: () => ID }) groupId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<FamilyGroupJoinLink> {
    return this.familyGroupService.groupJoinLink(user.id, groupId);
  }

  @Query(() => JoinLinkPreview, {
    description:
      'ข้อมูลกลุ่มที่คนถือลิงก์เห็นก่อนกดยืนยันเข้าร่วม — ผู้ใช้ที่ล็อกอินแล้วเรียกได้ทุกคน ' +
      'ลิงก์หมดอายุ/ถูกยกเลิก/เต็ม จะคืน isUsable = false พร้อม unusableReason ไม่ใช่ error ' +
      'โยน JOIN_LINK_INVALID เฉพาะ token ที่ไม่ตรงกับลิงก์ใดเลย',
  })
  async joinLinkPreview(
    @Args('token') token: string,
    @CurrentUser() user: AuthUser,
  ): Promise<JoinLinkPreview> {
    return this.familyGroupService.joinLinkPreview(user.id, token);
  }

  @Mutation(() => FamilyGroupJoinLink, {
    description:
      'สร้างลิงก์เข้าร่วมของกลุ่ม (เจ้าของเท่านั้น) — ถ้ามีลิงก์ที่ใช้ได้อยู่แล้วจะคืนใบเดิม ' +
      'ไม่สร้างทับ เพื่อไม่ให้การกดปุ่มซ้ำฆ่าลิงก์ที่ส่งออกไปแล้ว',
  })
  @GroupRole(GROUP_ROLE.OWNER)
  async createJoinLink(
    @Args('input') input: CreateJoinLinkInput,
    @CurrentUser() user: AuthUser,
  ): Promise<FamilyGroupJoinLink> {
    return this.familyGroupService.createJoinLink(user.id, input);
  }

  @Mutation(() => FamilyGroupJoinLink, {
    description:
      'ออกลิงก์ใหม่แทนใบเดิม (เจ้าของเท่านั้น) — ลิงก์เดิมใช้ไม่ได้ทันที ' +
      'ใช้ตอนลิงก์หลุดไปในที่ที่ไม่ตั้งใจ',
  })
  @GroupRole(GROUP_ROLE.OWNER)
  async rotateJoinLink(
    @Args('input') input: CreateJoinLinkInput,
    @CurrentUser() user: AuthUser,
  ): Promise<FamilyGroupJoinLink> {
    return this.familyGroupService.rotateJoinLink(user.id, input);
  }

  @Mutation(() => Boolean, {
    description:
      'ยกเลิกลิงก์เข้าร่วมโดยไม่ออกใบใหม่ (เจ้าของเท่านั้น) — หลังจากนี้กลุ่มจะไม่มีลิงก์ ' +
      'จนกว่าจะกดสร้างใหม่ โยน JOIN_LINK_NOT_FOUND ถ้าไม่มีลิงก์ให้ยกเลิก',
  })
  @GroupRole(GROUP_ROLE.OWNER)
  async revokeJoinLink(
    @Args('groupId', { type: () => ID }) groupId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<boolean> {
    return this.familyGroupService.revokeJoinLink(user.id, groupId);
  }
}
