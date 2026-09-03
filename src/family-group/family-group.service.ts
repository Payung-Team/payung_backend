import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../common/prisma.service';
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
import { FamilyGroupMemberItem } from './entities/family-group-member.entity';
import { GroupCareRecipient } from './entities/care-recipient.entity';
import {
  FamilyGroupJoinLink,
  JoinLinkPreview,
} from './entities/family-group-join-link.entity';
import {
  ACTIVITY_ACTION,
  ACTIVITY_TARGET,
  ActivityAction,
  ActivityTarget,
  GROUP_NAME_MAX_LENGTH,
  GROUP_NAME_MIN_LENGTH,
  GROUP_ROLE,
  MEMBER_STATUS,
  joinLinkBaseUrl,
  GROUP_MAX_MEMBERS,
  JOIN_LINK_MAX_USES,
  JOIN_LINK_PATH,
  JOIN_LINK_STATUS,
  JOIN_LINK_TOKEN_BYTES,
  JOIN_LINK_TTL_HOURS,
} from './family-group.constants';
import {
  AlreadyOwnerError,
  GroupNameInvalidError,
  GroupNotFoundError,
  LastOwnerError,
  MemberNotFoundError,
  NotGroupOwnerError,
  GroupMemberLimitReachedError,
  JoinLinkConfigMissingError,
  JoinLinkExhaustedError,
  JoinLinkExpiredError,
  JoinLinkInvalidError,
  JoinLinkNotFoundError,
  JoinLinkRevokedError,
} from './family-group.errors';

/**
 * field set มาตรฐานของ "สมาชิก 1 คน" — ใช้ที่เดียวทุกที่ กันลืม join users
 * (ไม่มี displayName/email จะประกอบ FamilyGroupMemberItem ไม่ได้)
 */
const MEMBER_SELECT = {
  id: true,
  userId: true,
  role: true,
  joinedAt: true,
  user: { select: { displayName: true, email: true, avatarUrl: true } },
} as const;

/** field set มาตรฐานของ "กลุ่ม 1 กลุ่ม พร้อมสมาชิก ACTIVE" */
const GROUP_SELECT = {
  id: true,
  name: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  members: {
    where: { status: MEMBER_STATUS.ACTIVE },
    select: MEMBER_SELECT,
    orderBy: { joinedAt: 'asc' },
  },
} as const;

/** รูปทรงแถวที่ GROUP_SELECT คืนกลับ (ให้ mapper อ้างชนิดได้โดยไม่ต้องใช้ any) */
type GroupRow = Prisma.FamilyGroupGetPayload<{ select: typeof GROUP_SELECT }>;

/** รูปทรงแถวที่ MEMBER_SELECT คืนกลับ */
type MemberRow = Prisma.FamilyGroupMemberGetPayload<{
  select: typeof MEMBER_SELECT;
}>;

/**
 * FamilyGroupService (PYG-412) — ตรรกะทั้งหมดของ "สร้าง/จัดการกลุ่มครอบครัว"
 *
 * ═══ กติกา 3 ข้อที่ห้ามแหก ไม่ว่าจะเพิ่มเมธอดอะไรในไฟล์นี้ต่อ ═══
 *
 * 1) ทุกการเช็คสิทธิ์ต้องกรอง status = 'ACTIVE' เสมอ
 *    คนที่ LEFT/REMOVED ยังมีแถวอยู่ในตาราง (เก็บไว้ให้ฟีดกิจกรรมอ้างย้อนหลังได้)
 *    ถ้าลืมกรอง คนที่โดนเตะไปแล้วจะยังสั่งงานกลุ่มได้ = ช่องโหว่ตรง ๆ
 *
 * 2) ทุก mutation ที่เปลี่ยนสถานะ ต้องเขียน family_group_activity ใน transaction เดียวกัน
 *    (AC-BS-01 A5) — ไม่ใช่ "เขียนทีหลัง" เพราะถ้า transaction rollback
 *    ฟีดจะโกหกว่าเกิดเหตุการณ์ที่ไม่เคยเกิดขึ้น
 *
 * 3) การเปลี่ยนบทบาท/สถานะสมาชิก ต้องใช้ updateMany + ใส่เงื่อนไขเดิมไว้ใน where
 *    ไม่ใช่ update() เฉย ๆ — เหตุผลเต็มอยู่ที่ transferOwnership ด้านล่าง (เรื่อง race)
 *
 * ── สิ่งที่ "ไม่ได้" อยู่ในการ์ดนี้ ────────────────────────────────────────
 *   เชิญสมาชิก/ยกเลิกคำเชิญ = PYG-416 · รับคำเชิญ = PYG-417
 *   ฟีดกิจกรรมแบบแบ่งหน้า   = PYG-421 · จองแทน/ผู้รับบริการ = PYG-424
 *   ไฟล์นี้แค่ "เขียน" activity ลงตาราง แต่ยังไม่มี query ให้อ่าน
 */
