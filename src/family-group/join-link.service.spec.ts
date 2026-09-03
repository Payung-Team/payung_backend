/**
 * Unit tests — ลิงก์เข้าร่วมกลุ่ม (PYG-416 · SCR-FG2-001)
 *
 * ครอบคลุม AC ของ FG-2 ฉบับปรับปรุงเฉพาะส่วนที่การ์ดนี้รับผิดชอบ:
 *   B1  เจ้าของสร้างลิงก์ → แถว ACTIVE + คืน URL + เขียน JOIN_LINK_CREATED
 *   B2  หน้า preview บอกชื่อกลุ่ม/เจ้าของ/จำนวนคน ก่อนกดยืนยัน
 *   B3  หมดอายุ / ถูกยกเลิก → isUsable = false พร้อมเหตุผล
 *   B5  token ที่ไม่ตรงแถวไหนเลย → JOIN_LINK_INVALID
 *   B6  โควตาเต็ม → EXHAUSTED · กลุ่มเต็ม → GROUP_FULL
 *   B8  rotate → ใบเดิมถูก REVOKED และออกใบใหม่ในธุรกรรมเดียว
 *
 * ส่วน B4/B7 (กดเข้าร่วมจริง, login แล้วกลับมาต่อ) อยู่ที่ PYG-417 และ PYG-418
 *
 * mock PrismaService ทั้งหมด → ไม่แตะดีบีจริง
 */
import { Test, TestingModule } from '@nestjs/testing';
import { createHash } from 'crypto';
import { FamilyGroupService } from './family-group.service';
import { PrismaService } from '../common/prisma.service';
import {
  ACTIVITY_ACTION,
  GROUP_MAX_MEMBERS,
  GROUP_ROLE,
  JOIN_LINK_STATUS,
  MEMBER_STATUS,
} from './family-group.constants';
import { FG_ERROR } from './family-group.errors';

const GROUP_ID = '11111111-1111-1111-1111-111111111111';
const LINK_ID = '22222222-2222-2222-2222-222222222222';
const OWNER_ID = 'u-owner';
const OUTSIDER_ID = 'u-outsider';
const BASE_URL = 'https://payung.test';

const HOUR = 60 * 60 * 1000;

function callArg(mock: jest.Mock, index = 0): Record<string, unknown> {
  const call = mock.mock.calls[index] as [Record<string, unknown>];
  return call[0];
}

/** แถวลิงก์ตามรูปทรงที่ prisma คืนกลับ */
const linkRow = (overrides: Record<string, unknown> = {}) => ({
  id: LINK_ID,
  groupId: GROUP_ID,
  tokenHash: 'a'.repeat(64),
  tokenRaw: 'raw-token-value',
  status: JOIN_LINK_STATUS.ACTIVE,
  maxUses: 10,
  usedCount: 0,
  expiresAt: new Date(Date.now() + 24 * HOUR),
  createdBy: OWNER_ID,
  createdAt: new Date('2026-09-01T00:00:00Z'),
  ...overrides,
});

/** แถวที่ joinLinkPreview select มา (มี group ซ้อนอยู่ข้างใน) */
const previewRow = (
  linkOverrides: Record<string, unknown> = {},
  members: Array<Record<string, unknown>> = [
    {
      userId: OWNER_ID,
      role: GROUP_ROLE.OWNER,
      user: { displayName: 'ยายสมร' },
    },
  ],
) => ({
  ...linkRow(linkOverrides),
  group: { name: 'บ้านยาย', members },
});

