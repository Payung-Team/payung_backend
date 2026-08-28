import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { CreateFamilyGroupInput } from './dto/create-family-group.input';
import { RenameFamilyGroupInput } from './dto/rename-family-group.input';
import { RemoveMemberInput } from './dto/remove-member.input';
import { TransferOwnershipInput } from './dto/transfer-ownership.input';
import {
  DeleteFamilyGroupResult,
  FamilyGroup,
  LeaveFamilyGroupResult,
} from './entities/family-group.entity';
import { FamilyGroupMemberItem } from './entities/family-group-member.entity';
import { GroupCareRecipient } from './entities/care-recipient.entity';
import {
  ACTIVITY_ACTION,
  ACTIVITY_TARGET,
  ActivityAction,
  ActivityTarget,
  GROUP_NAME_MAX_LENGTH,
  GROUP_NAME_MIN_LENGTH,
  GROUP_ROLE,
  MEMBER_STATUS,
} from './family-group.constants';
import {
  AlreadyOwnerError,
  GroupNameInvalidError,
  GroupNotFoundError,
  LastOwnerError,
  MemberNotFoundError,
  NotGroupOwnerError,
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