@Injectable()
export class FamilyGroupService {
  private readonly logger = new Logger(FamilyGroupService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ═══════════════════════════════════════════════════════════════════════
  //  Mutations
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * A1 — สร้างกลุ่มใหม่ ผู้สร้างกลายเป็น OWNER ที่ ACTIVE ทันที
   *
   * ทั้ง 3 อย่าง (กลุ่ม + แถวสมาชิก + กิจกรรม) อยู่ใน transaction เดียว
   * ถ้าแยกกันแล้วพังกลางทาง จะเหลือ "กลุ่มที่ไม่มีเจ้าของ" ซึ่งกู้ไม่ได้เลย
   * เพราะไม่มีใครมีสิทธิ์ลบหรือโอนมันได้อีกต่อไป
   */
  async createFamilyGroup(
    userId: string,
    input: CreateFamilyGroupInput,
  ): Promise<FamilyGroup> {
    const name = this.assertValidName(input.name);

    const group = await this.prisma.$transaction(async (tx) => {
      const created = await tx.familyGroup.create({
        data: {
          name,
          createdBy: userId,
          // สร้างแถวสมาชิกไปพร้อมกันในคำสั่งเดียว — nested write ของ Prisma
          // อยู่ใน transaction เดียวกันโดยอัตโนมัติ
          members: {
            create: {
              userId,
              role: GROUP_ROLE.OWNER,
              status: MEMBER_STATUS.ACTIVE,
              // invitedBy = null → "สร้างเอง ไม่มีใครเชิญ"
            },
          },
        },
        select: GROUP_SELECT,
      });

      await this.writeActivity(tx, {
        groupId: created.id,
        actorId: userId,
        action: ACTIVITY_ACTION.GROUP_CREATED,
        targetType: ACTIVITY_TARGET.GROUP,
        targetId: created.id,
        metadata: { name },
      });

      return created;
    });

    return this.toFamilyGroup(group, userId);
  }

  /**
   * A2 (ครึ่งแรก) — เจ้าของเปลี่ยนชื่อกลุ่ม
   *
   * สิทธิ์ถูกตรวจโดย FamilyGroupGuard (@GroupRole('OWNER')) มาแล้วชั้นหนึ่ง
   * ที่นี่ตรวจซ้ำอีกชั้นตามคำสั่งการ์ด ("owner-only mutations double-checked server-side")
   */
  async renameFamilyGroup(
    userId: string,
    input: RenameFamilyGroupInput,
  ): Promise<FamilyGroup> {
    const newName = this.assertValidName(input.name);

    const group = await this.prisma.$transaction(async (tx) => {
      // อ่านชื่อเดิมไว้ใส่ metadata ของฟีด ("เปลี่ยนจาก ก เป็น ข")
      const before = await tx.familyGroup.findUnique({
        where: { id: input.groupId },
        select: { id: true, name: true },
      });
      if (!before) {
        throw new GroupNotFoundError();
      }

      // ── ตรวจซ้ำชั้นที่สอง: ผู้เรียกยังเป็น OWNER ที่ ACTIVE อยู่จริงไหม ──
      await this.assertOwner(tx, input.groupId, userId);

      const updated = await tx.familyGroup.update({
        where: { id: input.groupId },
        data: { name: newName, updatedAt: new Date() },
        select: GROUP_SELECT,
      });

      await this.writeActivity(tx, {
        groupId: input.groupId,
        actorId: userId,
        action: ACTIVITY_ACTION.GROUP_RENAMED,
        targetType: ACTIVITY_TARGET.GROUP,
        targetId: input.groupId,
        metadata: { oldName: before.name, newName },
      });

      return updated;
    });

    return this.toFamilyGroup(group, userId);
  }

  /**
   * A2 (ครึ่งหลัง) — เจ้าของลบกลุ่ม
   *
   * ★ ไม่มีการเขียน activity ตรงนี้ และไม่ใช่ความหลงลืม:
   *   family_group_activity มี FK ON DELETE CASCADE ไปที่ family_groups
   *   → แถวที่เขียนตอนลบ จะถูกลบตามในคำสั่งเดียวกันนั้นเอง เขียนไปก็ไม่เหลือ
   *   (และ 'GROUP_DELETED' ก็ไม่ได้อยู่ใน CHECK constraint ด้วยซ้ำ)
   *   ถ้าวันหนึ่งต้องเก็บประวัติการลบจริง ๆ ต้องทำเป็นตาราง audit แยกที่ไม่ cascade
   *
   * สิ่งที่ดีบีจัดการให้เองตอนลบ (กำหนดไว้ในไฟล์ migration ของ PYG-411):
   *   members / invites / activity   → ลบตาม (CASCADE)
   *   care_recipients.family_group_id → NULL (โปรไฟล์ผู้รับบริการไม่หายไปด้วย)
   *   bookings.family_group_id        → NULL (ประวัติการจองต้องอยู่ต่อ ตาม edge case ของ AC)
   */
  async deleteFamilyGroup(
    userId: string,
    groupId: string,
  ): Promise<DeleteFamilyGroupResult> {
    await this.prisma.$transaction(async (tx) => {
      await this.assertOwner(tx, groupId, userId);
      await tx.familyGroup.delete({ where: { id: groupId } });
    });

    return { id: groupId, deleted: true };
  }

  /**
   * A4 — สมาชิกออกจากกลุ่มเอง
   *
   * เจ้าของออกไม่ได้ (LAST_OWNER) เพราะ invariant บอกว่ากลุ่มต้องมี OWNER ที่ ACTIVE
   * 1 คนเสมอ และ OWNER มีได้คนเดียว → เจ้าของคือ "คนสุดท้าย" เสมอโดยนิยาม
   * ทางออกมีสองทาง: transferOwnership ก่อน หรือ deleteFamilyGroup
   *
   * @returns id + ชื่อกลุ่มที่เพิ่งออกมา — FE เอาไปโชว์ข้อความยืนยันและล้าง cache
   *          ได้โดยไม่ต้องยิงถามซ้ำ (ตอนนั้นไม่มีสิทธิ์อ่านกลุ่มแล้วด้วย)
   */
  async leaveFamilyGroup(
    userId: string,
    groupId: string,
  ): Promise<LeaveFamilyGroupResult> {
    return this.prisma.$transaction(async (tx) => {
      const group = await tx.familyGroup.findUnique({
        where: { id: groupId },
        select: { id: true, name: true },
      });
      if (!group) {
        throw new GroupNotFoundError();
      }

      // ★ ใส่ role: 'MEMBER' ไว้ใน where ด้วย ไม่ใช่เช็คก่อนแล้วค่อย update
      //   ถ้าเช็คก่อนแล้วค่อย update จะมีช่องว่างระหว่างสองคำสั่ง ที่ transaction อื่น
      //   (เช่น transferOwnership) แทรกกลางแล้วเลื่อนเราขึ้นเป็น OWNER พอดี
      //   → จะได้กลุ่มที่ไม่มีเจ้าของ ซึ่งไม่มี constraint ไหนในดีบีดักไว้เลย
      const { count } = await tx.familyGroupMember.updateMany({
        where: {
          groupId,
          userId,
          status: MEMBER_STATUS.ACTIVE,
          role: GROUP_ROLE.MEMBER,
        },
        data: {
          status: MEMBER_STATUS.LEFT,
          removedAt: new Date(),
          updatedAt: new Date(),
        },
      });

      if (count === 0) {
        // ไม่ได้อัปเดตอะไรเลย → หาสาเหตุที่แท้จริงเพื่อคืน error ที่ถูกตัว
        await this.explainMemberUpdateFailure(tx, groupId, userId);
      }

      await this.writeActivity(tx, {
        groupId,
        actorId: userId,
        action: ACTIVITY_ACTION.MEMBER_LEFT,
        targetType: ACTIVITY_TARGET.MEMBER,
        targetId: userId,
        metadata: {},
      });

      return { groupId, groupName: group.name, left: true };
    });
  }

  /**
   * A3 — เจ้าของนำสมาชิกออกจากกลุ่ม
   *
   * "removed member loses all access immediately" ทำได้เพราะทุกด่าน
   * (FamilyGroupGuard, RLS policy is_group_member, ทุกคิวรี่ในไฟล์นี้)
   * กรอง status='ACTIVE' → แถวเปลี่ยนเป็น REMOVED เมื่อไหร่ สิทธิ์หายทันที
   * ไม่ต้องรอ token หมดอายุหรือ cache หมดอายุ
   *
   * นำตัวเองออก = LAST_OWNER (ตาม edge case ของ AC) เพราะผู้เรียกเป็น OWNER เสมอ
   * (ถ้าไม่ใช่ OWNER guard จะปัดตกไปตั้งแต่ก่อนเข้าเมธอดนี้)
   */
  async removeMember(
    userId: string,
    input: RemoveMemberInput,
  ): Promise<FamilyGroup> {
    const { groupId, userId: targetUserId } = input;

    const group = await this.prisma.$transaction(async (tx) => {
      await this.assertOwner(tx, groupId, userId);

      // เตะตัวเอง = เตะเจ้าของ = LAST_OWNER
      // ดักไว้ก่อนเพื่อให้ได้ error ที่ตรงความจริง แทนที่จะเป็น MEMBER_NOT_FOUND
      // (ซึ่งจะเกิดขึ้นเองจาก where role='MEMBER' ด้านล่าง และอ่านแล้วงง)
      if (targetUserId === userId) {
        throw new LastOwnerError();
      }

      // role: 'MEMBER' ใน where = เตะ OWNER ไม่ได้ทุกกรณี
      // (เหตุผลเรื่อง race อธิบายไว้ที่ leaveFamilyGroup)
      const { count } = await tx.familyGroupMember.updateMany({
        where: {
          groupId,
          userId: targetUserId,
          status: MEMBER_STATUS.ACTIVE,
          role: GROUP_ROLE.MEMBER,
        },
        data: {
          status: MEMBER_STATUS.REMOVED,
          removedAt: new Date(),
          updatedAt: new Date(),
        },
      });

      if (count === 0) {
        await this.explainMemberUpdateFailure(tx, groupId, targetUserId);
      }

      await this.writeActivity(tx, {
        groupId,
        actorId: userId,
        action: ACTIVITY_ACTION.MEMBER_REMOVED,
        targetType: ACTIVITY_TARGET.MEMBER,
        targetId: targetUserId,
        metadata: {},
      });

      return tx.familyGroup.findUniqueOrThrow({
        where: { id: groupId },
        select: GROUP_SELECT,
      });
    });

    return this.toFamilyGroup(group, userId);
  }

  /**
   * A4 (ตัวช่วย) — โอนสิทธิ์เจ้าของให้สมาชิกคนอื่น
   *
   * ★★ ลำดับคำสั่งตรงนี้ห้ามสลับเด็ดขาด: "ลดตัวเองก่อน แล้วค่อยเลื่อนคนใหม่"
   *    ดีบีมี partial unique index (group_id) WHERE role='OWNER' AND status='ACTIVE'
   *    ถ้าเลื่อนคนใหม่ขึ้นก่อน จะมี OWNER สองคนอยู่ชั่วขณะ → index ปฏิเสธทันที
   *    (unique index ไม่ deferrable — มันตรวจทุกคำสั่ง ไม่ใช่ตอน commit)
   *    สลับลำดับเมื่อไหร่ ฟีเจอร์นี้พังทุกครั้ง 100% ไม่ใช่พังเป็นครั้งคราว
   *
   * ★ ทั้งสองคำสั่งใช้ updateMany + ใส่ "สถานะที่คาดว่าจะเป็น" ไว้ใน where
   *   นี่คือ optimistic lock แบบง่ายที่สุด: ถ้ามีใครแก้แถวนั้นตัดหน้าเราไปแล้ว
   *   where จะไม่ match → count = 0 → เรารู้ทันทีและ rollback แทนที่จะเขียนทับของใหม่
   *   (Postgres READ COMMITTED ประเมิน where ใหม่ให้เองหลังได้ row lock)
   */
  async transferOwnership(
    userId: string,
    input: TransferOwnershipInput,
  ): Promise<FamilyGroup> {
    const { groupId, newOwnerUserId } = input;

    if (newOwnerUserId === userId) {
      throw new AlreadyOwnerError();
    }

    const group = await this.prisma.$transaction(async (tx) => {
      // ── 1. ลดเจ้าของปัจจุบัน (ผู้เรียก) ลงเป็น MEMBER ──────────────────
      const demoted = await tx.familyGroupMember.updateMany({
        where: {
          groupId,
          userId,
          status: MEMBER_STATUS.ACTIVE,
          role: GROUP_ROLE.OWNER,
        },
        data: { role: GROUP_ROLE.MEMBER, updatedAt: new Date() },
      });
      if (demoted.count === 0) {
        // ผู้เรียกไม่ใช่เจ้าของ (แล้ว) — อาจโดนโอนสิทธิ์ตัดหน้าไปเมื่อครู่
        throw new NotGroupOwnerError();
      }

      // ── 2. เลื่อนสมาชิกเป้าหมายขึ้นเป็น OWNER ──────────────────────────
      const promoted = await tx.familyGroupMember.updateMany({
        where: {
          groupId,
          userId: newOwnerUserId,
          status: MEMBER_STATUS.ACTIVE,
          role: GROUP_ROLE.MEMBER,
        },
        data: { role: GROUP_ROLE.OWNER, updatedAt: new Date() },
      });
      if (promoted.count === 0) {
        // เป้าหมายไม่ใช่สมาชิก ACTIVE → throw = rollback ข้อ 1 ไปด้วย
        // กลุ่มจึงไม่มีทางเหลือสภาพ "ไม่มีเจ้าของ"
        throw new MemberNotFoundError();
      }

      await this.writeActivity(tx, {
        groupId,
        actorId: userId,
        action: ACTIVITY_ACTION.OWNERSHIP_TRANSFERRED,
        targetType: ACTIVITY_TARGET.MEMBER,
        targetId: newOwnerUserId,
        metadata: { fromUserId: userId, toUserId: newOwnerUserId },
      });

      return tx.familyGroup.findUniqueOrThrow({
        where: { id: groupId },
        select: GROUP_SELECT,
      });
    });

    // myRole ที่คืนกลับจะเป็น 'MEMBER' แล้ว — ผู้เรียกเพิ่งสละสิทธิ์ไป
    // FE จะได้ซ่อนปุ่มของเจ้าของทันทีโดยไม่ต้อง refetch
    return this.toFamilyGroup(group, userId);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Queries
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * กลุ่มทั้งหมดที่ผู้เรียกเป็นสมาชิก ACTIVE อยู่ (ใหม่สุดก่อน)
   *
   * เรื่อง N+1: ตรงนี้เป็นคิวรี่หลัก 1 ครั้ง + คิวรี่ลูกอีก 1 ครั้งที่ Prisma รวบให้
   * (WHERE group_id IN (...)) ไม่ใช่ยิงทีละกลุ่ม — จำนวนคิวรี่คงที่ ไม่โตตามจำนวนกลุ่ม
   */
  async myFamilyGroups(userId: string): Promise<FamilyGroup[]> {
    const groups = await this.prisma.familyGroup.findMany({
      where: {
        members: { some: { userId, status: MEMBER_STATUS.ACTIVE } },
      },
      select: GROUP_SELECT,
      orderBy: { createdAt: 'desc' },
    });

    return groups.map((group) => this.toFamilyGroup(group, userId));
  }

  /**
   * รายละเอียดกลุ่มเดียว — สิทธิ์ถูกตรวจโดย FamilyGroupGuard มาแล้ว
   *
   * ที่นี่จึงไม่เช็คสมาชิกภาพซ้ำ (จะกลายเป็นคิวรี่ซ้ำที่ guard เพิ่งทำไป = N+1
   * ที่การ์ดสั่งให้เลี่ยงพอดี) แต่ยังต้องเช็ค "กลุ่มยังอยู่ไหม" เผื่อโดนลบตัดหน้า
   */
  async familyGroup(userId: string, groupId: string): Promise<FamilyGroup> {
    const group = await this.prisma.familyGroup.findUnique({
      where: { id: groupId },
      select: GROUP_SELECT,
    });
    if (!group) {
      throw new GroupNotFoundError();
    }

    return this.toFamilyGroup(group, userId);
  }

  /**
   * PYG-424 — โปรไฟล์ผู้รับบริการทั้งหมดที่ถูกแชร์อยู่ในกลุ่มนี้
   *
   * สิทธิ์ "เป็นสมาชิก ACTIVE" ถูกตรวจโดย FamilyGroupGuard มาแล้ว (@GroupRole('MEMBER'))
   * ที่นี่จึงกรองด้วย familyGroupId อย่างเดียวพอ ไม่ต้องคิวรี่ตารางสมาชิกซ้ำ
   * (ข้อกำหนด "avoids N+1" ของ PYG-412 — guard อ่านไปแล้วใน request เดียวกัน)
   *
   * ★ ต่างจาก care-recipients REST เดิม (patient/care-recipients.service.ts) ตรงเกณฑ์กรอง:
   *     REST เดิม → where patientId = ฉัน        คือโปรไฟล์ที่ "ฉันเป็นคนเพิ่ม"
   *     อันนี้    → where familyGroupId = กลุ่ม  คือโปรไฟล์ที่ "ถูกแชร์เข้ากลุ่ม" ไม่ว่าใครเพิ่ม
   *   สองอันนี้ตอบคนละคำถาม จึงอยู่ร่วมกันได้ และของเดิมไม่ต้องแก้แม้แต่บรรทัดเดียว
   */
  async groupCareRecipients(groupId: string): Promise<GroupCareRecipient[]> {
    const rows = await this.prisma.careRecipient.findMany({
      where: { familyGroupId: groupId },
      orderBy: { name: 'asc' },
      // เลือกเฉพาะคอลัมน์ที่ GroupCareRecipient ประกาศไว้เท่านั้น
      // ★ ห้าม select ข้อมูลสุขภาพออกมา "เผื่อไว้" — การเผื่อไว้คือวิธีที่ข้อมูล
      //   อ่อนไหวหลุดออก API โดยไม่มีใครตั้งใจ (เหตุผลเต็มอยู่ที่ care-recipient.entity.ts)
      select: { id: true, name: true, nickname: true, patientId: true },
    });

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      nickname: r.nickname ?? undefined,
      ownerUserId: r.patientId,
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Helpers
  // ═══════════════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════════════
  //  PYG-416 · SCR-FG2-001 — ลิงก์เข้าร่วมกลุ่ม
  //
  //  ── โมเดลนี้ต่างจากคำเชิญทางอีเมลเดิมตรงไหน ─────────────────────────
  //  เดิม: 1 คำเชิญ = 1 อีเมล = ใช้ได้ครั้งเดียว ระบบเป็นคนส่งให้
  //  ใหม่: 1 กลุ่ม = 1 ลิงก์ = ใช้ได้หลายครั้งจนกว่าจะเต็มโควตา เจ้าของก๊อปไปส่งเอง
  //
  //  สิ่งที่หายไปพร้อมอีเมลคือ "ตัวจำกัดว่าใครใช้ลิงก์ได้" — เมื่อก่อนคือเจ้าของอีเมล
  //  ตอนนี้คือใครก็ตามที่ถือลิงก์ ตัวควบคุมที่เหลือจึงมีสามชั้นและต้องมีครบทั้งสาม:
  //    1. วันหมดอายุ (expiresAt)   2. โควตา (maxUses)   3. เพดานสมาชิกของกลุ่ม
  //  บวกกับปุ่ม rotate ที่ให้เจ้าของ "ฆ่าลิงก์ที่หลุด" ได้ทันทีโดยไม่ต้องลบกลุ่มทิ้ง
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * B1 — สร้างลิงก์เข้าร่วมของกลุ่ม (เจ้าของเท่านั้น)
   *
   * ★ ถ้ากลุ่มมีลิงก์ ACTIVE อยู่แล้ว จะ "คืนใบเดิม" ไม่สร้างใบใหม่ทับ
   *   ตั้งใจให้เป็นแบบนี้เพราะการกดปุ่มซ้ำ (เน็ตช้า กดสองที มือถือ double-tap)
   *   ไม่ควรฆ่าลิงก์ที่ส่งไปในไลน์ครอบครัวแล้ว การเปลี่ยนลิงก์ต้องเป็นเจตนาชัดเจน
   *   เท่านั้น → ใช้ rotateJoinLink แทน ด้วยเหตุผลเดียวกัน ตัวเลือกใน input
   *   จะถูกเมินเมื่อมีใบเดิมอยู่ (ไม่งั้นการกดซ้ำจะแอบเปลี่ยนโควตาของลิงก์ที่ใช้งานอยู่)
   */
  async createJoinLink(
    userId: string,
    input: CreateJoinLinkInput,
  ): Promise<FamilyGroupJoinLink> {
    this.assertJoinLinkConfig();

    const result = await this.prisma.$transaction(async (tx) => {
      await this.assertOwner(tx, input.groupId, userId);

      const existing = await tx.familyGroupJoinLink.findFirst({
        where: { groupId: input.groupId, status: JOIN_LINK_STATUS.ACTIVE },
      });
      if (existing) {
        return existing;
      }

      const link = await this.insertJoinLink(tx, input, userId);

      await this.writeActivity(tx, {
        groupId: input.groupId,
        actorId: userId,
        action: ACTIVITY_ACTION.JOIN_LINK_CREATED,
        targetType: ACTIVITY_TARGET.JOIN_LINK,
        targetId: link.id,
        // ★ ห้ามใส่ token หรือ url ลง metadata — ฟีดกิจกรรมสมาชิกทุกคนอ่านได้ (PYG-421)
        metadata: {
          maxUses: link.maxUses,
          expiresAt: link.expiresAt.toISOString(),
        },
      });

      return link;
    });

    return this.toJoinLink(
      result,
      await this.countActiveMembers(input.groupId),
    );
  }

  /**
   * B8 — หมุนลิงก์: ยกเลิกใบเดิม + ออกใบใหม่ ในธุรกรรมเดียว
   *
   * นี่คือทางแก้เมื่อลิงก์หลุดไปในกลุ่มที่ไม่ตั้งใจ — ใบเดิมตายทันที
   * ทำในธุรกรรมเดียวเพราะ partial unique index บังคับว่ามี ACTIVE ได้ใบเดียว
   * ถ้าแยกเป็นสองคำสั่งแล้วพังกลางทาง กลุ่มจะเหลือ 0 ลิงก์แบบกู้ไม่ได้อัตโนมัติ
   */
  async rotateJoinLink(
    userId: string,
    input: CreateJoinLinkInput,
  ): Promise<FamilyGroupJoinLink> {
    this.assertJoinLinkConfig();

    const result = await this.prisma.$transaction(async (tx) => {
      await this.assertOwner(tx, input.groupId, userId);

      const revoked = await this.revokeActive(tx, input.groupId);
      const link = await this.insertJoinLink(tx, input, userId);

      await this.writeActivity(tx, {
        groupId: input.groupId,
        actorId: userId,
        action: revoked
          ? ACTIVITY_ACTION.JOIN_LINK_ROTATED
          : ACTIVITY_ACTION.JOIN_LINK_CREATED,
        targetType: ACTIVITY_TARGET.JOIN_LINK,
        targetId: link.id,
        metadata: {
          replacedLinkId: revoked?.id ?? null,
          maxUses: link.maxUses,
          expiresAt: link.expiresAt.toISOString(),
        },
      });

      return link;
    });

    return this.toJoinLink(
      result,
      await this.countActiveMembers(input.groupId),
    );
  }

  /**
   * B3 (ครึ่งแรก) — ยกเลิกลิงก์โดยไม่ออกใบใหม่
   *
   * ต่างจาก rotate ตรงที่หลังจากนี้กลุ่มจะ "ไม่มีลิงก์เลย" จนกว่าเจ้าของจะกดสร้างใหม่
   * ใช้ตอนที่เชิญคนครบแล้วและอยากปิดประตู ไม่ใช่ตอนลิงก์หลุด
   */
  async revokeJoinLink(userId: string, groupId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertOwner(tx, groupId, userId);

      const revoked = await this.revokeActive(tx, groupId);
      if (!revoked) {
        throw new JoinLinkNotFoundError();
      }

      await this.writeActivity(tx, {
        groupId,
        actorId: userId,
        action: ACTIVITY_ACTION.JOIN_LINK_REVOKED,
        targetType: ACTIVITY_TARGET.JOIN_LINK,
        targetId: revoked.id,
        metadata: { usedCount: revoked.usedCount },
      });

      return true;
    });
  }

  /**
   * อ่านลิงก์ปัจจุบันของกลุ่ม (เจ้าของเท่านั้น) — ตัวที่ทำให้ปุ่ม "คัดลอกลิงก์" กดซ้ำได้
   *
   * ★ เมธอดนี้คือเหตุผลทั้งหมดที่เราเก็บ tokenRaw ลงดีบี (ข้อตัดสินใจ ก. ของ SCR)
   *   ถ้าเก็บแค่ hash เมธอดนี้จะเขียนไม่ได้เลย และเจ้าของกลุ่มจะต้อง rotate
   *   ทุกครั้งที่อยากส่งลิงก์ให้คนถัดไป ซึ่งจะฆ่าลิงก์ของคนก่อนหน้าที่ยังไม่ได้กด
   */
  async groupJoinLink(
    userId: string,
    groupId: string,
  ): Promise<FamilyGroupJoinLink> {
    // ตรวจสิทธิ์กับอ่านลิงก์อยู่ในธุรกรรมเดียวกัน — ถ้าแยกกัน คนที่เพิ่งถูกโอนสิทธิ์ออก
    // ระหว่างสองคำสั่งจะยังได้ url กลับไป ซึ่งเท่ากับแจกลิงก์ให้คนที่ไม่ใช่เจ้าของแล้ว
    const link = await this.prisma.$transaction(async (tx) => {
      await this.assertOwner(tx, groupId, userId);

      const active = await tx.familyGroupJoinLink.findFirst({
        where: { groupId, status: JOIN_LINK_STATUS.ACTIVE },
      });
      if (!active) {
        throw new JoinLinkNotFoundError();
      }
      return active;
    });

    return this.toJoinLink(link, await this.countActiveMembers(groupId));
  }

  /**
   * B2 (ครึ่งแรก) — สิ่งที่คนถือลิงก์เห็นก่อนกดยืนยัน
   *
   * เปิดให้ผู้ใช้ที่ล็อกอินแล้ว "ทุกคน" เรียกได้ ไม่ใช่แค่สมาชิก — เพราะคนที่กำลังจะเข้ากลุ่ม
   * ยังไม่ได้เป็นสมาชิกโดยนิยาม สิ่งที่กันคนนอกคือตัว token เอง ไม่ใช่ role
   *
   * ★ ลิงก์ที่หมดอายุ/ถูกยกเลิก/เต็มแล้ว จะ "ไม่ throw" แต่คืน isUsable = false
   *   พร้อมชื่อกลุ่ม เพื่อให้ FE ขึ้นหน้าว่า "ลิงก์เข้ากลุ่มบ้านยายหมดอายุแล้ว"
   *   ซึ่งช่วยให้ผู้ใช้รู้ว่าต้องไปขอลิงก์ใหม่จากใคร ต่างจากหน้า error เปล่า ๆ
   *   ที่ throw จริงมีกรณีเดียวคือ token ที่ไม่ตรงกับแถวไหนเลย (เดามา/พิมพ์ผิด)
   */
  async joinLinkPreview(
    userId: string,
    token: string,
  ): Promise<JoinLinkPreview> {
    const link = await this.prisma.familyGroupJoinLink.findUnique({
      where: { tokenHash: this.hashJoinToken(token) },
      select: {
        id: true,
        groupId: true,
        status: true,
        maxUses: true,
        usedCount: true,
        expiresAt: true,
        group: {
          select: {
            name: true,
            members: {
              where: { status: MEMBER_STATUS.ACTIVE },
              select: {
                userId: true,
                role: true,
                user: { select: { displayName: true } },
              },
            },
          },
        },
      },
    });

    if (!link) {
      throw new JoinLinkInvalidError();
    }

    const activeMembers = link.group.members;
    const owner = activeMembers.find((m) => m.role === GROUP_ROLE.OWNER);
    const memberCount = activeMembers.length;

    return {
      groupName: link.group.name,
      ownerName: owner?.user?.displayName ?? null,
      memberCount,
      isUsable: this.joinLinkUnusableReason(link, memberCount) === null,
      unusableReason: this.joinLinkUnusableReason(link, memberCount),
      alreadyMember: activeMembers.some((m) => m.userId === userId),
    };
  }

  /**
   * token ดิบ → sha256 hex สำหรับค้นหาแถว
   *
   * public เพราะ PYG-417 (joinGroupByLink) ต้องใช้ตัวนี้เป๊ะ ๆ
   * ถ้าไปเขียน createHash เองอีกที่ วันที่เปลี่ยนวิธี hash จะแก้ไม่ครบ
   * (แพตเทิร์นเดียวกับ JobQrService.hashToken ของ PYG-434)
   */
  hashJoinToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  // ─── ตัวช่วยภายในของลิงก์เข้าร่วม ────────────────────────────────────────

  /**
   * เหตุผลที่ลิงก์กดไม่ได้ — คืน null แปลว่าใช้ได้
   *
   * ★ ลำดับการเช็คมีความหมาย: REVOKED ต้องมาก่อน EXPIRED
   *   ลิงก์ที่ถูกยกเลิกไปแล้วและต่อมาเลยวันหมดอายุ ควรบอกว่า "ถูกยกเลิก"
   *   เพราะนั่นคือสิ่งที่เจ้าของกลุ่มตั้งใจทำ ส่วนวันหมดอายุแค่ผ่านไปเฉย ๆ
   */
  private joinLinkUnusableReason(
    link: {
      status: string;
      expiresAt: Date;
      maxUses: number | null;
      usedCount: number;
    },
    memberCount: number,
  ): 'REVOKED' | 'EXPIRED' | 'EXHAUSTED' | 'GROUP_FULL' | null {
    if (link.status !== JOIN_LINK_STATUS.ACTIVE) return 'REVOKED';
    if (link.expiresAt.getTime() <= Date.now()) return 'EXPIRED';
    if (link.maxUses !== null && link.usedCount >= link.maxUses)
      return 'EXHAUSTED';
    if (memberCount >= GROUP_MAX_MEMBERS) return 'GROUP_FULL';
    return null;
  }

  /**
   * แปลงเหตุผลด้านบนเป็น error ที่โยนได้ — PYG-417 เรียกใช้ตอนกดเข้าร่วมจริง
   * แยกออกมาเพื่อให้ "หน้า preview" กับ "ตอนกดเข้าร่วม" ตัดสินด้วยตรรกะชุดเดียวกัน
   * ไม่งั้นจะเกิดเคสที่ preview บอกว่าเข้าได้ แต่กดแล้วเด้ง หรือกลับกัน
   */
  assertJoinLinkUsable(
    link: {
      status: string;
      expiresAt: Date;
      maxUses: number | null;
      usedCount: number;
    },
    memberCount: number,
  ): void {
    switch (this.joinLinkUnusableReason(link, memberCount)) {
      case 'REVOKED':
        throw new JoinLinkRevokedError();
      case 'EXPIRED':
        throw new JoinLinkExpiredError(link.expiresAt);
      case 'EXHAUSTED':
        throw new JoinLinkExhaustedError(link.maxUses as number);
      case 'GROUP_FULL':
        throw new GroupMemberLimitReachedError(GROUP_MAX_MEMBERS);
      default:
        return;
    }
  }

  /** สร้างแถวลิงก์ใหม่ 1 ใบ — ใช้ร่วมกันระหว่าง create กับ rotate */
  private insertJoinLink(
    tx: Prisma.TransactionClient,
    input: CreateJoinLinkInput,
    userId: string,
  ) {
    // base64url ไม่ใช่ hex — ได้ 43 ตัวอักษรแทน 64 ลิงก์สั้นลงพอสมควร
    // และไม่มีอักขระที่ต้อง percent-encode เวลาแปะในไลน์
    const token = randomBytes(JOIN_LINK_TOKEN_BYTES).toString('base64url');
    const ttlHours = input.ttlHours ?? JOIN_LINK_TTL_HOURS;

    return tx.familyGroupJoinLink.create({
      data: {
        groupId: input.groupId,
        tokenHash: this.hashJoinToken(token),
        tokenRaw: token,
        status: JOIN_LINK_STATUS.ACTIVE,
        maxUses: input.maxUses ?? JOIN_LINK_MAX_USES,
        expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000),
        createdBy: userId,
      },
    });
  }