describe('FamilyGroupService — join link (PYG-416)', () => {
  let service: FamilyGroupService;
  let tx: {
    familyGroupJoinLink: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
    };
    familyGroupMember: { findFirst: jest.Mock; count: jest.Mock };
    familyGroupActivity: { create: jest.Mock };
  };
  let prisma: typeof tx & { $transaction: jest.Mock };

  beforeEach(async () => {
    process.env.APP_PUBLIC_BASE_URL = BASE_URL;

    tx = {
      familyGroupJoinLink: {
        create: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      familyGroupMember: {
        findFirst: jest.fn(),
        count: jest.fn().mockResolvedValue(1),
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

  const givenCallerIsOwner = () =>
    tx.familyGroupMember.findFirst.mockResolvedValue({ id: 'fgm-owner' });
  const givenCallerIsNotOwner = () =>
    tx.familyGroupMember.findFirst.mockResolvedValue(null);

  // ═══ B1 · createJoinLink ═════════════════════════════════════════════
  describe('createJoinLink', () => {
    it('สร้างลิงก์ใหม่ + เขียนกิจกรรม JOIN_LINK_CREATED ในธุรกรรมเดียว', async () => {
      givenCallerIsOwner();
      tx.familyGroupJoinLink.create.mockResolvedValue(linkRow());

      const result = await service.createJoinLink(OWNER_ID, {
        groupId: GROUP_ID,
      });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(result.url).toBe(`${BASE_URL}/join?token=raw-token-value`);
      expect(result.maxUses).toBe(10);
      expect(result.remainingUses).toBe(10);
      expect(result.isUsable).toBe(true);

      expect(callArg(tx.familyGroupActivity.create)).toMatchObject({
        data: { action: ACTIVITY_ACTION.JOIN_LINK_CREATED },
      });
    });

    it('เก็บ tokenHash เป็น sha256 ของ token ดิบเสมอ (PYG-417 ใช้ค่านี้ค้นหาแถว)', async () => {
      givenCallerIsOwner();
      tx.familyGroupJoinLink.create.mockResolvedValue(linkRow());

      await service.createJoinLink(OWNER_ID, { groupId: GROUP_ID });

      const data = callArg(tx.familyGroupJoinLink.create).data as {
        tokenRaw: string;
        tokenHash: string;
      };
      expect(data.tokenHash).toBe(
        createHash('sha256').update(data.tokenRaw, 'utf8').digest('hex'),
      );
      expect(data.tokenHash).toHaveLength(64);
      // token ดิบต้องยาวพอ — 32 ไบต์ในรูป base64url = 43 ตัวอักษร
      expect(data.tokenRaw).toHaveLength(43);
    });

    it('★ กดซ้ำแล้วได้ลิงก์ใบเดิม ไม่สร้างทับ (กัน double-tap ฆ่าลิงก์ที่ส่งไปแล้ว)', async () => {
      givenCallerIsOwner();
      tx.familyGroupJoinLink.findFirst.mockResolvedValue(linkRow());

      const result = await service.createJoinLink(OWNER_ID, {
        groupId: GROUP_ID,
        maxUses: 3,
      });

      expect(tx.familyGroupJoinLink.create).not.toHaveBeenCalled();
      expect(tx.familyGroupActivity.create).not.toHaveBeenCalled();
      // ตัวเลือกที่ส่งมาถูกเมิน — ใบเดิมยังเป็น 10 เหมือนเดิม
      expect(result.maxUses).toBe(10);
    });

    it('ไม่ใช่เจ้าของกลุ่ม → NOT_GROUP_OWNER และไม่มีแถวถูกสร้าง', async () => {
      givenCallerIsNotOwner();

      await expect(
        service.createJoinLink(OUTSIDER_ID, { groupId: GROUP_ID }),
      ).rejects.toMatchObject({
        extensions: { code: FG_ERROR.NOT_GROUP_OWNER },
      });
      expect(tx.familyGroupJoinLink.create).not.toHaveBeenCalled();
    });

    it('ไม่ได้ตั้ง APP_PUBLIC_BASE_URL → JOIN_LINK_CONFIG_MISSING ก่อนแตะดีบี', async () => {
      process.env.APP_PUBLIC_BASE_URL = '';
      givenCallerIsOwner();

      await expect(
        service.createJoinLink(OWNER_ID, { groupId: GROUP_ID }),
      ).rejects.toMatchObject({
        extensions: { code: FG_ERROR.JOIN_LINK_CONFIG_MISSING },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('ไม่ใส่ token หรือ url ลง metadata ของฟีด (สมาชิกทุกคนอ่านฟีดได้)', async () => {
      givenCallerIsOwner();
      tx.familyGroupJoinLink.create.mockResolvedValue(linkRow());

      await service.createJoinLink(OWNER_ID, { groupId: GROUP_ID });

      const meta = JSON.stringify(
        (callArg(tx.familyGroupActivity.create).data as { metadata: unknown })
          .metadata,
      );
      expect(meta).not.toContain('raw-token-value');
      expect(meta).not.toContain('token');
      expect(meta).not.toContain(BASE_URL);
    });
  });

  // ═══ B8 · rotateJoinLink ═════════════════════════════════════════════
  describe('rotateJoinLink', () => {
    it('ยกเลิกใบเดิม + ออกใบใหม่ + เขียน JOIN_LINK_ROTATED ในธุรกรรมเดียว', async () => {
      givenCallerIsOwner();
      tx.familyGroupJoinLink.findFirst.mockResolvedValue(linkRow());
      tx.familyGroupJoinLink.create.mockResolvedValue(
        linkRow({ id: 'new-link', tokenRaw: 'new-raw-token' }),
      );

      const result = await service.rotateJoinLink(OWNER_ID, {
        groupId: GROUP_ID,
      });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(callArg(tx.familyGroupJoinLink.updateMany)).toMatchObject({
        where: { id: LINK_ID, status: JOIN_LINK_STATUS.ACTIVE },
        data: { status: JOIN_LINK_STATUS.REVOKED },
      });
      expect(result.url).toBe(`${BASE_URL}/join?token=new-raw-token`);
      expect(callArg(tx.familyGroupActivity.create)).toMatchObject({
        data: {
          action: ACTIVITY_ACTION.JOIN_LINK_ROTATED,
          metadata: { replacedLinkId: LINK_ID },
        },
      });
    });

    it('กลุ่มที่ยังไม่เคยมีลิงก์ → rotate ทำงานได้ และบันทึกเป็น CREATED ไม่ใช่ ROTATED', async () => {
      givenCallerIsOwner();
      tx.familyGroupJoinLink.findFirst.mockResolvedValue(null);
      tx.familyGroupJoinLink.create.mockResolvedValue(linkRow());

      await service.rotateJoinLink(OWNER_ID, { groupId: GROUP_ID });

      expect(tx.familyGroupJoinLink.updateMany).not.toHaveBeenCalled();
      expect(callArg(tx.familyGroupActivity.create)).toMatchObject({
        data: { action: ACTIVITY_ACTION.JOIN_LINK_CREATED },
      });
    });
  });

  // ═══ B3 · revokeJoinLink ═════════════════════════════════════════════
  describe('revokeJoinLink', () => {
    it('ยกเลิกลิงก์ที่ใช้อยู่ + เขียน JOIN_LINK_REVOKED', async () => {
      givenCallerIsOwner();
      tx.familyGroupJoinLink.findFirst.mockResolvedValue(linkRow());

      await expect(service.revokeJoinLink(OWNER_ID, GROUP_ID)).resolves.toBe(
        true,
      );

      expect(callArg(tx.familyGroupActivity.create)).toMatchObject({
        data: { action: ACTIVITY_ACTION.JOIN_LINK_REVOKED },
      });
    });

    it('ไม่มีลิงก์ให้ยกเลิก → JOIN_LINK_NOT_FOUND และไม่เขียนกิจกรรม', async () => {
      givenCallerIsOwner();
      tx.familyGroupJoinLink.findFirst.mockResolvedValue(null);

      await expect(
        service.revokeJoinLink(OWNER_ID, GROUP_ID),
      ).rejects.toMatchObject({
        extensions: { code: FG_ERROR.JOIN_LINK_NOT_FOUND },
      });
      expect(tx.familyGroupActivity.create).not.toHaveBeenCalled();
    });
  });

  // ═══ groupJoinLink ═══════════════════════════════════════════════════
  describe('groupJoinLink', () => {
    it('เจ้าของกด Copy ซ้ำได้ — คืน url เดิมโดยไม่ต้อง rotate (ข้อตัดสินใจ ก. ของ SCR)', async () => {
      givenCallerIsOwner();
      prisma.familyGroupJoinLink.findFirst.mockResolvedValue(linkRow());

      const first = await service.groupJoinLink(OWNER_ID, GROUP_ID);
      const second = await service.groupJoinLink(OWNER_ID, GROUP_ID);

      expect(first.url).toBe(second.url);
      expect(first.url).toBe(`${BASE_URL}/join?token=raw-token-value`);
      expect(tx.familyGroupJoinLink.updateMany).not.toHaveBeenCalled();
    });

    it('ยังไม่มีลิงก์ → JOIN_LINK_NOT_FOUND', async () => {
      givenCallerIsOwner();
      prisma.familyGroupJoinLink.findFirst.mockResolvedValue(null);

      await expect(
        service.groupJoinLink(OWNER_ID, GROUP_ID),
      ).rejects.toMatchObject({
        extensions: { code: FG_ERROR.JOIN_LINK_NOT_FOUND },
      });
    });
  });

  // ═══ B2 / B3 / B5 / B6 · joinLinkPreview ═════════════════════════════
  describe('joinLinkPreview', () => {
    it('ลิงก์ปกติ → บอกชื่อกลุ่ม เจ้าของ จำนวนคน และ isUsable = true', async () => {
      prisma.familyGroupJoinLink.findUnique.mockResolvedValue(previewRow());

      const result = await service.joinLinkPreview(OUTSIDER_ID, 'any-token');

      expect(result).toMatchObject({
        groupName: 'บ้านยาย',
        ownerName: 'ยายสมร',
        memberCount: 1,
        isUsable: true,
        unusableReason: null,
        alreadyMember: false,
      });
    });

    it('ค้นหาแถวด้วย sha256 ของ token ไม่ใช่ token ดิบ', async () => {
      prisma.familyGroupJoinLink.findUnique.mockResolvedValue(previewRow());

      await service.joinLinkPreview(OUTSIDER_ID, 'plain-token');

      expect(callArg(prisma.familyGroupJoinLink.findUnique)).toMatchObject({
        where: {
          tokenHash: createHash('sha256')
            .update('plain-token', 'utf8')
            .digest('hex'),
        },
      });
    });

    it('B5 — token ที่ไม่ตรงกับแถวไหนเลย → JOIN_LINK_INVALID', async () => {
      prisma.familyGroupJoinLink.findUnique.mockResolvedValue(null);

      await expect(
        service.joinLinkPreview(OUTSIDER_ID, 'guessed'),
      ).rejects.toMatchObject({
        extensions: { code: FG_ERROR.JOIN_LINK_INVALID },
      });
    });

    it('B3 — หมดอายุ → ไม่ throw แต่คืน isUsable = false / EXPIRED พร้อมชื่อกลุ่ม', async () => {
      prisma.familyGroupJoinLink.findUnique.mockResolvedValue(
        previewRow({ expiresAt: new Date(Date.now() - HOUR) }),
      );

      const result = await service.joinLinkPreview(OUTSIDER_ID, 'tok');

      expect(result.groupName).toBe('บ้านยาย');
      expect(result.isUsable).toBe(false);
      expect(result.unusableReason).toBe('EXPIRED');
    });

    it('ถูกยกเลิกแล้วและเลยวันหมดอายุด้วย → รายงาน REVOKED (เจตนาของเจ้าของมาก่อน)', async () => {
      prisma.familyGroupJoinLink.findUnique.mockResolvedValue(
        previewRow({
          status: JOIN_LINK_STATUS.REVOKED,
          expiresAt: new Date(Date.now() - HOUR),
        }),
      );

      const result = await service.joinLinkPreview(OUTSIDER_ID, 'tok');

      expect(result.unusableReason).toBe('REVOKED');
    });

    it('B6 — ใช้ครบโควตา → EXHAUSTED', async () => {
      prisma.familyGroupJoinLink.findUnique.mockResolvedValue(
        previewRow({ maxUses: 3, usedCount: 3 }),
      );

      const result = await service.joinLinkPreview(OUTSIDER_ID, 'tok');

      expect(result.unusableReason).toBe('EXHAUSTED');
    });

    it('B6 — กลุ่มเต็มเพดานสมาชิก → GROUP_FULL แม้โควตาลิงก์ยังเหลือ', async () => {
      const members = Array.from({ length: GROUP_MAX_MEMBERS }, (_, i) => ({
        userId: `u-${i}`,
        role: i === 0 ? GROUP_ROLE.OWNER : GROUP_ROLE.MEMBER,
        user: { displayName: `คนที่ ${i}` },
      }));
      prisma.familyGroupJoinLink.findUnique.mockResolvedValue(
        previewRow({ maxUses: 100, usedCount: 0 }, members),
      );

      const result = await service.joinLinkPreview(OUTSIDER_ID, 'tok');

      expect(result.unusableReason).toBe('GROUP_FULL');
      expect(result.memberCount).toBe(GROUP_MAX_MEMBERS);
    });

    it('สมาชิกเดิมกดลิงก์ซ้ำ → alreadyMember = true และยัง usable (จะเป็น no-op ที่ PYG-417)', async () => {
      prisma.familyGroupJoinLink.findUnique.mockResolvedValue(previewRow());

      const result = await service.joinLinkPreview(OWNER_ID, 'tok');

      expect(result.alreadyMember).toBe(true);
      expect(result.isUsable).toBe(true);
    });

    it('นับเฉพาะสมาชิก ACTIVE — query ต้องกรอง status ไว้แล้ว', async () => {
      prisma.familyGroupJoinLink.findUnique.mockResolvedValue(previewRow());

      await service.joinLinkPreview(OUTSIDER_ID, 'tok');

      const select = callArg(prisma.familyGroupJoinLink.findUnique)
        .select as Record<string, { select: { members: { where: unknown } } }>;
      expect(select.group.select.members.where).toMatchObject({
        status: MEMBER_STATUS.ACTIVE,
      });
    });
  });

  // ═══ assertJoinLinkUsable — ตรรกะร่วมกับ PYG-417 ═════════════════════
  describe('assertJoinLinkUsable', () => {
    const usable = {
      status: JOIN_LINK_STATUS.ACTIVE,
      expiresAt: new Date(Date.now() + HOUR),
      maxUses: 5,
      usedCount: 0,
    };

    it('ลิงก์ปกติ → ไม่โยนอะไร', () => {
      expect(() => service.assertJoinLinkUsable(usable, 1)).not.toThrow();
    });

    /** เคสที่ต้องกดไม่ได้ — type ชัดเพื่อไม่ให้ it.each ยุบเป็น union แล้วต้อง cast */
    const blocked: Array<{
      label: string;
      link: typeof usable;
      memberCount: number;
      code: string;
    }> = [
      {
        label: 'หมดอายุ',
        link: { ...usable, expiresAt: new Date(Date.now() - HOUR) },
        memberCount: 1,
        code: FG_ERROR.JOIN_LINK_EXPIRED,
      },
      {
        label: 'ถูกยกเลิก',
        link: { ...usable, status: JOIN_LINK_STATUS.REVOKED },
        memberCount: 1,
        code: FG_ERROR.JOIN_LINK_REVOKED,
      },
      {
        label: 'โควตาเต็ม',
        link: { ...usable, usedCount: 5 },
        memberCount: 1,
        code: FG_ERROR.JOIN_LINK_EXHAUSTED,
      },
      {
        label: 'กลุ่มเต็ม',
        link: usable,
        memberCount: GROUP_MAX_MEMBERS,
        code: FG_ERROR.GROUP_MEMBER_LIMIT_REACHED,
      },
    ];

    it.each(blocked)('$label → $code', ({ link, memberCount, code }) => {
      // จับ error มาเทียบ extensions.code ตรง ๆ แทน toThrow(objectContaining)
      // เพราะตัวหลังคืน any ทำให้ eslint (no-unsafe-argument) ร้อง
      let thrown: unknown;
      try {
        service.assertJoinLinkUsable(link, memberCount);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ extensions: { code } });
    });
  });
});
