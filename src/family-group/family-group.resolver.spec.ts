/**
 * Unit tests — ตาราง "ใครเรียกอะไรได้" ของลิงก์เข้าร่วมกลุ่ม ที่ชั้น resolver (PYG-478)
 *
 * บั๊ก PYG-478 คือสิทธิ์ถูกล็อก "2 ชั้น" (resolver + service) ต้องแก้ทั้งคู่ถึงจะหาย
 *   ชั้น service → เฝ้าอยู่ใน join-link.service.spec.ts
 *   ชั้น resolver → เฝ้าในไฟล์นี้ = ค่าใน @GroupRole() ของแต่ละ resolver
 * ถ้าวันหนึ่งมีคนเปลี่ยน groupJoinLink กลับเป็น OWNER หรือเผลอเปิด rotate/revoke ให้ MEMBER
 * เทสต์ในไฟล์นี้จะแดงทันที
 *
 * อ่าน metadata ด้วย Reflector ตัวเดียวกับที่ FamilyGroupGuard ใช้ตัดสินจริง
 * → ไม่ต้องบูต GraphQL หรือต่อดีบีเลย
 */
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { FamilyGroupResolver } from './family-group.resolver';
import { JoinLinkRateLimitGuard } from './guards/join-link-rate-limit.guard';
import {
  GROUP_ROLE_KEY,
  GroupRoleMetadata,
} from './decorators/group-role.decorator';
import { GROUP_ROLE } from './family-group.constants';
import { FamilyGroupService } from './family-group.service';
import { FamilyGroupAvatarService } from './family-group-avatar.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';

describe('FamilyGroupResolver — สิทธิ์ของลิงก์เข้าร่วมกลุ่ม (SCR-FG2-001 Amendment 1)', () => {
  const reflector = new Reflector();

  /** role ที่ @GroupRole() ของเมธอดนั้นต้องการ — undefined = ไม่ได้ติด @GroupRole */
  const requiredRoleOf = (method: keyof FamilyGroupResolver) =>
    reflector.get<GroupRoleMetadata | undefined>(
      GROUP_ROLE_KEY,
      FamilyGroupResolver.prototype[method],
    )?.role;

  it('B9 — groupJoinLink เปิดให้สมาชิก ACTIVE ทุกคน (@GroupRole MEMBER ไม่ใช่ OWNER)', () => {
    expect(requiredRoleOf('groupJoinLink')).toBe(GROUP_ROLE.MEMBER);
  });

  it.each(['createJoinLink', 'rotateJoinLink', 'revokeJoinLink'] as const)(
    'B1 — %s ยังเป็นของเจ้าของเท่านั้น (@GroupRole OWNER)',
    (method) => {
      expect(requiredRoleOf(method)).toBe(GROUP_ROLE.OWNER);
    },
  );
});

/**
 * PYG-479 — จุดไหนติดตัวจำกัดอัตราบ้าง
 * ถ้ามีคนเผลอถอด @UseGuards(JoinLinkRateLimitGuard) ออกจาก preview หรือ join
 * (หรือเอาไปติดที่อื่นโดยไม่ตั้งใจ) เทสต์ตรงนี้จะแดงทันที
 */
describe('FamilyGroupResolver — rate limit ของลิงก์เข้าร่วม (PYG-479)', () => {
  const reflector = new Reflector();

  /** guard ระดับเมธอดที่ติดไว้ (ไม่รวม guard ระดับคลาส) */
  const methodGuardsOf = (method: keyof FamilyGroupResolver) =>
    reflector.get<unknown[] | undefined>(
      GUARDS_METADATA,
      FamilyGroupResolver.prototype[method],
    ) ?? [];

  it.each(['joinLinkPreview', 'joinGroupByLink'] as const)(
    '%s ติด JoinLinkRateLimitGuard (นับรวมกัน กันเดา token ผ่าน preview แทน)',
    (method) => {
      expect(methodGuardsOf(method)).toContain(JoinLinkRateLimitGuard);
    },
  );

  it.each([
    'groupJoinLink',
    'createJoinLink',
    'rotateJoinLink',
    'revokeJoinLink',
    'myFamilyGroups',
  ] as const)(
    '%s ไม่ติด (ไม่ได้รับ token จากคนนอก — จำกัดไปก็กวนผู้ใช้เปล่า ๆ)',
    (method) => {
      expect(methodGuardsOf(method)).not.toContain(JoinLinkRateLimitGuard);
    },
  );
});

/**
 * รูปกลุ่ม — ลบรูปต้องเป็นเจ้าของ และลบกลุ่มแล้วต้องลบไฟล์รูปตาม (ไฟล์ไม่หายตาม FK ของดีบี)
 */
describe('FamilyGroupResolver — รูปกลุ่ม', () => {
  const reflector = new Reflector();
  const USER = { id: 'user-owner' } as AuthUser;
  const GROUP_ID = 'group-1';

  let familyGroupService: {
    deleteFamilyGroup: jest.Mock;
    familyGroup: jest.Mock;
  };
  let groupAvatarService: { remove: jest.Mock; removeQuietly: jest.Mock };
  let resolver: FamilyGroupResolver;

  beforeEach(() => {
    familyGroupService = {
      deleteFamilyGroup: jest
        .fn()
        .mockResolvedValue({ id: GROUP_ID, deleted: true }),
      familyGroup: jest.fn().mockResolvedValue({ id: GROUP_ID }),
    };
    groupAvatarService = {
      remove: jest.fn().mockResolvedValue(undefined),
      removeQuietly: jest.fn().mockResolvedValue(undefined),
    };
    resolver = new FamilyGroupResolver(
      familyGroupService as unknown as FamilyGroupService,
      groupAvatarService as unknown as FamilyGroupAvatarService,
    );
  });

  it('removeFamilyGroupAvatar เป็นของเจ้าของเท่านั้น (@GroupRole OWNER)', () => {
    const method = 'removeFamilyGroupAvatar' as const;
    expect(
      reflector.get<GroupRoleMetadata | undefined>(
        GROUP_ROLE_KEY,
        FamilyGroupResolver.prototype[method],
      )?.role,
    ).toBe(GROUP_ROLE.OWNER);
  });

  it('removeFamilyGroupAvatar ลบรูปแล้วคืนกลุ่ม (FE อัปเดต cache จากผลนี้)', async () => {
    await expect(
      resolver.removeFamilyGroupAvatar(GROUP_ID, USER),
    ).resolves.toEqual({ id: GROUP_ID });
    expect(groupAvatarService.remove).toHaveBeenCalledWith(USER.id, GROUP_ID);
    expect(familyGroupService.familyGroup).toHaveBeenCalledWith(
      USER.id,
      GROUP_ID,
    );
  });

  it('deleteFamilyGroup สำเร็จ → ลบไฟล์รูปของกลุ่มตาม', async () => {
    await expect(resolver.deleteFamilyGroup(GROUP_ID, USER)).resolves.toEqual({
      id: GROUP_ID,
      deleted: true,
    });
    expect(groupAvatarService.removeQuietly).toHaveBeenCalledWith(GROUP_ID);
  });

  it('deleteFamilyGroup ล้ม → ไม่แตะไฟล์รูป', async () => {
    familyGroupService.deleteFamilyGroup.mockRejectedValue(
      new Error('not owner'),
    );

    await expect(resolver.deleteFamilyGroup(GROUP_ID, USER)).rejects.toThrow(
      'not owner',
    );
    expect(groupAvatarService.removeQuietly).not.toHaveBeenCalled();
  });
});
