/**
 * ค่าคงที่ของโมดูล Family Group (PYG-412 / Epic PYG-381)
 *
 * ★ ทำไมต้องมีไฟล์นี้ ไม่เขียน string ตรง ๆ ในโค้ด?
 *   ตาราง family_group_* ในดีบีใช้ "TEXT + CHECK constraint" ไม่ใช่ PG enum
 *   (กติกาของการ์ด PYG-411) → TypeScript จึงไม่มีทางรู้ว่าพิมพ์ผิดจนกว่าจะ INSERT แล้วดีบีปฏิเสธ
 *   การรวมค่าไว้ที่นี่ทำให้พิมพ์ผิดตั้งแต่ตอน compile แทนที่จะไปเจอตอน runtime
 *
 * ⚠ ถ้าจะเพิ่มค่าใหม่ในนี้ ต้องแก้ CHECK constraint ในไฟล์ migration ด้วยเสมอ
 *   ไม่งั้นโค้ดจะ compile ผ่านแต่ INSERT ไม่ผ่าน
 *   (CHECK ที่เกี่ยวข้อง: family_group_members_role_check / _status_check,
 *    family_group_activity_action_check / _target_type_check)
 */

// ─── 1. บทบาทในกลุ่ม ────────────────────────────────────────────────────────
/**
 * OWNER มีได้ "คนเดียวต่อกลุ่ม" และต้องมีเสมอ (invariant ระดับดีบี)
 * บังคับด้วย partial unique index "family_group_members_one_active_owner_key"
 * → WHERE role='OWNER' AND status='ACTIVE'
 */
export const GROUP_ROLE = {
  OWNER: 'OWNER',
  MEMBER: 'MEMBER',
} as const;

export type GroupRoleName = (typeof GROUP_ROLE)[keyof typeof GROUP_ROLE];

// ─── 2. สถานะสมาชิก ─────────────────────────────────────────────────────────
/**
 * ★ ออกจากกลุ่มแล้ว "ไม่ลบแถวทิ้ง" — เปลี่ยนเป็น LEFT/REMOVED แทน
 *   เพราะฟีดกิจกรรม (PYG-421) ต้องอ้างย้อนหลังได้ว่าใครเคยอยู่ในกลุ่ม
 *   และเพราะ @@unique([groupId, userId]) ทำให้คนเดิมกลับเข้ามาคือ UPDATE ไม่ใช่ INSERT
 *
 * ★★ ทุกการเช็คสิทธิ์ในโมดูลนี้ต้องกรอง status = ACTIVE เสมอ (คำสั่งตรงจากการ์ด)
 *    คนที่ status = REMOVED/LEFT ต้องหมดสิทธิ์ "ทันที" ไม่ใช่รอ token หมดอายุ
 */
export const MEMBER_STATUS = {
  ACTIVE: 'ACTIVE',
  /** เจ้าของกลุ่มเตะออก */
  REMOVED: 'REMOVED',
  /** ออกเอง */
  LEFT: 'LEFT',
} as const;

export type MemberStatus = (typeof MEMBER_STATUS)[keyof typeof MEMBER_STATUS];

// ─── 3. ชนิดของกิจกรรมที่บันทึกลง family_group_activity ─────────────────────
/**
 * ค่าพวกนี้ต้องตรงกับ CHECK "family_group_activity_action_check" เป๊ะ ๆ
 * ในนี้มีค่าของการ์ดอื่นปนอยู่ด้วย (MEMBER_INVITED = PYG-416, MEMBER_JOINED = PYG-417,
 * RECIPIENT_* / BOOKING_ON_BEHALF = PYG-424) ตั้งใจใส่ไว้ให้ครบตั้งแต่ตอนนี้
 * เพื่อให้การ์ดถัดไปหยิบใช้ได้เลยโดยไม่ต้องมาเดาว่าดีบียอมรับค่าไหนบ้าง
 */
export const ACTIVITY_ACTION = {
  GROUP_CREATED: 'GROUP_CREATED',
  GROUP_RENAMED: 'GROUP_RENAMED',
  MEMBER_INVITED: 'MEMBER_INVITED', // PYG-416
  INVITE_REVOKED: 'INVITE_REVOKED', // PYG-416
  MEMBER_JOINED: 'MEMBER_JOINED', // PYG-417
  MEMBER_LEFT: 'MEMBER_LEFT',
  MEMBER_REMOVED: 'MEMBER_REMOVED',
  OWNERSHIP_TRANSFERRED: 'OWNERSHIP_TRANSFERRED',
  RECIPIENT_ADDED: 'RECIPIENT_ADDED', // PYG-424
  RECIPIENT_UPDATED: 'RECIPIENT_UPDATED', // PYG-424
  RECIPIENT_REMOVED: 'RECIPIENT_REMOVED', // PYG-424
  BOOKING_ON_BEHALF: 'BOOKING_ON_BEHALF', // PYG-424
} as const;

export type ActivityAction =
  (typeof ACTIVITY_ACTION)[keyof typeof ACTIVITY_ACTION];

/** ชนิดของสิ่งที่กิจกรรมนั้นชี้ไปหา (polymorphic — ไม่มี FK ในดีบี) */
export const ACTIVITY_TARGET = {
  GROUP: 'GROUP',
  MEMBER: 'MEMBER',
  INVITE: 'INVITE',
  RECIPIENT: 'RECIPIENT',
  BOOKING: 'BOOKING',
} as const;

export type ActivityTarget =
  (typeof ACTIVITY_TARGET)[keyof typeof ACTIVITY_TARGET];

// ─── 4. กติกาชื่อกลุ่ม ──────────────────────────────────────────────────────
/**
 * ต้องตรงกับ CHECK "family_group_name_check" ในดีบี:
 *   char_length(btrim(name)) BETWEEN 1 AND 80
 *
 * ★ วัดหลัง trim เสมอ → ชื่อที่มีแต่ช่องว่าง ("   ") ถือว่า "ว่าง" และต้องถูกปฏิเสธ
 *   (AC-BS-01: "rename empty or >80 chars → validation")
 */
export const GROUP_NAME_MIN_LENGTH = 1;
export const GROUP_NAME_MAX_LENGTH = 80;