  /**
   * ยกเลิกลิงก์ ACTIVE ของกลุ่ม (ถ้ามี) — คืนแถวที่ถูกยกเลิก หรือ null ถ้าไม่มี
   *
   * ใช้ updateMany + เงื่อนไข status เดิมใน where ตามกติกาข้อ 3 ของไฟล์นี้
   * ถ้าใช้ update() เฉย ๆ สอง request ที่กด revoke พร้อมกันจะเขียน revokedAt ทับกัน
   * แล้วฟีดจะมี JOIN_LINK_REVOKED สองแถวสำหรับการยกเลิกครั้งเดียว
   */
  private async revokeActive(tx: Prisma.TransactionClient, groupId: string) {
    const current = await tx.familyGroupJoinLink.findFirst({
      where: { groupId, status: JOIN_LINK_STATUS.ACTIVE },
    });
    if (!current) return null;

    const { count } = await tx.familyGroupJoinLink.updateMany({
      where: { id: current.id, status: JOIN_LINK_STATUS.ACTIVE },
      data: { status: JOIN_LINK_STATUS.REVOKED, revokedAt: new Date() },
    });

    // แพ้เกมแย่งกัน — มีคนยกเลิกไปก่อนหน้าเราเสี้ยววินาที ถือว่าไม่ได้ยกเลิกเอง
    return count === 1 ? current : null;
  }

