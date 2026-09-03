import { SetMetadata } from '@nestjs/common';
import { GroupRoleName } from '../family-group.constants';

export const GROUP_ROLE_KEY = 'familyGroupRole';

/** ตัวเลือกเสริม — ใช้ตอนชื่อ argument ที่เก็บ groupId ไม่ได้ชื่อ 'groupId' */
export interface GroupRoleOptions {
  /**
   * ชื่อ argument ที่เก็บ groupId
   * default = 'groupId' (guard จะหาให้ทั้งระดับบนสุด และใน args.input)
   */
  idArg?: string;
}

export interface GroupRoleMetadata {
  role: GroupRoleName;
  idArg: string;
}

/**
 * @GroupRole — บอก FamilyGroupGuard ว่า resolver นี้ต้องการสิทธิ์ระดับไหนในกลุ่ม
 *
 * ใช้คู่กับ FamilyGroupGuard เสมอ (ถ้าลืมใส่ guard → decorator นี้ไม่มีผลใด ๆ เงียบ ๆ)
 *
 * @example
 * // ต้องเป็นเจ้าของกลุ่ม — guard อ่าน groupId จาก args.input.groupId
 * @GroupRole('OWNER')
 * async renameFamilyGroup(@Args('input') input: RenameFamilyGroupInput) { ... }
 *
 * @example
 * // แค่เป็นสมาชิกก็พอ — guard อ่าน groupId จาก args.groupId
 * @GroupRole('MEMBER')
 * async familyGroup(@Args('groupId', { type: () => ID }) groupId: string) { ... }
 *
 * @example
 * // argument ชื่ออื่น
 * @GroupRole('MEMBER', { idArg: 'id' })
 *
 * หมายเหตุเรื่องลำดับชั้น: 'MEMBER' หมายถึง "อย่างน้อยต้องเป็นสมาชิก" → OWNER ผ่านด้วย
 * ส่วน 'OWNER' หมายถึง "ต้องเป็นเจ้าของเท่านั้น" → MEMBER ธรรมดาไม่ผ่าน
 */
export const GroupRole = (
  role: GroupRoleName,
  options: GroupRoleOptions = {},
) =>
  SetMetadata<string, GroupRoleMetadata>(GROUP_ROLE_KEY, {
    role,
    idArg: options.idArg ?? 'groupId',
  });
