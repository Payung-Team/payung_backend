/**
 * Unit tests สำหรับ FamilyGroupService (PYG-412)
 *
 * ครอบคลุม acceptance criteria ของ PYG-407 ทีละข้อ:
 *   A1 สร้างกลุ่ม → ผู้สร้างเป็น OWNER ที่ ACTIVE
 *   A2 เจ้าของเปลี่ยนชื่อ / ลบกลุ่มได้
 *   A3 เจ้าของนำสมาชิกออกได้
 *   A4 สมาชิกออกเองได้ · เจ้าของคนสุดท้ายออกไม่ได้ (LAST_OWNER)
 *   A5 ทุก mutation เขียน family_group_activity ใน transaction เดียวกัน
 *   edge cases: ชื่อว่าง / ยาวเกิน 80 · เตะตัวเอง → LAST_OWNER
 *
 * mock PrismaService ทั้งหมด → ไม่แตะดีบีจริง
 * (ตารางจริงยังไม่ถูก deploy ด้วยซ้ำ — รอ Sam รัน prisma migrate deploy ของ PYG-411)
 */
import { Test, TestingModule } from '@nestjs/testing';
import { FamilyGroupService } from './family-group.service';
import { PrismaService } from '../common/prisma.service';
import {
  ACTIVITY_ACTION,
  GROUP_ROLE,
  MEMBER_STATUS,
} from './family-group.constants';
import { FG_ERROR } from './family-group.errors';

const GROUP_ID = '11111111-1111-1111-1111-111111111111';
const OWNER_ID = 'u-owner';
const MEMBER_ID = 'u-member';

/**
 * ดึง argument ตัวแรกของการเรียก prisma ออกมาแบบมี type
 *
 * ทำไมไม่ใช้ expect.objectContaining ซ้อนกัน: ตัวมันคืน any → eslint
 * (no-unsafe-assignment) ร้อง และอ่านยากกว่า — แพตเทิร์นเดียวกับ monitoring.service.spec.ts
 * ใช้คู่กับ toMatchObject ซึ่งเทียบแบบ "มีอย่างน้อยตามนี้" ลงลึกทุกชั้นให้อยู่แล้ว
 */
function callArg(mock: jest.Mock, index = 0): Record<string, unknown> {
  const call = mock.mock.calls[index] as [Record<string, unknown>];
  return call[0];
}

/** แถวสมาชิกรูปทรงที่ MEMBER_SELECT คืนกลับ */
const memberRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'fgm-owner',
  userId: OWNER_ID,
  role: GROUP_ROLE.OWNER,
  joinedAt: new Date('2026-08-01T00:00:00Z'),
  user: {
    displayName: 'สมชาย ใจดี',
    email: 'owner@payung.app',
    avatarUrl: null,
  },
  ...overrides,
});

/** แถวกลุ่มรูปทรงที่ GROUP_SELECT คืนกลับ */
const groupRow = (overrides: Record<string, unknown> = {}) => ({
  id: GROUP_ID,
  name: 'บ้านยาย',
  createdBy: OWNER_ID,
  createdAt: new Date('2026-08-01T00:00:00Z'),
  updatedAt: new Date('2026-08-01T00:00:00Z'),
  members: [memberRow()],
  ...overrides,
});

