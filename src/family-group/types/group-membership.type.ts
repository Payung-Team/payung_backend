import { AuthenticatedRequest } from '../../common/types/gql-context.type';
import { GroupRoleName } from '../family-group.constants';

/**
 * ผลการเช็คสมาชิกภาพ 1 ครั้ง ที่ FamilyGroupGuard โหลดมาแล้ว
 * (มีเฉพาะสมาชิกที่ status = 'ACTIVE' เท่านั้น — คนที่ LEFT/REMOVED ไม่มีวันได้ object นี้)
 */
export interface GroupMembershipContext {
  /** family_group_members.id */
  membershipId: string;
  groupId: string;
  userId: string;
  role: GroupRoleName;
}

/**
 * key ที่ใช้แปะ cache ไว้บน request object
 *
 * ทำไมแปะบน req ไม่ใช่ property ของ guard?
 *   guard เป็น singleton ที่ Nest ใช้ซ้ำทุก request — ถ้าเก็บ state ไว้ในตัว guard
 *   ข้อมูลของผู้ใช้คนหนึ่งจะรั่วไปให้อีกคน ส่วน req เกิดใหม่ทุก request จึงปลอดภัย
 *   และตายไปพร้อม request เอง ไม่ต้องเคลียร์
 */
export const GROUP_MEMBERSHIP_CACHE = 'familyGroupMemberships' as const;

/**
 * request ที่ผ่าน SupabaseAuthGuard แล้ว + ช่องเก็บ cache สมาชิกภาพ
 *
 * Map<groupId, GroupMembershipContext> — เป็น Map เพราะ 1 request ยิงได้หลาย operation
 * (Apollo รวมหลาย mutation/query ในเอกสารเดียวได้) ซึ่งอาจอ้างคนละกลุ่มกัน
 */
export type RequestWithMembership = AuthenticatedRequest & {
  [GROUP_MEMBERSHIP_CACHE]?: Map<string, GroupMembershipContext>;
};