  private countActiveMembers(groupId: string): Promise<number> {
    return this.prisma.familyGroupMember.count({
      where: { groupId, status: MEMBER_STATUS.ACTIVE },
    });
  }

  /**
   * ล้มตั้งแต่ต้นทางถ้า env ไม่ครบ แทนที่จะไปสร้างลิงก์ที่ประกอบ URL ไม่ได้
   * (ลิงก์ที่ขึ้นต้นด้วย "undefined/join?token=..." คือลิงก์เสียที่นอนอยู่ในดีบีถาวร)
   */
  private assertJoinLinkConfig(): void {
    if (!joinLinkBaseUrl()) {
      this.logger.error(
        'ไม่ได้ตั้ง APP_PUBLIC_BASE_URL — สร้างลิงก์เข้าร่วมกลุ่มไม่ได้ (PYG-428)',
      );
      throw new JoinLinkConfigMissingError();
    }
  }

  /** แถวจากดีบี → type ที่ GraphQL ส่งออก (เฉพาะฝั่งเจ้าของกลุ่ม) */
  private toJoinLink(
    link: {
      id: string;
      groupId: string;
      tokenRaw: string | null;
      status: string;
      maxUses: number | null;
      usedCount: number;
      expiresAt: Date;
      createdAt: Date;
    },
    memberCount: number,
  ): FamilyGroupJoinLink {
    return {
      id: link.id,
      groupId: link.groupId,
      url: `${joinLinkBaseUrl().replace(/\/+$/, '')}${JOIN_LINK_PATH}?token=${
        link.tokenRaw ?? ''
      }`,
      expiresAt: link.expiresAt,
      maxUses: link.maxUses,
      remainingUses:
        link.maxUses === null
          ? null
          : Math.max(0, link.maxUses - link.usedCount),
      memberCount,
      memberLimit: GROUP_MAX_MEMBERS,
      isUsable: this.joinLinkUnusableReason(link, memberCount) === null,
      createdAt: link.createdAt,
    };
  }