describe('FamilyGroupService', () => {
  let service: FamilyGroupService;

  // tx และ prisma ใช้ object ลูกชุดเดียวกัน → mock ที่เดียวได้ทั้งใน/นอก transaction
  let tx: {
    familyGroup: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    familyGroupMember: {
      updateMany: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
    };
    familyGroupActivity: { create: jest.Mock };
  };
  let prisma: typeof tx & { $transaction: jest.Mock };

  beforeEach(async () => {
    tx = {
      familyGroup: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      familyGroupMember: {
        updateMany: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
      },
      familyGroupActivity: { create: jest.fn() },
    };
    prisma = {
      ...tx,
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        FamilyGroupService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = moduleRef.get(FamilyGroupService);
  });

  /** ผู้เรียกเป็น OWNER ที่ ACTIVE (ให้ assertOwner ผ่าน) */
  const givenCallerIsOwner = () =>
    tx.familyGroupMember.findFirst.mockResolvedValue({ id: 'fgm-owner' });

  /** ผู้เรียกไม่ใช่ OWNER (assertOwner ต้องปฏิเสธ) */
  const givenCallerIsNotOwner = () =>
    tx.familyGroupMember.findFirst.mockResolvedValue(null);

  // ═══ A1 · createFamilyGroup ═══════════════════════════════════════════
  describe('createFamilyGroup', () => {
    it('สร้างกลุ่ม + แถวสมาชิก OWNER/ACTIVE + กิจกรรม GROUP_CREATED ใน transaction เดียว', async () => {
      tx.familyGroup.create.mockResolvedValue(groupRow());

      const result = await service.createFamilyGroup(OWNER_ID, {
        name: 'บ้านยาย',
      });

      // ทุกอย่างอยู่ใน $transaction เดียว (AC A5)
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);

      // แถวสมาชิกถูกสร้างพร้อมกลุ่มในคำสั่งเดียว
      expect(callArg(tx.familyGroup.create)).toMatchObject({
        data: {
          name: 'บ้านยาย',
          createdBy: OWNER_ID,
          members: {
            create: {
              userId: OWNER_ID,
              role: GROUP_ROLE.OWNER,
              status: MEMBER_STATUS.ACTIVE,
            },
          },
        },
      });

      expect(callArg(tx.familyGroupActivity.create)).toMatchObject({
        data: {
          groupId: GROUP_ID,
          actorId: OWNER_ID,
          action: ACTIVITY_ACTION.GROUP_CREATED,
        },
      });

      expect(result.myRole).toBe(GROUP_ROLE.OWNER);
      expect(result.memberCount).toBe(1);
      expect(result.members[0].isMe).toBe(true);
    });

    it('ตัดช่องว่างหัวท้ายก่อนบันทึก', async () => {
      tx.familyGroup.create.mockResolvedValue(groupRow());

      await service.createFamilyGroup(OWNER_ID, { name: '  บ้านยาย  ' });

      expect(callArg(tx.familyGroup.create)).toMatchObject({
        data: { name: 'บ้านยาย' },
      });
    });

    // edge case ของ AC: "rename empty or >80 chars → validation"
    it.each([
      ['ว่างเปล่า', ''],
      ['มีแต่ช่องว่าง', '     '],
      ['ยาว 81 ตัวอักษร', 'x'.repeat(81)],
    ])('ปฏิเสธชื่อ%s ด้วย GROUP_NAME_INVALID', async (_label, name) => {
      await expect(
        service.createFamilyGroup(OWNER_ID, { name }),
      ).rejects.toMatchObject({
        extensions: { code: FG_ERROR.GROUP_NAME_INVALID },
      });
      // ต้องตกก่อนเปิด transaction — ไม่เสีย connection ไปเปล่า ๆ
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('ยอมรับชื่อยาว 80 ตัวอักษรพอดี (ขอบบนต้องผ่าน)', async () => {
      tx.familyGroup.create.mockResolvedValue(groupRow());
      await expect(
        service.createFamilyGroup(OWNER_ID, { name: 'x'.repeat(80) }),
      ).resolves.toBeDefined();
    });
  });

  // ═══ A2 · renameFamilyGroup ═══════════════════════════════════════════
  describe('renameFamilyGroup', () => {
    it('เปลี่ยนชื่อ + เขียนกิจกรรม GROUP_RENAMED พร้อมชื่อเก่า/ใหม่', async () => {
      tx.familyGroup.findUnique.mockResolvedValue({
        id: GROUP_ID,
        name: 'บ้านยาย',
      });
      givenCallerIsOwner();
      tx.familyGroup.update.mockResolvedValue(groupRow({ name: 'บ้านย่า' }));

      const result = await service.renameFamilyGroup(OWNER_ID, {
        groupId: GROUP_ID,
        name: 'บ้านย่า',
      });

      expect(result.name).toBe('บ้านย่า');
      expect(callArg(tx.familyGroupActivity.create)).toMatchObject({
        data: {
          action: ACTIVITY_ACTION.GROUP_RENAMED,
          metadata: { oldName: 'บ้านยาย', newName: 'บ้านย่า' },
        },
      });
    });

    it('กลุ่มถูกลบไปแล้วระหว่างทาง → GROUP_NOT_FOUND', async () => {
      tx.familyGroup.findUnique.mockResolvedValue(null);

      await expect(
        service.renameFamilyGroup(OWNER_ID, {
          groupId: GROUP_ID,
          name: 'บ้านย่า',
        }),
      ).rejects.toMatchObject({
        extensions: { code: FG_ERROR.GROUP_NOT_FOUND },
      });
    });

    // "owner-only mutations double-checked server-side" — ต่อให้ guard พลาด service ต้องกัน
    it('ผู้เรียกไม่ใช่เจ้าของ (แล้ว) → NOT_GROUP_OWNER และไม่แตะข้อมูล', async () => {
      tx.familyGroup.findUnique.mockResolvedValue({
        id: GROUP_ID,
        name: 'บ้านยาย',
      });
      givenCallerIsNotOwner();

      await expect(
        service.renameFamilyGroup(MEMBER_ID, {
          groupId: GROUP_ID,
          name: 'บ้านย่า',
        }),
      ).rejects.toMatchObject({
        extensions: { code: FG_ERROR.NOT_GROUP_OWNER },
      });
      expect(tx.familyGroup.update).not.toHaveBeenCalled();
      expect(tx.familyGroupActivity.create).not.toHaveBeenCalled();
    });
  });

  // ═══ A2 · deleteFamilyGroup ═══════════════════════════════════════════
  describe('deleteFamilyGroup', () => {
    it('เจ้าของลบกลุ่มได้ และคืน id กลับไปให้ FE ล้าง cache', async () => {
      givenCallerIsOwner();
      tx.familyGroup.delete.mockResolvedValue({ id: GROUP_ID });

      const result = await service.deleteFamilyGroup(OWNER_ID, GROUP_ID);

      expect(result).toEqual({ id: GROUP_ID, deleted: true });
      expect(tx.familyGroup.delete).toHaveBeenCalledWith({
        where: { id: GROUP_ID },
      });
    });

    // ตั้งใจไม่เขียน — แถว activity จะถูก CASCADE ลบตามกลุ่มในคำสั่งเดียวกันอยู่ดี
    it('ไม่เขียนกิจกรรมตอนลบ (เพราะจะถูก CASCADE ลบตามทันที)', async () => {
      givenCallerIsOwner();
      tx.familyGroup.delete.mockResolvedValue({ id: GROUP_ID });

      await service.deleteFamilyGroup(OWNER_ID, GROUP_ID);

      expect(tx.familyGroupActivity.create).not.toHaveBeenCalled();
    });

    it('ไม่ใช่เจ้าของ → NOT_GROUP_OWNER และไม่มีการลบเกิดขึ้น', async () => {
      givenCallerIsNotOwner();

      await expect(
        service.deleteFamilyGroup(MEMBER_ID, GROUP_ID),
      ).rejects.toMatchObject({
        extensions: { code: FG_ERROR.NOT_GROUP_OWNER },
      });
      expect(tx.familyGroup.delete).not.toHaveBeenCalled();
    });
  });

  // ═══ A4 · leaveFamilyGroup ════════════════════════════════════════════
  describe('leaveFamilyGroup', () => {
    it('สมาชิกออกเองได้ → status LEFT + กิจกรรม MEMBER_LEFT + คืนข้อมูลกลุ่มที่ออกมา', async () => {
      tx.familyGroup.findUnique.mockResolvedValue({
        id: GROUP_ID,
        name: 'บ้านยาย',
      });
      tx.familyGroupMember.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.leaveFamilyGroup(MEMBER_ID, GROUP_ID);

      expect(result).toEqual({
        groupId: GROUP_ID,
        groupName: 'บ้านยาย',
        left: true,
      });
      // where ต้องมีทั้ง status ACTIVE และ role MEMBER — นี่คือกันแข่งกับ transferOwnership
      expect(callArg(tx.familyGroupMember.updateMany)).toMatchObject({
        where: {
          groupId: GROUP_ID,
          userId: MEMBER_ID,
          status: MEMBER_STATUS.ACTIVE,
          role: GROUP_ROLE.MEMBER,
        },
        data: { status: MEMBER_STATUS.LEFT },
      });
      expect(callArg(tx.familyGroupActivity.create)).toMatchObject({
        data: { action: ACTIVITY_ACTION.MEMBER_LEFT },
      });
    });

    // edge case หลักของ AC A4
    it('เจ้าของออกเองไม่ได้ → LAST_OWNER', async () => {
      tx.familyGroup.findUnique.mockResolvedValue({
        id: GROUP_ID,
        name: 'บ้านยาย',
      });
      tx.familyGroupMember.updateMany.mockResolvedValue({ count: 0 });
      // อ่านแถวจริงมาดูสาเหตุ: ยัง ACTIVE แต่เป็น OWNER
      tx.familyGroupMember.findUnique.mockResolvedValue({
        role: GROUP_ROLE.OWNER,
        status: MEMBER_STATUS.ACTIVE,
      });

      await expect(
        service.leaveFamilyGroup(OWNER_ID, GROUP_ID),
      ).rejects.toMatchObject({ extensions: { code: FG_ERROR.LAST_OWNER } });
      expect(tx.familyGroupActivity.create).not.toHaveBeenCalled();
    });

    it('คนที่ออกไปแล้วกดออกซ้ำ → MEMBER_NOT_FOUND', async () => {
      tx.familyGroup.findUnique.mockResolvedValue({
        id: GROUP_ID,
        name: 'บ้านยาย',
      });
      tx.familyGroupMember.updateMany.mockResolvedValue({ count: 0 });
      tx.familyGroupMember.findUnique.mockResolvedValue({
        role: GROUP_ROLE.MEMBER,
        status: MEMBER_STATUS.LEFT,
      });

      await expect(
        service.leaveFamilyGroup(MEMBER_ID, GROUP_ID),
      ).rejects.toMatchObject({
        extensions: { code: FG_ERROR.MEMBER_NOT_FOUND },
      });
    });

    it('กลุ่มถูกลบไปแล้ว → GROUP_NOT_FOUND', async () => {
      tx.familyGroup.findUnique.mockResolvedValue(null);

      await expect(
        service.leaveFamilyGroup(MEMBER_ID, GROUP_ID),
      ).rejects.toMatchObject({
        extensions: { code: FG_ERROR.GROUP_NOT_FOUND },
      });
    });
  });

  // ═══ A3 · removeMember ════════════════════════════════════════════════
  describe('removeMember', () => {
    it('เจ้าของนำสมาชิกออกได้ → status REMOVED + กิจกรรม MEMBER_REMOVED', async () => {
      givenCallerIsOwner();
      tx.familyGroupMember.updateMany.mockResolvedValue({ count: 1 });
      tx.familyGroup.findUniqueOrThrow.mockResolvedValue(groupRow());

      await service.removeMember(OWNER_ID, {
        groupId: GROUP_ID,
        userId: MEMBER_ID,
      });

      expect(callArg(tx.familyGroupMember.updateMany)).toMatchObject({
        where: {
          groupId: GROUP_ID,
          userId: MEMBER_ID,
          status: MEMBER_STATUS.ACTIVE,
          role: GROUP_ROLE.MEMBER,
        },
        data: { status: MEMBER_STATUS.REMOVED },
      });
      expect(callArg(tx.familyGroupActivity.create)).toMatchObject({
        data: {
          action: ACTIVITY_ACTION.MEMBER_REMOVED,
          targetId: MEMBER_ID,
        },
      });
    });

    // edge case ของ AC: "remove self as sole owner → LAST_OWNER"
    it('เจ้าของเตะตัวเอง → LAST_OWNER (ไม่ใช่ MEMBER_NOT_FOUND)', async () => {
      givenCallerIsOwner();

      await expect(
        service.removeMember(OWNER_ID, {
          groupId: GROUP_ID,
          userId: OWNER_ID,
        }),
      ).rejects.toMatchObject({ extensions: { code: FG_ERROR.LAST_OWNER } });
      expect(tx.familyGroupMember.updateMany).not.toHaveBeenCalled();
    });

    it('เป้าหมายไม่ได้อยู่ในกลุ่ม → MEMBER_NOT_FOUND', async () => {
      givenCallerIsOwner();
      tx.familyGroupMember.updateMany.mockResolvedValue({ count: 0 });
      tx.familyGroupMember.findUnique.mockResolvedValue(null);

      await expect(
        service.removeMember(OWNER_ID, {
          groupId: GROUP_ID,
          userId: 'u-stranger',
        }),
      ).rejects.toMatchObject({
        extensions: { code: FG_ERROR.MEMBER_NOT_FOUND },
      });
    });

    it('ผู้เรียกไม่ใช่เจ้าของ → NOT_GROUP_OWNER', async () => {
      givenCallerIsNotOwner();

      await expect(
        service.removeMember(MEMBER_ID, {
          groupId: GROUP_ID,
          userId: 'u-other',
        }),
      ).rejects.toMatchObject({
        extensions: { code: FG_ERROR.NOT_GROUP_OWNER },
      });
    });
  });

  // ═══ A4 · transferOwnership ═══════════════════════════════════════════
  describe('transferOwnership', () => {
    it('★ ลดเจ้าของเดิมก่อน แล้วค่อยเลื่อนคนใหม่ (สลับลำดับ = ชน partial unique index)', async () => {
      const callOrder: string[] = [];
      tx.familyGroupMember.updateMany.mockImplementation(
        (args: { data: { role: string } }) => {
          callOrder.push(args.data.role);
          return Promise.resolve({ count: 1 });
        },
      );
      tx.familyGroup.findUniqueOrThrow.mockResolvedValue(groupRow());

      await service.transferOwnership(OWNER_ID, {
        groupId: GROUP_ID,
        newOwnerUserId: MEMBER_ID,
      });

      // ลดลงเป็น MEMBER ต้องมาก่อน เลื่อนขึ้นเป็น OWNER เสมอ
      expect(callOrder).toEqual([GROUP_ROLE.MEMBER, GROUP_ROLE.OWNER]);
    });

    it('เขียนกิจกรรม OWNERSHIP_TRANSFERRED พร้อมบอกว่าโอนจากใครไปใคร', async () => {
      tx.familyGroupMember.updateMany.mockResolvedValue({ count: 1 });
      tx.familyGroup.findUniqueOrThrow.mockResolvedValue(groupRow());

      await service.transferOwnership(OWNER_ID, {
        groupId: GROUP_ID,
        newOwnerUserId: MEMBER_ID,
      });

      expect(callArg(tx.familyGroupActivity.create)).toMatchObject({
        data: {
          action: ACTIVITY_ACTION.OWNERSHIP_TRANSFERRED,
          metadata: { fromUserId: OWNER_ID, toUserId: MEMBER_ID },
        },
      });
    });

    it('โอนให้ตัวเอง → ALREADY_OWNER (ไม่เปิด transaction เลย)', async () => {
      await expect(
        service.transferOwnership(OWNER_ID, {
          groupId: GROUP_ID,
          newOwnerUserId: OWNER_ID,
        }),
      ).rejects.toMatchObject({ extensions: { code: FG_ERROR.ALREADY_OWNER } });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('ผู้เรียกไม่ใช่เจ้าของแล้ว (โดนตัดหน้า) → NOT_GROUP_OWNER', async () => {
      tx.familyGroupMember.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.transferOwnership(OWNER_ID, {
          groupId: GROUP_ID,
          newOwnerUserId: MEMBER_ID,
        }),
      ).rejects.toMatchObject({
        extensions: { code: FG_ERROR.NOT_GROUP_OWNER },
      });
    });

    it('เป้าหมายไม่ใช่สมาชิก ACTIVE → MEMBER_NOT_FOUND (rollback การลดสิทธิ์ไปด้วย)', async () => {
      tx.familyGroupMember.updateMany
        .mockResolvedValueOnce({ count: 1 }) // ลดเจ้าของเดิมสำเร็จ
        .mockResolvedValueOnce({ count: 0 }); // แต่เลื่อนคนใหม่ไม่สำเร็จ

      await expect(
        service.transferOwnership(OWNER_ID, {
          groupId: GROUP_ID,
          newOwnerUserId: 'u-stranger',
        }),
      ).rejects.toMatchObject({
        extensions: { code: FG_ERROR.MEMBER_NOT_FOUND },
      });
      // throw ออกจาก callback ของ $transaction = Prisma rollback ให้เอง
      // → กลุ่มไม่มีทางค้างอยู่ในสภาพ "ไม่มีเจ้าของ"
      expect(tx.familyGroupActivity.create).not.toHaveBeenCalled();
    });
  });

  // ═══ Queries ══════════════════════════════════════════════════════════
  describe('myFamilyGroups', () => {
    it('คืนเฉพาะกลุ่มที่เป็นสมาชิก ACTIVE และเรียงใหม่สุดก่อน', async () => {
      tx.familyGroup.findMany.mockResolvedValue([groupRow()]);

      const result = await service.myFamilyGroups(OWNER_ID);

      expect(callArg(tx.familyGroup.findMany)).toMatchObject({
        where: {
          members: {
            some: { userId: OWNER_ID, status: MEMBER_STATUS.ACTIVE },
          },
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(result).toHaveLength(1);
      expect(result[0].myRole).toBe(GROUP_ROLE.OWNER);
    });

    it('ไม่มีกลุ่มเลย → array ว่าง ไม่ใช่ error', async () => {
      tx.familyGroup.findMany.mockResolvedValue([]);
      await expect(service.myFamilyGroups(OWNER_ID)).resolves.toEqual([]);
    });
  });

  describe('familyGroup', () => {
    it('เจ้าของขึ้นก่อนเสมอในรายชื่อสมาชิก และ isMe ตรงกับผู้เรียก', async () => {
      tx.familyGroup.findUnique.mockResolvedValue(
        groupRow({
          // จงใจใส่สมาชิกธรรมดามาก่อนในผลลัพธ์จากดีบี
          members: [
            memberRow({
              id: 'fgm-member',
              userId: MEMBER_ID,
              role: GROUP_ROLE.MEMBER,
              joinedAt: new Date('2026-08-05T00:00:00Z'),
              user: {
                displayName: 'สมหญิง',
                email: 'member@payung.app',
                avatarUrl: null,
              },
            }),
            memberRow(),
          ],
        }),
      );

      const result = await service.familyGroup(MEMBER_ID, GROUP_ID);

      expect(result.members[0].role).toBe(GROUP_ROLE.OWNER);
      expect(result.members.find((m) => m.isMe)?.userId).toBe(MEMBER_ID);
      expect(result.myRole).toBe(GROUP_ROLE.MEMBER);
      expect(result.memberCount).toBe(2);
    });

    it('กลุ่มถูกลบไปแล้ว → GROUP_NOT_FOUND', async () => {
      tx.familyGroup.findUnique.mockResolvedValue(null);
      await expect(
        service.familyGroup(OWNER_ID, GROUP_ID),
      ).rejects.toMatchObject({
        extensions: { code: FG_ERROR.GROUP_NOT_FOUND },
      });
    });
  });
});
