/**
 * PYG-540 — กลุ่มครอบครัวต้องไม่เห็นข้อมูลของคนที่ถอนความยินยอม "เปิดเผยให้กลุ่มครอบครัว"
 *
 *   ① groupCareRecipients — ไม่แสดงโปรไฟล์ของคนที่ถอน (ยกเว้นเจ้าของดูเอง)
 *   ② familyGroupActivity — แถว "จองแทน" ของคนที่ถอนถูกปิดรายละเอียด (ไม่ตัดแถวทิ้ง
 *      เพื่อไม่ให้ keyset pagination เพี้ยน) ยกเว้นเจ้าของเองและคนกดจอง
 *
 * ★ ยังไม่เคยตอบ = ไม่ได้ถอน → เห็นเหมือนเดิม (ตรรกะนั้นอยู่ใน ConsentService.withdrawnUserIds
 *   ซึ่งมีเทสของตัวเอง — ที่นี่ mock ผลลัพธ์ของมันตรง ๆ)
 */
import { FamilyGroupService } from './family-group.service';
import type { PrismaService } from '../common/prisma.service';
import type { ConsentService } from '../consent/consent.service';
import { CONSENT_TYPE } from '../consent/consent.constants';
import { ACTIVITY_ACTION, ACTIVITY_TARGET } from './family-group.constants';

const GROUP_ID = '11111111-1111-4111-8111-111111111111';
const WITHDRAWN_OWNER = 'user-withdrawn-1'; // เจ้าของข้อมูลที่ถอนข้อ family group
const OTHER_OWNER = 'user-other-2';
const BOOKER = 'user-booker-3'; // คนกดจองแทน
const VIEWER = 'user-viewer-4'; // สมาชิกทั่วไปที่ไม่เกี่ยวกับนัดนี้

/** prisma ปลอม — มีเฉพาะตารางที่การกรองแตะ */
type PrismaMock = {
  familyGroupMember: { findMany: jest.Mock };
  careRecipient: { findMany: jest.Mock };
  familyGroupActivity: { findMany: jest.Mock };
  booking: { findMany: jest.Mock };
};

