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
import { Reflector } from '@nestjs/core';
import { FamilyGroupResolver } from './family-group.resolver';
import {
  GROUP_ROLE_KEY,
  GroupRoleMetadata,
} from './decorators/group-role.decorator';
import { GROUP_ROLE } from './family-group.constants';

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
