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
  /**
   * @deprecated SCR-FG2-001 — โมเดลคำเชิญรายอีเมลถูกยกเลิก ใช้ JOIN_LINK_* แทน
   * ยังไม่ลบออกเพราะ branch dev มีโค้ดที่เขียนค่านี้อยู่ และ CHECK ในดีบียังรับอยู่
   */
  MEMBER_INVITED: 'MEMBER_INVITED',
  /** @deprecated SCR-FG2-001 — ดูหมายเหตุที่ MEMBER_INVITED */
  INVITE_REVOKED: 'INVITE_REVOKED',
  JOIN_LINK_CREATED: 'JOIN_LINK_CREATED', // PYG-416
  JOIN_LINK_ROTATED: 'JOIN_LINK_ROTATED', // PYG-416
  JOIN_LINK_REVOKED: 'JOIN_LINK_REVOKED', // PYG-416
  MEMBER_JOINED: 'MEMBER_JOINED', // PYG-417
  /** PYG-417 · SCR ข้อ ค. — คนที่เคยถูกเตะออก กดลิงก์เดิมกลับเข้ามาใหม่ */
  MEMBER_REJOINED: 'MEMBER_REJOINED',
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
  /** @deprecated SCR-FG2-001 — ใช้ JOIN_LINK แทน */
  INVITE: 'INVITE',
  JOIN_LINK: 'JOIN_LINK',
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

// ─── 5. ลิงก์เข้าร่วมกลุ่ม (PYG-416 · SCR-FG2-001) ──────────────────────────
/**
 * สถานะของลิงก์ — ต้องตรงกับ CHECK "family_group_join_links_status_check"
 *
 * ★ ไม่มี 'EXPIRED' โดยตั้งใจ
 *   หมดอายุคือ "ผลลัพธ์ของการเทียบ expiresAt กับเวลาปัจจุบัน" ไม่ใช่สถานะที่เก็บไว้
 *   ถ้าทำเป็นสถานะจะต้องมี cron มาไล่เปลี่ยน แล้วช่วงที่ cron ยังไม่วิ่ง
 *   ดีบีจะบอกว่า ACTIVE ทั้งที่หมดอายุไปแล้ว = โกหกโดยโครงสร้าง
 */
export const JOIN_LINK_STATUS = {
  ACTIVE: 'ACTIVE',
  REVOKED: 'REVOKED',
} as const;

export type JoinLinkStatus =
  (typeof JOIN_LINK_STATUS)[keyof typeof JOIN_LINK_STATUS];

/** ความยาวของ token ดิบเป็นไบต์ ก่อน encode เป็น base64url (สเปก: 32-byte random) */
export const JOIN_LINK_TOKEN_BYTES = 32;

/** อ่านจำนวนเต็มบวกจาก env — คืน fallback ถ้าไม่ได้ตั้ง / ตั้งมั่ว / <= 0 */
const envPositiveInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * อายุของลิงก์ (ชั่วโมง) — PYG-428
 * ชื่อ env เปลี่ยนจาก FAMILY_INVITE_TTL_HOURS ตาม SCR-FG2-001
 * แต่ยังอ่านชื่อเดิมเป็น fallback เพื่อไม่ให้ staging ที่ยังไม่ได้แก้ .env พังทันที
 */
export const JOIN_LINK_TTL_HOURS = envPositiveInt(
  process.env.FAMILY_JOIN_LINK_TTL_HOURS ?? process.env.FAMILY_INVITE_TTL_HOURS,
  168,
);

/**
 * โควตาจำนวนคนที่เข้าได้ต่อลิงก์ 1 ใบ — PYG-428
 *
 * ★ ตั้งค่าเป็น 0 = "ไม่จำกัด" (เก็บลงดีบีเป็น NULL)
 *   ไม่ใช้ค่าว่างแทนเพราะค่าว่างแยกไม่ออกจาก "ลืมตั้ง" ซึ่งต้องได้ค่า default
 */
export const JOIN_LINK_MAX_USES: number | null = (() => {
  const raw = process.env.FAMILY_JOIN_LINK_MAX_USES;
  if (raw !== undefined && raw.trim() === '0') return null;
  return envPositiveInt(raw, 10);
})();

/**
 * เพดานสมาชิก ACTIVE ต่อกลุ่ม — PYG-428
 *
 * ★ SCR-FG2-001 เลื่อนค่านี้จาก optional (§11.5) มาเป็นบังคับ
 *   เพราะพอลิงก์ใช้ซ้ำได้ ตัวจำกัดจำนวนคนคือมาตรการควบคุมหลักที่เหลืออยู่
 *   แทนที่การผูกคำเชิญกับอีเมลรายคนแบบเดิม
 */
export const GROUP_MAX_MEMBERS = envPositiveInt(
  process.env.FAMILY_GROUP_MAX_MEMBERS,
  10,
);

/**
 * โดเมนที่เอาไปประกอบเป็น URL ของลิงก์ — PYG-428
 *
 * ★ เป็นฟังก์ชัน ไม่ใช่ const ต่างจากค่าอื่นในไฟล์นี้โดยตั้งใจ
 *   ค่าอื่นเป็นตัวเลขที่มี default ใช้ได้เลย แต่ตัวนี้ "ต้องมาจาก env เท่านั้น"
 *   ถ้าอ่านตอน import โมดูล เทสจะตั้งค่าไม่ทัน (import ถูก hoist ขึ้นก่อนเสมอ)
 *   และ deploy ที่ inject env ทีหลังจะได้ค่าว่างค้างไปตลอดอายุ process
 *   แพตเทิร์นเดียวกับ resolveSecret() ของ JobQrService (PYG-434)
 *
 * ไม่มี fallback เป็น localhost เพราะลิงก์ที่ชี้ localhost ส่งให้คนอื่นไม่ได้
 * ปล่อยให้พังเสียงดังตอน deploy ดีกว่าไปพังเงียบ ๆ ตอนผู้ใช้กดลิงก์
 */
export const joinLinkBaseUrl = (): string =>
  (process.env.APP_PUBLIC_BASE_URL ?? '').trim();

/** path ของหน้ารับลิงก์ฝั่ง FE (PYG-418) */
export const JOIN_LINK_PATH = '/join';