  /**
   * ตัดช่องว่างหัวท้าย แล้วยืนยันว่าชื่อยังอยู่ในกติกา
   *
   * DTO ตรวจไปแล้วรอบหนึ่ง — ที่นี่ตรวจซ้ำเพราะ service อาจถูกเรียกจากที่อื่น
   * ที่ไม่ผ่าน ValidationPipe (เช่น seed script หรือการ์ดอื่นที่ import service นี้ไปใช้)
   * ด่านสุดท้ายจริง ๆ คือ CHECK ในดีบี แต่ error จากดีบีอ่านไม่รู้เรื่องสำหรับผู้ใช้
   */
  private assertValidName(raw: string): string {
    const name = (raw ?? '').trim();
    if (
      name.length < GROUP_NAME_MIN_LENGTH ||
      name.length > GROUP_NAME_MAX_LENGTH
    ) {
      throw new GroupNameInvalidError(GROUP_NAME_MAX_LENGTH);
    }
    return name;
  }

  /**
   * ยืนยันว่า userId เป็น OWNER ที่ ACTIVE ของกลุ่มนี้จริง — ใช้ภายใน transaction
   *
   * ทำไมต้องมีทั้งที่ guard เช็คไปแล้ว?
   *   guard เช็ค "ก่อนเข้า transaction" ส่วนอันนี้เช็ค "ข้างใน transaction"
   *   ระหว่างสองจุดนั้นมีช่องว่างที่สิทธิ์เปลี่ยนได้จริง (โดนโอนสิทธิ์/โดนเตะพอดี)
   *   การ์ดสั่งไว้ตรง ๆ ว่า owner-only mutations ต้อง double-check ฝั่งเซิร์ฟเวอร์
   */
  private async assertOwner(
    tx: Prisma.TransactionClient,
    groupId: string,
    userId: string,
  ): Promise<void> {
    const owner = await tx.familyGroupMember.findFirst({
      where: {
        groupId,
        userId,
        status: MEMBER_STATUS.ACTIVE,
        role: GROUP_ROLE.OWNER,
      },
      select: { id: true },
    });
    if (!owner) {
      throw new NotGroupOwnerError();
    }
  }