describe('FamilyGroupService — กรองตามความยินยอม (PYG-540)', () => {
  let prisma: PrismaMock;
  let consent: { withdrawnUserIds: jest.Mock };
  let service: FamilyGroupService;

  beforeEach(() => {
    prisma = {
      familyGroupMember: { findMany: jest.fn() },
      careRecipient: { findMany: jest.fn() },
      familyGroupActivity: { findMany: jest.fn() },
      booking: { findMany: jest.fn() },
    };
    consent = {
      withdrawnUserIds: jest.fn().mockResolvedValue(new Set([WITHDRAWN_OWNER])),
    };
    service = new FamilyGroupService(
      prisma as unknown as PrismaService,
      consent as unknown as ConsentService,
    );
  });

  // ── ① โปรไฟล์ผู้รับบริการในกลุ่ม ──────────────────────────────────────────

  describe('groupCareRecipients', () => {
    beforeEach(() => {
      prisma.familyGroupMember.findMany.mockResolvedValue([
        { userId: WITHDRAWN_OWNER },
        { userId: OTHER_OWNER },
      ]);
      prisma.careRecipient.findMany.mockResolvedValue([
        {
          id: 'cr-1',
          name: 'ก',
          nickname: null,
          patientId: WITHDRAWN_OWNER,
          self_reported: true,
        },
        {
          id: 'cr-2',
          name: 'ข',
          nickname: null,
          patientId: OTHER_OWNER,
          self_reported: true,
        },
      ]);
    });

    it('อ่านความยินยอมของเจ้าของทุกโปรไฟล์ใน query เดียว', async () => {
      await service.groupCareRecipients(GROUP_ID, VIEWER);

      expect(consent.withdrawnUserIds).toHaveBeenCalledTimes(1);
      expect(consent.withdrawnUserIds).toHaveBeenCalledWith(
        [WITHDRAWN_OWNER, OTHER_OWNER],
        CONSENT_TYPE.DISCLOSE_TO_FAMILY_GROUP,
      );
    });

    it('★ สมาชิกคนอื่นไม่เห็นโปรไฟล์ของคนที่ถอน', async () => {
      const result = await service.groupCareRecipients(GROUP_ID, VIEWER);
      expect(result.map((r) => r.id)).toEqual(['cr-2']);
    });

    it('เจ้าของที่ถอนยังเห็นโปรไฟล์ของตัวเอง', async () => {
      const result = await service.groupCareRecipients(
        GROUP_ID,
        WITHDRAWN_OWNER,
      );
      expect(result.map((r) => r.id)).toEqual(['cr-1', 'cr-2']);
    });
  });

  // ── ①.5 รายชื่อ "จองให้ใครได้บ้าง" (PYG-517) ───────────────────────────────

  describe('groupBookingRecipients', () => {
    beforeEach(() => {
      prisma.familyGroupMember.findMany.mockResolvedValue([
        {
          userId: WITHDRAWN_OWNER,
          user: { firstName: 'ก', lastName: 'ถอน', displayName: null },
        },
        {
          userId: OTHER_OWNER,
          user: { firstName: 'ข', lastName: 'ปกติ', displayName: null },
        },
      ]);
      prisma.careRecipient.findMany.mockResolvedValue([]);
    });

    it('★ คนที่ถอนข้อ family group ไม่อยู่ในรายการของสมาชิกคนอื่น', async () => {
      const result = await service.groupBookingRecipients(GROUP_ID, VIEWER);

      expect(result.map((r) => r.memberUserId)).toEqual([OTHER_OWNER]);
      expect(consent.withdrawnUserIds).toHaveBeenCalledWith(
        [WITHDRAWN_OWNER, OTHER_OWNER],
        CONSENT_TYPE.DISCLOSE_TO_FAMILY_GROUP,
      );
      // ★ ไม่ไปอ่านโปรไฟล์สุขภาพของคนที่ถอนเลย
      const [findArgs] = prisma.careRecipient.findMany.mock.calls[0] as [
        { where: { patientId: unknown } },
      ];
      expect(findArgs.where.patientId).toEqual({ in: [OTHER_OWNER] });
    });

    it('คนที่ถอนยังเห็นชื่อตัวเองในรายการ', async () => {
      const result = await service.groupBookingRecipients(
        GROUP_ID,
        WITHDRAWN_OWNER,
      );
      expect(result.map((r) => r.memberUserId)).toEqual([
        WITHDRAWN_OWNER,
        OTHER_OWNER,
      ]);
    });
  });

  // ── ② ฟีดกิจกรรม ──────────────────────────────────────────────────────────

  describe('familyGroupActivity', () => {
    /** แถวฟีดขั้นต่ำ — createdAt ต่างกันเพื่อให้ลำดับชัด */
    function activity(
      id: string,
      action: string,
      targetId: string | null,
      metadata: Record<string, unknown>,
      minute: number,
    ) {
      return {
        id,
        actorId: BOOKER,
        action,
        targetType: targetId ? ACTIVITY_TARGET.BOOKING : ACTIVITY_TARGET.GROUP,
        targetId,
        metadata,
        createdAt: new Date(
          `2026-09-22T10:${String(minute).padStart(2, '0')}:00Z`,
        ),
        actor: { displayName: 'คนจอง', avatarUrl: null },
      };
    }

    const HIDDEN_META = {
      recipientName: 'คุณยายสมศรี',
      bookingDate: '2026-10-01',
      startTime: '09:00',
    };

    beforeEach(() => {
      prisma.familyGroupActivity.findMany.mockResolvedValue([
        activity(
          'a-1',
          ACTIVITY_ACTION.BOOKING_ON_BEHALF,
          'bk-withdrawn',
          HIDDEN_META,
          30,
        ),
        activity(
          'a-2',
          ACTIVITY_ACTION.BOOKING_ON_BEHALF,
          'bk-other',
          { recipientName: 'คุณตา' },
          20,
        ),
        activity(
          'a-3',
          ACTIVITY_ACTION.GROUP_RENAMED,
          null,
          { oldName: 'ก', newName: 'ข' },
          10,
        ),
      ]);
      prisma.booking.findMany.mockResolvedValue([
        {
          id: 'bk-withdrawn',
          patientId: BOOKER,
          careRecipient: { patientId: WITHDRAWN_OWNER },
        },
        {
          id: 'bk-other',
          patientId: BOOKER,
          careRecipient: { patientId: OTHER_OWNER },
        },
      ]);
    });

    it('★ สมาชิกทั่วไป: แถวจองแทนของคนที่ถอนถูกปิดรายละเอียด แต่แถวยังอยู่ครบ', async () => {
      const result = await service.familyGroupActivity(GROUP_ID, VIEWER);

      // ไม่ตัดแถวทิ้ง — จำนวนแถว/cursor ต้องเท่าเดิม
      expect(result.nodes.map((n) => n.id)).toEqual(['a-1', 'a-2', 'a-3']);

      const hidden = result.nodes[0];
      expect(JSON.parse(hidden.metadata)).toEqual({});
      expect(hidden.targetId).toBeUndefined();
      expect(hidden.action).toBe(ACTIVITY_ACTION.BOOKING_ON_BEHALF);

      // แถวอื่นไม่ถูกแตะ
      expect(JSON.parse(result.nodes[1].metadata)).toEqual({
        recipientName: 'คุณตา',
      });
      expect(result.nodes[1].targetId).toBe('bk-other');
      expect(JSON.parse(result.nodes[2].metadata)).toEqual({
        oldName: 'ก',
        newName: 'ข',
      });
    });

    it('อ่าน booking + ความยินยอมอย่างละ query เดียวต่อหน้า', async () => {
      await service.familyGroupActivity(GROUP_ID, VIEWER);

      expect(prisma.booking.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['bk-withdrawn', 'bk-other'] } },
        }),
      );
      expect(consent.withdrawnUserIds).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['เจ้าของข้อมูลเอง', WITHDRAWN_OWNER],
      ['คนกดจอง (actor)', BOOKER],
    ])('%s ยังเห็นรายละเอียดครบ', async (_label, viewer) => {
      const result = await service.familyGroupActivity(GROUP_ID, viewer);

      expect(JSON.parse(result.nodes[0].metadata)).toEqual(HIDDEN_META);
      expect(result.nodes[0].targetId).toBe('bk-withdrawn');
    });

    it('หน้าที่ไม่มีแถวจองแทนเลย → ไม่ยิง query เพิ่ม', async () => {
      prisma.familyGroupActivity.findMany.mockResolvedValue([
        activity('a-3', ACTIVITY_ACTION.GROUP_RENAMED, null, {}, 10),
      ]);

      await service.familyGroupActivity(GROUP_ID, VIEWER);

      expect(prisma.booking.findMany).not.toHaveBeenCalled();
      expect(consent.withdrawnUserIds).not.toHaveBeenCalled();
    });
  });
});
