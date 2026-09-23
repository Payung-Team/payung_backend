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
import {
  FamilyGroupActivityConnection,
  FamilyGroupActivityItem,
} from './entities/family-group-activity.entity';
import { GroupCareRecipient } from './entities/care-recipient.entity';
import {
  FamilyGroupJoinLink,
  JoinLinkPreview,
} from './entities/family-group-join-link.entity';
import {
  ACTIVITY_ACTION,
  ACTIVITY_CURSOR_SEPARATOR,
  ACTIVITY_PAGE_SIZE_DEFAULT,
  ACTIVITY_PAGE_SIZE_MAX,
  ACTIVITY_TARGET,
  ActivityAction,
  ActivityTarget,
  GROUP_NAME_MAX_LENGTH,
  GROUP_NAME_MIN_LENGTH,
  GROUP_ROLE,
  GroupRoleName,
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
  ActivityCursorInvalidError,
  AlreadyOwnerError,
  GroupNameInvalidError,
  GroupNotFoundError,
  LastOwnerError,
  MemberNotFoundError,
  NotAMemberError,
  NotGroupOwnerError,
  GroupMemberLimitReachedError,
  JoinLinkConfigMissingError,
  JoinLinkExhaustedError,
  JoinLinkExpiredError,
  JoinLinkInvalidError,
  JoinLinkNotFoundError,
  JoinLinkRevokedError,
  RecipientNotInGroupError,
  RecipientNotOwnerError,
} from './family-group.errors';
import {
  AddGroupCareRecipientInput,
  UpdateGroupCareRecipientInput,
  RemoveGroupCareRecipientInput,
} from './dto/manage-care-recipient.input';
import { RemoveGroupCareRecipientResult } from './entities/care-recipient.entity';
import {
  PATIENT_PROFILE_SELECT,
  toPatientProfile,
} from '../patient/patient-profile.mapper';
// PYG-517: ชื่อตามบัญชี — ฟังก์ชันเดียวกับที่ PYG-516 ใช้เขียนลงใบจอง
import {
  ACCOUNT_NAME_SELECT,
  accountDisplayName,
} from '../common/utils/account-name';
import { GroupBookingRecipient } from './entities/group-booking-recipient.entity';

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
 * field set ของ "กิจกรรม 1 แถว" ในฟีด (PYG-421)
 *
 * ★ ระบุคอลัมน์เอง ไม่ใช้ include เปล่า ๆ — ตาราง users มีทั้งอีเมล เบอร์โทร ที่อยู่
 *   การ join ทั้งแถวมาแล้วค่อยไปตัดทิ้งในโค้ดคือวิธีที่ข้อมูลส่วนบุคคลหลุดออก API
 *   ตอนมีคนเผลอเติมฟิลด์ใน entity ทีหลัง (เหตุผลเดียวกับ groupCareRecipients)
 *
 * ★★ ไม่มี email ของ actor ในนี้ ต่างจาก MEMBER_SELECT โดยตั้งใจ
 *    ฟีดต้องการแค่ "ชื่อกับรูปให้จำหน้าได้" ส่วนอีเมลมีที่ทางของมันอยู่แล้ว
 *    ในหน้ารายชื่อสมาชิก ซึ่งแสดงเฉพาะคนที่ยัง ACTIVE — ฟีดย้อนหลังไปถึงคนที่
 *    ออกจากกลุ่มไปแล้ว ถ้าใส่อีเมลมาด้วยเท่ากับเปิดสมุดที่อยู่ของอดีตสมาชิกทั้งหมด
 */
const ACTIVITY_SELECT = {
  id: true,
  actorId: true,
  action: true,
  targetType: true,
  targetId: true,
  metadata: true,
  createdAt: true,
  actor: { select: { displayName: true, avatarUrl: true } },
} as const;

