/**
 * Unit tests — ฟีดกิจกรรมของกลุ่ม (PYG-421 · FG-3)
 *
 * ครอบคลุมเคสของ TC-BS-07 เฉพาะส่วนที่การ์ดนี้รับผิดชอบ (ฝั่ง query):
 *   · คืนกิจกรรมใหม่สุดก่อน พร้อม actor / action / เวลา ที่ถูกต้อง
 *   · keyset pagination เสถียร — หน้า 2 ไม่ส่งแถวของหน้า 1 ซ้ำ แม้เวลาจะเท่ากันเป๊ะ
 *   · hasNextPage / endCursor ตรงกับความจริง
 *   · cursor ที่แกะไม่ออก → ACTIVITY_CURSOR_INVALID
 *   · เพดานและค่าเริ่มต้นของ first
 *
 * ส่วน "คนนอกกลุ่ม/คนที่ถูกเตะอ่านไม่ได้" อยู่ที่ FamilyGroupGuard ซึ่งมีเทสของตัวเอง
 * ที่ family-group.guard.spec.ts แล้ว — ที่นี่จึงไม่ทดสอบซ้ำ (service ไม่ได้ตรวจสิทธิ์เอง)
 *
 * mock PrismaService ทั้งหมด → ไม่แตะดีบีจริง
 */
import { Test, TestingModule } from '@nestjs/testing';
import { FamilyGroupService } from './family-group.service';
import { PrismaService } from '../common/prisma.service';
import {
  ACTIVITY_ACTION,
  ACTIVITY_PAGE_SIZE_DEFAULT,
  ACTIVITY_PAGE_SIZE_MAX,
  ACTIVITY_TARGET,
} from './family-group.constants';
import { FG_ERROR } from './family-group.errors';

const GROUP_ID = '11111111-1111-1111-1111-111111111111';
const ACTOR_ID = 'u-owner';

/** เวลาเดียวกันเป๊ะสองแถว = กิจกรรมที่เกิดใน transaction เดียวกัน (เคสที่ id ต้องมาตัดสิน) */
const SAME_INSTANT = new Date('2026-09-05T10:00:00.000Z');

/** แถวกิจกรรมตามรูปทรงที่ ACTIVITY_SELECT คืนกลับ */
const activityRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'a-0001',
  actorId: ACTOR_ID,
  action: ACTIVITY_ACTION.GROUP_RENAMED,
  targetType: ACTIVITY_TARGET.GROUP,
  targetId: GROUP_ID,
  metadata: { oldName: 'บ้านยาย', newName: 'บ้านย่า' },
  createdAt: SAME_INSTANT,
  actor: { displayName: 'ยายสมร', avatarUrl: 'https://cdn.test/a.png' },
  ...overrides,
});

/** อ่าน argument ของ findMany ครั้งที่ n ออกมาตรวจ */
type FindManyArgs = {
  where: Record<string, unknown>;
  orderBy: unknown;
  take: number;
};
const findManyArgs = (mock: jest.Mock, index = 0): FindManyArgs =>
  (mock.mock.calls[index] as [FindManyArgs])[0];

/** ถอด cursor กลับเป็นข้อความ เพื่อยืนยันว่าข้างในคือคู่ (createdAt, id) จริง */
const decodeCursor = (cursor: string): string =>
  Buffer.from(cursor, 'base64url').toString('utf8');