  /**
   * เรียกเมื่อ updateMany ได้ count = 0 — แปลว่ามีอะไรไม่ตรงคาด แต่ยังไม่รู้ว่าอะไร
   * อ่านแถวจริงมาดูเพื่อคืน error ที่ตรงสาเหตุ แทนที่จะโยน error กว้าง ๆ ให้ผู้ใช้เดาเอง
   *
   * ★ เมธอดนี้ throw เสมอ ไม่มีทางคืนค่าปกติ (return type = never)
   *   ถ้ามันคืนค่าได้ ผู้เรียกจะเผลอทำงานต่อทั้งที่ update ไม่สำเร็จ
   */
  private async explainMemberUpdateFailure(
    tx: Prisma.TransactionClient,
    groupId: string,
    userId: string,
  ): Promise<never> {
    const row = await tx.familyGroupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
      select: { role: true, status: true },
    });

    // ไม่มีแถว หรือออกไปแล้ว → ไม่ใช่สมาชิกของกลุ่มนี้
    if (!row || row.status !== MEMBER_STATUS.ACTIVE) {
      throw new MemberNotFoundError();
    }
    // ยัง ACTIVE แต่เป็น OWNER → นี่คือเจ้าของคนสุดท้าย (OWNER มีได้คนเดียว)
    throw new LastOwnerError();
  }

  /**
   * เขียน 1 แถวลงฟีดกิจกรรม — ต้องส่ง tx เข้ามาเสมอ (ไม่รับ this.prisma)
   *
   * บังคับ type ของพารามิเตอร์เป็น TransactionClient ไว้แบบนี้โดยตั้งใจ:
   * มันทำให้ "ลืมเขียน activity ใน transaction เดียวกัน" กลายเป็น compile error
   * แทนที่จะเป็นบั๊กเงียบ ๆ ที่ไปโผล่ตอนฟีดมีเหตุการณ์ที่ไม่เคยเกิดขึ้นจริง (AC A5)
   */
  private async writeActivity(
    tx: Prisma.TransactionClient,
    entry: {
      groupId: string;
      actorId: string | null;
      action: ActivityAction;
      targetType: ActivityTarget;
      targetId: string;
      metadata: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    await tx.familyGroupActivity.create({
      data: {
        groupId: entry.groupId,
        actorId: entry.actorId,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        metadata: entry.metadata,
      },
    });
  }

  /** แปลงแถวจากดีบีเป็น type ที่ GraphQL ส่งออก */
  private toFamilyGroup(group: GroupRow, viewerId: string): FamilyGroup {
    const members = group.members.map((m) => this.toMemberItem(m, viewerId));

    // เจ้าของขึ้นก่อนเสมอ ที่เหลือคงลำดับ joinedAt จากดีบีไว้
    // (ไม่ใช้ orderBy role ที่ดีบี เพราะนั่นคือการเรียงตามตัวอักษรที่บังเอิญถูก
    //  วันที่เพิ่ม role ใหม่ที่ขึ้นต้นด้วย A–N ลำดับจะเพี้ยนเงียบ ๆ)
    members.sort((a, b) => {
      if (a.role === b.role) return 0;
      return a.role === GROUP_ROLE.OWNER ? -1 : 1;
    });

    const me = members.find((m) => m.userId === viewerId);

    return {
      id: group.id,
      name: group.name,
      createdBy: group.createdBy ?? undefined,
      // ผู้เรียกต้องเป็นสมาชิกเสมอ (guard การันตี) — ?? กันเคสที่เพิ่งสละสิทธิ์ไป
      myRole: me?.role ?? GROUP_ROLE.MEMBER,
      memberCount: members.length,
      members,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
    };
  }

  /** แปลงแถวสมาชิก 1 คน */
  private toMemberItem(
    row: MemberRow,
    viewerId: string,
  ): FamilyGroupMemberItem {
    return {
      id: row.id,
      userId: row.userId,
      displayName: row.user?.displayName ?? undefined,
      email: row.user?.email ?? '',
      avatarUrl: row.user?.avatarUrl ?? undefined,
      role: row.role,
      joinedAt: row.joinedAt,
      isMe: row.userId === viewerId,
    };
  }
}