/** รูปทรงแถวที่ ACTIVITY_SELECT คืนกลับ */
type ActivityRow = Prisma.FamilyGroupActivityGetPayload<{
  select: typeof ACTIVITY_SELECT;
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
 *   สร้าง/หมุน/ยกเลิกลิงก์เข้าร่วม = PYG-416 · กดเข้าร่วมจริง (joinGroupByLink) = PYG-417
 *   ฟีดกิจกรรมแบบแบ่งหน้า = PYG-421 · จองแทน = PYG-424 (อยู่ที่ BookingService)
 *   ★ ช่องว่างที่ยังเหลือของฟีด (PYG-421 อ่านได้ครบทุก action แล้ว แต่ฝั่งเขียนยังขาด):
 *     - add/update/removeGroupCareRecipient ยังไม่เขียน RECIPIENT_ADDED/UPDATED/REMOVED
 *       และยังไม่อยู่ใน $transaction — ขัดกับกติกาข้อ 2 ด้านบน
 *     - คนที่เคยออกแล้วกลับเข้ามา ถูกบันทึกเป็น MEMBER_JOINED ไม่ใช่ MEMBER_REJOINED
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
   * โปรไฟล์ที่ถูก "แชร์เข้ากลุ่มนี้" แล้วเท่านั้น พร้อมรายละเอียดสำหรับจองแทน.
   *
   * ★ ไม่ดึงโปรไฟล์ส่วนตัว (`family_group_id IS NULL`) ของสมาชิก
   *   เดิมเงื่อนไขเป็น `OR: [{ familyGroupId: null }, { familyGroupId: groupId }]`
   *   ซึ่งหมายความว่า "ทุกโปรไฟล์ส่วนตัวของสมาชิกทุกคน" ถูกส่งออกมาพร้อม `details`
   *   (อายุ เพศ โรคประจำตัว ยาที่ใช้ ประวัติแพ้ ฯลฯ) ให้สมาชิกคนอื่นในกลุ่มเห็น
   *   รวมใบ `is_self` ที่ระบบสร้างให้ตอน Onboarding — คนกรอกไม่เคยเลือกที่จะแชร์อะไรเลย
   *
   *   นั่นคือการเปิดเผยข้อมูลสุขภาพโดยไม่มีความยินยอม (PDPA ม.26) และขัดกับ
   *   ประกาศความเป็นส่วนตัวของเราเองที่เขียนว่าข้อมูลสุขภาพแชร์เฉพาะที่เจ้าของเลือกแชร์
   *
   *   การแชร์เข้ากลุ่มมีทางเดียวคือ `addGroupCareRecipient` ซึ่งเจ้าของเป็นคนกด
   *   (หรือกลไกคัดลอกเข้ากลุ่มตอนจองจริงของ PYG-500) — เงื่อนไขนี้จึงตรงกับ
   *   คำอธิบายของ query ที่เขียนไว้ตั้งแต่แรกว่า "โปรไฟล์ทั้งหมดที่ถูกแชร์อยู่ในกลุ่มนี้"
   *
   *   ★ ไม่มีใครเสียความสามารถไป: เส้นทางจองแทนด้วย careRecipientId ปฏิเสธโปรไฟล์
   *     ส่วนตัวอยู่แล้ว (`recipient.familyGroupId !== input.groupId` → RecipientNotInGroupError)
   *     แถวที่ตัดออกนี้จึงเป็นตัวเลือกที่กดแล้ว error มาตลอด — รั่วข้อมูลโดยไม่มีคนได้ใช้
   *
   *   PYG-517 (`groupBookingRecipients`) ใช้เงื่อนไขนี้อยู่แล้ว ใบนี้แก้ของเดิมให้ตรงกัน
   */
  async groupCareRecipients(groupId: string): Promise<GroupCareRecipient[]> {
    const members = await this.prisma.familyGroupMember.findMany({
      where: { groupId, status: MEMBER_STATUS.ACTIVE },
      select: { userId: true },
    });
    const rows = await this.prisma.careRecipient.findMany({
      where: {
        patientId: { in: members.map((member) => member.userId) },
        is_deleted: false,
        familyGroupId: groupId,
      },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        nickname: true,
        patientId: true,
        self_reported: true,
        ...PATIENT_PROFILE_SELECT,
      },
    });

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      nickname: r.nickname ?? undefined,
      ownerUserId: r.patientId,
      selfReported: r.self_reported,
      details: toPatientProfile(r),
    }));
  }


  /**
   * PYG-517 — รายชื่อสมาชิก ACTIVE ทุกคน (รวมเจ้าของกลุ่ม) พร้อมข้อมูลสำหรับ autofill
   *
   * ใช้เป็น shortcut ในขั้น "กรอกข้อมูลผู้เข้ารับบริการ" ตอนจองแทน — กดชื่อสมาชิกแล้ว
   * ฟอร์มเติมให้อัตโนมัติ ส่วนชื่อ-นามสกุลล็อก (PYG-516 ปฏิเสธ patientName ที่ส่งมา)
   *
   * ★ มองเป็น "รายชื่อคน" ไม่ใช่ "รายชื่อโปรไฟล์" — สมาชิกทุกคนได้หนึ่งรายการเสมอ
   *   แม้ยังไม่มีโปรไฟล์ในกลุ่ม (hasProfile = false, details = null) เพื่อให้ FE
   *   มีปุ่มให้กดครบทุกคน ไม่ใช่หายไปเงียบ ๆ เพราะยังไม่เคยถูกจองให้
   *
   * ★★ ไม่ดึงโปรไฟล์ส่วนตัว (family_group_id = NULL รวมใบ is_self จาก Onboarding)
   *    ข้อมูลสุขภาพส่วนตัวยังไม่ได้แชร์เข้ากลุ่ม — เอามาโชว์ให้สมาชิกคนอื่นคือการเปิดเผย
   *    ข้อมูลอ่อนไหวโดยไม่มีความยินยอม (PDPA ม.26 · consent disclose_to_family_group)
   *    โปรไฟล์ส่วนตัวถูกคัดลอกเข้ากลุ่มตอน "จองจริง" ตามกลไกเดิม (PYG-500 สาขา ②)
   *
   * ชื่อมาจากบัญชีด้วย accountDisplayName ตัวเดียวกับที่ PYG-516 ใช้เขียนลง
   * care_recipients.name / bookings.patient_name — ถ้าคำนวณคนละแบบ ผู้ใช้จะกดชื่อหนึ่ง
   * แล้วใบจองขึ้นอีกชื่อหนึ่งโดยไม่มี error ให้เห็น
   *
   * สิทธิ์ "ผู้เรียกเป็นสมาชิก ACTIVE" ถูกตรวจโดย FamilyGroupGuard ที่ resolver แล้ว
   */
  async groupBookingRecipients(
    groupId: string,
  ): Promise<GroupBookingRecipient[]> {
    const members = await this.prisma.familyGroupMember.findMany({
      where: { groupId, status: MEMBER_STATUS.ACTIVE },
      orderBy: { joinedAt: 'asc' },
      select: {
        userId: true,
        user: { select: ACCOUNT_NAME_SELECT },
      },
    });
    if (members.length === 0) return [];

    // โปรไฟล์ "ในกลุ่มนี้" เท่านั้น — familyGroupId ต้องเท่ากับ groupId ตรง ๆ
    const profiles = await this.prisma.careRecipient.findMany({
      where: {
        patientId: { in: members.map((m) => m.userId) },
        familyGroupId: groupId,
        is_deleted: false,
      },
      // สมาชิกหนึ่งคนอาจมีหลายใบในกลุ่ม (ข้อมูลเก่า) — เอาใบที่อัปเดตล่าสุด
      orderBy: { updated_at: 'desc' },
      select: {
        patientId: true,
        nickname: true,
        address_line: true,
        province: true,
        district: true,
        ...PATIENT_PROFILE_SELECT,
      },
    });

    const profileByMember = new Map<string, (typeof profiles)[number]>();
    for (const profile of profiles) {
      if (!profileByMember.has(profile.patientId)) {
        profileByMember.set(profile.patientId, profile);
      }
    }

    return members.map((member) => {
      const profile = profileByMember.get(member.userId);
      const health = profile ? toPatientProfile(profile) : undefined;

      return {
        memberUserId: member.userId,
        // ★ ไม่มีชื่อในบัญชี → สตริงว่าง ไม่ใช่ error
        //   ลิสต์ทั้งกลุ่มต้องไม่พังเพราะสมาชิกคนเดียวยังไม่ได้กรอกชื่อ
        //   ตอนกดจองจริงถึงจะโดนปฏิเสธด้วย MEMBER_NAME_MISSING (PYG-516)
        name: accountDisplayName(member.user) ?? '',
        nameLocked: true,
        nickname: profile?.nickname ?? undefined,
        hasProfile: profile !== undefined,
        details: profile
          ? {
              ...health,
              addressLine: profile.address_line ?? undefined,
              province: profile.province ?? undefined,
              district: profile.district ?? undefined,
            }
          : undefined,
      };
    });
  }

  // ── PYG-385: เพิ่ม/แก้ไข/นำออกโปรไฟล์ผู้รับบริการในกลุ่ม ────────────────────
  //
  //  สิทธิ์ระดับกลุ่ม (เป็นสมาชิก ACTIVE) ถูกตรวจโดย FamilyGroupGuard ที่ resolver แล้ว
  //  ที่นี่เหลือแค่สิทธิ์ระดับโปรไฟล์: "เจ้าของเท่านั้นที่แก้/ลบได้"
  //  (เพิ่มได้ทุกสมาชิก — คนที่เพิ่มกลายเป็นเจ้าของโปรไฟล์นั้น)

  /** เพิ่มโปรไฟล์ใหม่เข้ากลุ่ม — patientId = คนเพิ่ม, familyGroupId = กลุ่มนี้ */
  async addGroupCareRecipient(
    userId: string,
    input: AddGroupCareRecipientInput,
  ): Promise<GroupCareRecipient> {
    const r = await this.prisma.careRecipient.create({
      data: {
        patientId: userId,
        familyGroupId: input.groupId,
        name: input.name.trim(),
        nickname: input.nickname?.trim() || null,
      },
      select: { id: true, name: true, nickname: true, patientId: true, self_reported: true },
    });
    this.logger.log({
      event: 'group_care_recipient.added',
      id: r.id,
      groupId: input.groupId,
      by: userId,
    });
    return {
      id: r.id,
      name: r.name,
      nickname: r.nickname ?? undefined,
      ownerUserId: r.patientId,
      selfReported: r.self_reported,
    };
  }

  /** แก้ไขโปรไฟล์ — เฉพาะเจ้าของ (คนที่เพิ่ม) เท่านั้น */
  async updateGroupCareRecipient(
    userId: string,
    input: UpdateGroupCareRecipientInput,
  ): Promise<GroupCareRecipient> {
    const existing = await this.prisma.careRecipient.findUnique({
      where: { id: input.recipientId },
      select: { patientId: true, familyGroupId: true },
    });
    // ไม่มีจริง หรือไม่ได้อยู่ในกลุ่มนี้ → ตอบเหมือนกัน (กันเดา id ข้ามกลุ่ม, PDPA)
    if (!existing || existing.familyGroupId !== input.groupId) {
      throw new RecipientNotInGroupError();
    }
    if (existing.patientId !== userId) throw new RecipientNotOwnerError();

    const r = await this.prisma.careRecipient.update({
      where: { id: input.recipientId },
      data: {
        ...(input.name !== undefined && { name: input.name.trim() }),
        ...(input.nickname !== undefined && { nickname: input.nickname.trim() || null }),
      },
      select: { id: true, name: true, nickname: true, patientId: true, self_reported: true },
    });
    this.logger.log({
      event: 'group_care_recipient.updated',
      id: r.id,
      groupId: input.groupId,
      by: userId,
    });
    return {
      id: r.id,
      name: r.name,
      nickname: r.nickname ?? undefined,
      ownerUserId: r.patientId,
      selfReported: r.self_reported,
    };
  }

  /**
   * นำโปรไฟล์ออกจากกลุ่ม (unshare) — set familyGroupId = null ไม่ใช่ลบทิ้ง
   * โปรไฟล์ยังอยู่เป็นของส่วนตัวของเจ้าของ และ booking เก่ายังอ้าง careRecipientId ได้เหมือนเดิม
   * (booking เก็บ familyGroupId ของตัวเอง จึงไม่กระทบฟีดย้อนหลัง)
   */
  async removeGroupCareRecipient(
    userId: string,
    input: RemoveGroupCareRecipientInput,
  ): Promise<RemoveGroupCareRecipientResult> {
    const existing = await this.prisma.careRecipient.findUnique({
      where: { id: input.recipientId },
      select: { patientId: true, familyGroupId: true },
    });
    if (!existing || existing.familyGroupId !== input.groupId) {
      throw new RecipientNotInGroupError();
    }
    if (existing.patientId !== userId) throw new RecipientNotOwnerError();

    await this.prisma.careRecipient.update({
      where: { id: input.recipientId },
      data: { familyGroupId: null },
    });
    this.logger.log({
      event: 'group_care_recipient.removed',
      id: input.recipientId,
      groupId: input.groupId,
      by: userId,
    });
    return { recipientId: input.recipientId, removed: true };
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
   * อ่านลิงก์ปัจจุบันของกลุ่ม (สมาชิก ACTIVE ทุกคน) — ตัวที่ทำให้ปุ่ม "คัดลอกลิงก์" กดซ้ำได้
   *
   * ★ PYG-478 · SCR-FG2-001 Amendment 1 (B9/B10) — เดิมเปิดให้เจ้าของคนเดียว
   *   ตอนนี้สมาชิก ACTIVE ทุกคน (ทั้ง OWNER และ MEMBER) อ่านได้ เพราะคนที่นึกได้ว่า
   *   ต้องชวนญาติคนไหนเพิ่ม มักไม่ใช่คนเดียวกับคนที่สร้างกลุ่ม
   *   ส่วน สร้าง/หมุน/ยกเลิก ลิงก์ ยังเป็นของเจ้าของคนเดียวเหมือนเดิม (assertOwner ใน
   *   createJoinLink / rotateJoinLink / revokeJoinLink ด้านบน ไม่ได้แตะ)
   *   → ตัวคุมจริงของลิงก์ (โควตา max_uses, เพดานสมาชิก, วันหมดอายุ, การ rotate)
   *     ยังอยู่ในมือเจ้าของ — ระบบคุม "การส่งต่อ" ไม่ได้อยู่แล้วตั้งแต่ลิงก์ออกจากแอป
   *
   * ★ เมธอดนี้คือเหตุผลทั้งหมดที่เราเก็บ tokenRaw ลงดีบี (ข้อตัดสินใจ ก. ของ SCR)
   *   ถ้าเก็บแค่ hash เมธอดนี้จะเขียนไม่ได้เลย และเจ้าของกลุ่มจะต้อง rotate
   *   ทุกครั้งที่อยากส่งลิงก์ให้คนถัดไป ซึ่งจะฆ่าลิงก์ของคนก่อนหน้าที่ยังไม่ได้กด
   *
   * ★ อ่านอย่างเดียวเสมอ — ไม่มีลิงก์ก็โยน JOIN_LINK_NOT_FOUND ไม่สร้างให้ (B10)
   *   ห้ามเปลี่ยนเป็น "ไม่มีก็สร้างให้เลย" เด็ดขาด เพราะเมธอดนี้สมาชิกธรรมดาเรียกได้
   *   = จะกลายเป็นประตูหลังให้สมาชิกสร้างลิงก์ได้ ทั้งที่ B1 บอกว่าต้องเป็นเจ้าของเท่านั้น
   */
  async groupJoinLink(
    userId: string,
    groupId: string,
  ): Promise<FamilyGroupJoinLink> {
    const link = await this.prisma.$transaction(async (tx) => {
      // ตรวจซ้ำชั้นที่สอง (ชั้นแรกคือ @GroupRole('MEMBER') ที่ resolver)
      // ทำไมไม่ปล่อยให้ guard ทำคนเดียว: ค่าที่เมธอดนี้คืนคือ url ที่ใช้เข้ากลุ่มได้จริง
      // ถ้าวันหนึ่งมีคนเผลอถอด @GroupRole ออก หรือเรียกเมธอดนี้จากโค้ดอื่นที่ไม่ผ่าน guard
      // คนนอกกลุ่ม / คนที่ถูกเตะออกแล้ว ก็ยังได้ NOT_A_MEMBER อยู่ดี ไม่ใช่ได้ url ไป
      const role = await this.assertActiveMember(tx, groupId, userId);

      const active = await tx.familyGroupJoinLink.findFirst({
        where: { groupId, status: JOIN_LINK_STATUS.ACTIVE },
      });
      if (!active) {
        // B10 — code เดียวกันทั้งเจ้าของและสมาชิก (FE แยกกรณีด้วย code นี้)
        // ต่างกันแค่ข้อความ: เจ้าของ → "กดสร้างลิงก์ก่อน" · สมาชิก → "ขอให้เจ้าของกลุ่มสร้างลิงก์"
        throw new JoinLinkNotFoundError(role !== GROUP_ROLE.OWNER);
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
   * เข้าร่วมกลุ่มด้วยลิงก์ (PYG-417) — token ดิบจาก URL
   *
   * ★ used_count เพิ่มด้วย conditional UPDATE ใน SQL ไม่ใช่อ่านมาบวกแล้วเขียนกลับ
   *   สองคนที่กดพร้อมกันตอนเหลือโควตาใบสุดท้าย จะมีคนเดียวที่ UPDATE ติด
   */
  async joinGroupByLink(userId: string, token: string): Promise<FamilyGroup> {
    const tokenHash = this.hashJoinToken(token);

    const link = await this.prisma.familyGroupJoinLink.findUnique({
      where: { tokenHash },
      include: {
        group: {
          include: {
            members: {
              where: { status: MEMBER_STATUS.ACTIVE },
              select: { userId: true },
            },
          },
        },
      },
    });

    if (!link) {
      throw new JoinLinkInvalidError();
    }

    const activeMembers = link.group.members;
    const memberCount = activeMembers.length;

    // กดลิงก์ซ้ำทั้งที่อยู่ในกลุ่มแล้ว = no-op ไม่กิน used_count (idempotent)
    if (activeMembers.some((m) => m.userId === userId)) {
      return this.familyGroup(userId, link.groupId);
    }

    this.assertJoinLinkUsable(link, memberCount);

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.$queryRaw<{ id: string }[]>`
        UPDATE family_group_join_links
           SET used_count = used_count + 1
         WHERE token_hash = ${tokenHash}
           AND status = 'ACTIVE'
           AND expires_at > now()
           AND (max_uses IS NULL OR used_count < max_uses)
        RETURNING id;
      `;

      // UPDATE ไม่ติด = ลิงก์เปลี่ยนสถานะไประหว่างที่เราเช็คกับที่เรากด
      // อ่านแถวสดมาโยน error ที่ตรงเหตุผลจริง แทนที่จะบอกแค่ "ลิงก์ใช้ไม่ได้"
      if (claimed.length === 0) {
        const freshLink = await tx.familyGroupJoinLink.findUnique({
          where: { id: link.id },
        });
        if (!freshLink) throw new JoinLinkInvalidError();
        const freshCount = await tx.familyGroupMember.count({
          where: { groupId: link.groupId, status: MEMBER_STATUS.ACTIVE },
        });
        this.assertJoinLinkUsable(freshLink, freshCount);
        throw new JoinLinkInvalidError();
      }

      // upsert เพราะคนที่เคยออก/โดนเตะยังมีแถวเดิมค้างอยู่ (unique groupId+userId)
      // → กลับเข้ามาคือ UPDATE status กลับเป็น ACTIVE ไม่ใช่ INSERT แถวที่สอง
      await tx.familyGroupMember.upsert({
        where: { groupId_userId: { groupId: link.groupId, userId } },
        create: {
          groupId: link.groupId,
          userId,
          role: GROUP_ROLE.MEMBER,
          status: MEMBER_STATUS.ACTIVE,
          invitedBy: link.createdBy,
          joinedViaLinkId: link.id,
        },
        update: {
          status: MEMBER_STATUS.ACTIVE,
          role: GROUP_ROLE.MEMBER,
          invitedBy: link.createdBy,
          joinedViaLinkId: link.id,
          joinedAt: new Date(),
          removedAt: null,
        },
      });

      await this.writeActivity(tx, {
        groupId: link.groupId,
        actorId: userId,
        action: ACTIVITY_ACTION.MEMBER_JOINED,
        targetType: ACTIVITY_TARGET.MEMBER,
        targetId: userId,
        metadata: { joinedViaLinkId: link.id },
      });
    });

    return this.familyGroup(userId, link.groupId);
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

  /** แถวจากดีบี → type ที่ GraphQL ส่งออก (เฉพาะสมาชิก ACTIVE ของกลุ่ม — คนนอกห้ามเห็น) */
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
   * ยืนยันว่า userId เป็นสมาชิก ACTIVE ของกลุ่มนี้ (OWNER หรือ MEMBER ก็ได้) — ใช้ภายใน transaction
   *
   * คู่แฝดของ assertOwner ด้านบน ต่างกันแค่ "ไม่กรอง role"
   * ใช้กับการอ่านที่สมาชิกทุกคนมีสิทธิ์ แต่ผลลัพธ์อ่อนไหวพอที่ต้องตรวจซ้ำหลัง guard
   * (ตอนนี้มีที่เดียวคือ groupJoinLink — PYG-478)
   *
   * ★ กรอง status = ACTIVE เสมอ ตามกติกาข้อ 1 ของไฟล์นี้
   *   คนที่ LEFT/REMOVED ยังมีแถวค้างอยู่ ถ้าลืมกรอง คนที่ถูกเตะแล้วจะยังเอา url ไปได้
   *
   * @returns role ของผู้เรียกในกลุ่มนี้ — ให้ผู้เรียกเลือกข้อความตามบทบาทได้
   *          โดยไม่ต้องคิวรี่ตารางสมาชิกซ้ำอีกรอบ
   * @throws NotAMemberError — code เดียวกับที่ FamilyGroupGuard ตอบคนนอกกลุ่ม
   *         (คนนอกจึงแยกไม่ออกว่าโดนกันที่ชั้นไหน และเดาไม่ได้ว่ากลุ่มนี้มีลิงก์หรือเปล่า)
   */
  private async assertActiveMember(
    tx: Prisma.TransactionClient,
    groupId: string,
    userId: string,
  ): Promise<GroupRoleName> {
    const member = await tx.familyGroupMember.findFirst({
      where: {
        groupId,
        userId,
        status: MEMBER_STATUS.ACTIVE,
        // ★ ไม่มี role ในนี้โดยตั้งใจ — นี่คือจุดต่างเดียวจาก assertOwner
      },
      select: { role: true },
    });
    if (!member) {
      throw new NotAMemberError();
    }
    // role ในดีบีเป็น TEXT → แปลงเป็นชนิดที่แคบลง แบบเดียวกับที่ FamilyGroupGuard ทำ
    return member.role === GROUP_ROLE.OWNER
      ? GROUP_ROLE.OWNER
      : GROUP_ROLE.MEMBER;
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

  // ═══════════════════════════════════════════════════════════════════════
  //  PYG-421 · FG-3 — ฟีดกิจกรรมของกลุ่ม (keyset pagination)
  //
  //  ── ทำไมไม่ใช้ cursor ของ Prisma (skip/cursor) ───────────────────────
  //  cursor ของ Prisma รับได้เฉพาะฟิลด์ที่เป็น unique เดี่ยว ๆ หรือ compound
  //  unique ที่ประกาศไว้ในสคีมา แต่คู่ (createdAt, id) ของเราไม่ใช่ unique
  //  (มันเป็นแค่ index สำหรับเรียงลำดับ) → เขียนเงื่อนไขเอาเองใน where
  //  ซึ่งได้ผลเหมือนกันเป๊ะและตรงกับ index ที่มีอยู่แล้ว
  //
  //  ── เรื่องสิทธิ์ ──────────────────────────────────────────────────────
  //  "สมาชิก ACTIVE เท่านั้นที่อ่านได้" ถูกบังคับที่ @GroupRole('MEMBER') บน resolver
  //  → คนที่ถูกเตะออกหมดสิทธิ์อ่านฟีดทันทีในคำขอถัดไป ไม่ต้องรออะไรหมดอายุ
  //  ที่นี่จึงไม่เช็คซ้ำ ด้วยเหตุผลเดียวกับ familyGroup()/groupCareRecipients()
  //  (คิวรี่ซ้ำสิ่งที่ guard เพิ่งทำ = N+1 ที่ PYG-412 สั่งให้เลี่ยง)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * ฟีดกิจกรรมของกลุ่ม เรียงใหม่สุดก่อน แบ่งหน้าด้วย keyset
   *
   * @param groupId กลุ่มที่จะอ่าน (guard ตรวจสิทธิ์มาแล้ว)
   * @param first   จำนวนแถวที่ขอ — ไม่ส่ง = 20, เกิน 50 ถูกหั่นลงเหลือ 50
   * @param after   cursor ของแถวสุดท้ายที่ได้ไปแล้ว — ไม่ส่ง = เริ่มจากใหม่สุด
   */
  async familyGroupActivity(
    groupId: string,
    first?: number | null,
    after?: string | null,
  ): Promise<FamilyGroupActivityConnection> {
    const take = this.resolveActivityPageSize(first);
    const cursor = this.decodeActivityCursor(after);

    // ★ ขอเกินมา 1 แถวเสมอ เพื่อรู้ว่า "ยังมีต่อไหม" โดยไม่ต้อง COUNT(*)
    //   แถวที่ 21 ไม่ได้ถูกส่งออกไป มันมีหน้าที่เดียวคือเป็นพยานว่ายังมีของเก่ากว่านี้อยู่
    const rows = await this.prisma.familyGroupActivity.findMany({
      where: {
        groupId,
        // เงื่อนไข keyset: (created_at, id) < (cursor.createdAt, cursor.id)
        // เขียนแตกเป็น OR เพราะ Prisma ไม่รองรับการเทียบ tuple แบบ SQL ตรง ๆ
        //   แถวที่เก่ากว่าชัด ๆ                     → createdAt < cursor.createdAt
        //   แถวที่เวลาเท่ากันเป๊ะ (transaction เดียวกัน) → ตัดสินด้วย id ต่อ
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      select: ACTIVITY_SELECT,
      // ★ ต้องเรียงสองชั้นให้ตรงกับเงื่อนไข where ด้านบนและตรงกับ index เป๊ะ ๆ
      //   ถ้าเรียงแค่ createdAt ลำดับของแถวที่เวลาเท่ากันจะไม่คงที่ระหว่างคำขอ
      //   → หน้า 2 อาจส่งแถวที่หน้า 1 เคยส่งไปแล้วซ้ำอีก (TC-BS-07 "stable across pages")
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });

    const hasNextPage = rows.length > take;
    const nodes = (hasNextPage ? rows.slice(0, take) : rows).map((row) =>
      this.toActivityItem(row),
    );

    return {
      nodes,
      pageInfo: {
        // แถวสุดท้ายของหน้านี้คือจุดเริ่มของหน้าถัดไป
        endCursor:
          nodes.length > 0 ? nodes[nodes.length - 1].cursor : undefined,
        hasNextPage,
      },
    };
  }

  /**
   * ตีความค่า first ที่ client ส่งมาให้เป็นจำนวนแถวที่ยอมให้ขอได้จริง
   *
   * ★ ค่าที่ไม่สมเหตุสมผล (0, ติดลบ, ทศนิยม, NaN) ถูกปัดกลับเป็นค่าเริ่มต้น
   *   ไม่ใช่โยน error — ที่นี่ไม่มีเจตนาร้ายให้ป้องกัน มีแต่ client ที่ส่งค่าเพี้ยน
   *   แล้วหน้าฟีดพังทั้งหน้าโดยไม่จำเป็น (ต่างจาก cursor ที่ผิดแปลว่าตำแหน่งผิด
   *   ซึ่งถ้าเงียบไว้จะกลายเป็นฟีดที่วนซ้ำไม่รู้จบ จึงต้องล้มดัง)
   */
  private resolveActivityPageSize(first?: number | null): number {
    if (first === undefined || first === null || !Number.isInteger(first)) {
      return ACTIVITY_PAGE_SIZE_DEFAULT;
    }
    if (first <= 0) return ACTIVITY_PAGE_SIZE_DEFAULT;
    return Math.min(first, ACTIVITY_PAGE_SIZE_MAX);
  }

  /**
   * cursor → คู่ (createdAt, id)
   *
   * รูปแบบ: base64url( "<ISO-8601 ของ createdAt>|<uuid ของ id>" )
   *
   * ★ ทำไมต้อง encode ทั้งที่ข้างในไม่ใช่ความลับ?
   *   ไม่ได้ทำเพื่อความลับ แต่เพื่อ "ให้มันดูทึบพอที่ FE จะไม่เอาไป parse เอง"
   *   วันที่เราเปลี่ยนวิธีแบ่งหน้า cursor ที่ FE เคยแกะไว้จะพังทันที
   *   ค่าทึบทำให้สัญญาระหว่างสองฝั่งมีแค่ "ส่งค่าที่ได้มากลับมาเฉย ๆ" ข้อเดียว
   */
  private decodeActivityCursor(
    after?: string | null,
  ): { createdAt: Date; id: string } | null {
    if (after === undefined || after === null || after.trim() === '') {
      return null;
    }

    // ★ Buffer.from() ไม่เคยโยน error กับ input ที่ไม่ใช่ base64 — มันเดาไปเรื่อย
    //   แล้วคืนขยะออกมา จึงต้องตรวจ "รูปทรงของผลลัพธ์" ทุกชั้นเอง
    //   ไม่ใช่แค่ห่อ try/catch แล้วคิดว่าปลอดภัย
    const decoded = Buffer.from(after, 'base64url').toString('utf8');
    const parts = decoded.split(ACTIVITY_CURSOR_SEPARATOR);
    if (parts.length !== 2) {
      throw new ActivityCursorInvalidError();
    }

    const [rawCreatedAt, id] = parts;
    const createdAt = new Date(rawCreatedAt);
    // Invalid Date เทียบกับตัวเองแล้วได้ NaN → getTime() เป็น NaN
    if (Number.isNaN(createdAt.getTime()) || id.length === 0) {
      throw new ActivityCursorInvalidError();
    }

    return { createdAt, id };
  }

  /** คู่ (createdAt, id) → cursor */
  private encodeActivityCursor(createdAt: Date, id: string): string {
    return Buffer.from(
      `${createdAt.toISOString()}${ACTIVITY_CURSOR_SEPARATOR}${id}`,
      'utf8',
    ).toString('base64url');
  }

  /** แปลงแถวกิจกรรม 1 แถวเป็น type ที่ GraphQL ส่งออก */
  private toActivityItem(row: ActivityRow): FamilyGroupActivityItem {
    return {
      id: row.id,
      // actorId ยังอยู่แต่ actor เป็น null = บัญชีถูกลบไปแล้ว (FK ตั้ง ON DELETE SET NULL)
      // ทั้งก้อนเป็น undefined เพื่อให้ FE แสดง "ผู้ใช้ที่ถูกลบ" ได้ด้วยเงื่อนไขเดียว
      actor:
        row.actorId && row.actor
          ? {
              userId: row.actorId,
              displayName: row.actor.displayName ?? undefined,
              avatarUrl: row.actor.avatarUrl ?? undefined,
            }
          : undefined,
      action: row.action,
      targetType: row.targetType ?? undefined,
      targetId: row.targetId ?? undefined,
      // คอลัมน์เป็น JSONB NOT NULL DEFAULT '{}' → ไม่มีทางเป็น null จากดีบี
      // ที่ ?? '{}' ไว้เพราะชนิดฝั่ง Prisma ยังเป็น JsonValue ที่รวม null ได้
      metadata: JSON.stringify(row.metadata ?? {}),
      createdAt: row.createdAt,
      cursor: this.encodeActivityCursor(row.createdAt, row.id),
    };
  }
}