describe('FamilyGroupService — activity feed (PYG-421)', () => {
  let service: FamilyGroupService;
  let prisma: {
    familyGroupActivity: { findMany: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      familyGroupActivity: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        FamilyGroupService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = moduleRef.get(FamilyGroupService);
  });

  // ═══ 1. รูปร่างของผลลัพธ์ ════════════════════════════════════════════
  describe('การแปลงแถวเป็นรายการในฟีด', () => {
    it('คืน actor / action / targetType / metadata / เวลา ครบตามที่ FE ต้องใช้', async () => {
      prisma.familyGroupActivity.findMany.mockResolvedValue([activityRow()]);

      const result = await service.familyGroupActivity(GROUP_ID);

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0]).toMatchObject({
        id: 'a-0001',
        action: ACTIVITY_ACTION.GROUP_RENAMED,
        targetType: ACTIVITY_TARGET.GROUP,
        targetId: GROUP_ID,
        createdAt: SAME_INSTANT,
        actor: {
          userId: ACTOR_ID,
          displayName: 'ยายสมร',
          avatarUrl: 'https://cdn.test/a.png',
        },
      });
      // metadata ถูก stringify เพราะ repo ยังไม่มี scalar JSON
      expect(JSON.parse(result.nodes[0].metadata)).toEqual({
        oldName: 'บ้านยาย',
        newName: 'บ้านย่า',
      });
    });

    it('บัญชีที่ถูกลบไปแล้ว → actor เป็น undefined แต่แถวยังอยู่ในฟีด', async () => {
      prisma.familyGroupActivity.findMany.mockResolvedValue([
        activityRow({ actorId: null, actor: null }),
      ]);

      const result = await service.familyGroupActivity(GROUP_ID);

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].actor).toBeUndefined();
    });

    it('กลุ่มที่ยังไม่มีกิจกรรม → nodes ว่าง + endCursor undefined ไม่ใช่ error', async () => {
      prisma.familyGroupActivity.findMany.mockResolvedValue([]);

      const result = await service.familyGroupActivity(GROUP_ID);

      expect(result.nodes).toEqual([]);
      expect(result.pageInfo.endCursor).toBeUndefined();
      expect(result.pageInfo.hasNextPage).toBe(false);
    });
  });

  // ═══ 2. การเรียงลำดับและ take ═══════════════════════════════════════
  describe('คิวรี่ที่ส่งให้ดีบี', () => {
    it('เรียง created_at DESC แล้วต่อด้วย id DESC (ตรงกับ index)', async () => {
      await service.familyGroupActivity(GROUP_ID);

      expect(findManyArgs(prisma.familyGroupActivity.findMany).orderBy).toEqual(
        [{ createdAt: 'desc' }, { id: 'desc' }],
      );
    });

    it('ขอเกินมา 1 แถวเสมอ เพื่อรู้ว่ายังมีหน้าถัดไปไหมโดยไม่ต้อง COUNT(*)', async () => {
      await service.familyGroupActivity(GROUP_ID, 5);

      expect(findManyArgs(prisma.familyGroupActivity.findMany).take).toBe(6);
    });

    it('กรองเฉพาะกลุ่มที่ขอ และไม่มีเงื่อนไข keyset เมื่อไม่ได้ส่ง after', async () => {
      await service.familyGroupActivity(GROUP_ID);

      const { where } = findManyArgs(prisma.familyGroupActivity.findMany);
      expect(where).toEqual({ groupId: GROUP_ID });
    });
  });

  // ═══ 3. เพดาน / ค่าเริ่มต้นของ first ════════════════════════════════
  describe('การตีความค่า first', () => {
    it.each([
      ['ไม่ส่งมาเลย', undefined],
      ['ส่ง null', null],
      ['ส่ง 0', 0],
      ['ส่งค่าติดลบ', -5],
      ['ส่งทศนิยม', 2.5],
    ])('%s → ใช้ค่าเริ่มต้น %i', async (_label, first) => {
      await service.familyGroupActivity(GROUP_ID, first as number | null);

      expect(findManyArgs(prisma.familyGroupActivity.findMany).take).toBe(
        ACTIVITY_PAGE_SIZE_DEFAULT + 1,
      );
    });

    it('ขอเกินเพดาน → ถูกหั่นลงเหลือเพดาน ไม่ใช่ error', async () => {
      await service.familyGroupActivity(GROUP_ID, 500);

      expect(findManyArgs(prisma.familyGroupActivity.findMany).take).toBe(
        ACTIVITY_PAGE_SIZE_MAX + 1,
      );
    });
  });

  // ═══ 4. keyset pagination ═══════════════════════════════════════════
  describe('การแบ่งหน้าแบบ keyset', () => {
    it('มีแถวเกินที่ขอ → hasNextPage = true และตัดแถวส่วนเกินทิ้ง', async () => {
      // ขอ 2 แต่ดีบีคืน 3 (เพราะเราสั่ง take = 3)
      prisma.familyGroupActivity.findMany.mockResolvedValue([
        activityRow({ id: 'a-0003' }),
        activityRow({ id: 'a-0002' }),
        activityRow({ id: 'a-0001' }),
      ]);

      const result = await service.familyGroupActivity(GROUP_ID, 2);

      expect(result.nodes.map((n) => n.id)).toEqual(['a-0003', 'a-0002']);
      expect(result.pageInfo.hasNextPage).toBe(true);
    });

    it('ได้ครบพอดีไม่มีส่วนเกิน → hasNextPage = false', async () => {
      prisma.familyGroupActivity.findMany.mockResolvedValue([
        activityRow({ id: 'a-0003' }),
        activityRow({ id: 'a-0002' }),
      ]);

      const result = await service.familyGroupActivity(GROUP_ID, 2);

      expect(result.nodes).toHaveLength(2);
      expect(result.pageInfo.hasNextPage).toBe(false);
    });

    it('endCursor = cursor ของแถวสุดท้าย และข้างในคือคู่ (createdAt, id)', async () => {
      prisma.familyGroupActivity.findMany.mockResolvedValue([
        activityRow({ id: 'a-0003' }),
        activityRow({ id: 'a-0002' }),
      ]);

      const result = await service.familyGroupActivity(GROUP_ID, 2);

      expect(result.pageInfo.endCursor).toBe(result.nodes[1].cursor);
      expect(decodeCursor(result.pageInfo.endCursor as string)).toBe(
        `${SAME_INSTANT.toISOString()}|a-0002`,
      );
    });

    /**
     * ★ เคสสำคัญที่สุดของการ์ดนี้ (TC-BS-07 "stable across pages")
     *
     * กิจกรรมสองแถวที่เขียนใน transaction เดียวกันได้ created_at เท่ากันเป๊ะ
     * ถ้า cursor ดูแค่ created_at เงื่อนไขหน้า 2 จะกลายเป็น "เก่ากว่าเวลานี้"
     * ซึ่งจะข้ามแถวที่เวลาเท่ากันทิ้งหายไปทั้งกอง — ต้องมีขา id มาตัดสินต่อ
     */
    it('หน้าถัดไปกันทั้ง "แถวซ้ำ" และ "แถวหาย" ตอนเวลาเท่ากันเป๊ะ', async () => {
      prisma.familyGroupActivity.findMany.mockResolvedValue([
        activityRow({ id: 'a-0003' }),
        activityRow({ id: 'a-0002' }),
        activityRow({ id: 'a-0001' }),
      ]);
      const page1 = await service.familyGroupActivity(GROUP_ID, 2);

      await service.familyGroupActivity(GROUP_ID, 2, page1.pageInfo.endCursor);

      const { where } = findManyArgs(prisma.familyGroupActivity.findMany, 1);
      expect(where).toEqual({
        groupId: GROUP_ID,
        OR: [
          { createdAt: { lt: SAME_INSTANT } },
          { createdAt: SAME_INSTANT, id: { lt: 'a-0002' } },
        ],
      });
    });
  });

  // ═══ 5. cursor พัง ═══════════════════════════════════════════════════
  describe('cursor ที่ใช้ไม่ได้', () => {
    it.each([
      ['ข้อความมั่ว ๆ ที่ไม่ใช่ cursor ของเรา', 'not-a-real-cursor'],
      [
        'มีตัวคั่นเกินจำนวน',
        Buffer.from('2026-09-05T10:00:00.000Z|a|b', 'utf8').toString(
          'base64url',
        ),
      ],
      [
        'ส่วนที่เป็นเวลาแปลงเป็นวันที่ไม่ได้',
        Buffer.from('ไม่ใช่วันที่|a-0001', 'utf8').toString('base64url'),
      ],
      [
        'ไม่มีส่วน id',
        Buffer.from('2026-09-05T10:00:00.000Z|', 'utf8').toString('base64url'),
      ],
    ])('%s → ACTIVITY_CURSOR_INVALID', async (_label, cursor) => {
      await expect(
        service.familyGroupActivity(GROUP_ID, 10, cursor),
      ).rejects.toMatchObject({
        extensions: { code: FG_ERROR.ACTIVITY_CURSOR_INVALID },
      });

      // ล้มก่อนถึงดีบี — ไม่เปลืองคิวรี่ให้คำขอที่ยังไงก็ผิด
      expect(prisma.familyGroupActivity.findMany).not.toHaveBeenCalled();
    });

    it('after เป็นค่าว่าง = "ไม่ได้ส่งมา" ไม่ใช่ cursor พัง', async () => {
      await service.familyGroupActivity(GROUP_ID, 10, '');

      expect(findManyArgs(prisma.familyGroupActivity.findMany).where).toEqual({
        groupId: GROUP_ID,
      });
    });
  });
});
