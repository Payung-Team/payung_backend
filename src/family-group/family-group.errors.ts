import { GraphQLError } from 'graphql';

/**
 * Error taxonomy ของโมดูล Family Group (สเปก §5.5)
 *
 * ทำไมเป็น GraphQLError ไม่ใช่ ForbiddenException/NotFoundException ของ Nest?
 *   เหมือนเหตุผลของ FieldLockedError (PYG-146): FE ใช้ Apollo Client อ่าน
 *   `error.extensions.code` ตรง ๆ ถ้าใช้ HttpException ของ Nest เราจะคุม shape ไม่ได้
 *   (Nest จะยัด status/error ของมันเองเข้ามา) → contract กับ FE จะเลื่อนไปมา
 *
 * ★ contract กับ FE — ห้ามเปลี่ยนค่า code โดยไม่บอกทีม FE:
 *   { message: "<ข้อความไทยพร้อมโชว์>", extensions: { code: "<CODE>" , ...ข้อมูลเสริม } }
 *
 * ★ นโยบายการรั่วข้อมูล (สำคัญ):
 *   คนที่ "ไม่ใช่สมาชิก ACTIVE" จะได้ NOT_A_MEMBER เสมอ ไม่ว่ากลุ่มนั้นจะมีอยู่จริงหรือไม่
 *   ตั้งใจแบบนี้เพื่อไม่ให้คนนอกยิง groupId มั่ว ๆ แล้วเดาได้ว่ากลุ่มไหนมีอยู่จริง
 *   → GROUP_NOT_FOUND จะโผล่เฉพาะกับคนที่เป็นสมาชิกอยู่แล้วเท่านั้น (แข่งกันลบกลุ่ม)
 */

/** รหัส error ทั้งหมดของโมดูลนี้ — การ์ดถัด ๆ ไป (PYG-416/417/424) เพิ่มต่อได้ที่นี่ */
export const FG_ERROR = {
  /** กลุ่มไม่มีอยู่จริง (หรือถูกลบไปแล้วระหว่างทาง) */
  GROUP_NOT_FOUND: 'GROUP_NOT_FOUND',
  /** ผู้เรียกไม่ได้เป็นสมาชิกสถานะ ACTIVE ของกลุ่มนี้ */
  NOT_A_MEMBER: 'NOT_A_MEMBER',
  /** เป็นสมาชิกจริง แต่คำสั่งนี้ต้องเป็นเจ้าของกลุ่มเท่านั้น */
  NOT_GROUP_OWNER: 'NOT_GROUP_OWNER',
  /** เจ้าของคนสุดท้ายออก/ถูกเตะไม่ได้ ต้องโอนสิทธิ์หรือลบกลุ่มก่อน */
  LAST_OWNER: 'LAST_OWNER',
  /** ผู้ใช้เป้าหมายไม่ได้เป็นสมาชิก ACTIVE ของกลุ่มนี้ */
  MEMBER_NOT_FOUND: 'MEMBER_NOT_FOUND',
  /** โอนสิทธิ์ให้ตัวเอง (เป็นเจ้าของอยู่แล้ว) */
  ALREADY_OWNER: 'ALREADY_OWNER',
  /** ชื่อกลุ่มว่างหลัง trim หรือยาวเกิน 80 ตัวอักษร */
  GROUP_NAME_INVALID: 'GROUP_NAME_INVALID',
  /**
   * PYG-424 — โปรไฟล์ผู้รับบริการที่อ้างถึง ไม่ได้ถูกแชร์อยู่ในกลุ่มนี้
   *
   * ★ ใช้ค่าเดียวกันนี้กับเคส "ไม่มีโปรไฟล์นั้นอยู่จริง" ด้วย — ตั้งใจ ไม่ใช่ความมักง่าย
   *   เหตุผลเดียวกับ NOT_A_MEMBER ด้านบน: ถ้าแยกเป็น RECIPIENT_NOT_FOUND
   *   สมาชิกกลุ่มหนึ่งจะยิง id มั่ว ๆ แล้วเดาได้ว่าโปรไฟล์ไหนมีอยู่ในระบบบ้าง
   *   ซึ่งเป็นข้อมูลสุขภาพของคนอื่น (PDPA) → ตอบเหมือนกันหมดปลอดภัยกว่า
   */
  RECIPIENT_NOT_IN_GROUP: 'RECIPIENT_NOT_IN_GROUP',
  /**
   * PYG-385 — แก้ไข/นำออกโปรไฟล์ที่ "สมาชิกคนอื่น" เป็นคนเพิ่ม
   *
   * ★ ต่างจาก RECIPIENT_NOT_IN_GROUP: ตัวนี้ยอมรับว่าโปรไฟล์มีอยู่ในกลุ่มจริง — ไม่ใช่การรั่ว
   *   ข้อมูล เพราะสมาชิกทุกคนเห็นโปรไฟล์นั้นในลิสต์อยู่แล้ว (groupCareRecipients คืน ownerUserId)
   *   สิ่งที่ห้ามคือ "แก้ของคนอื่น" เท่านั้น → เจ้าของโปรไฟล์เท่านั้นที่แก้/ลบได้
   */
  RECIPIENT_NOT_OWNER: 'RECIPIENT_NOT_OWNER',

  // ── PYG-416 · SCR-FG2-001 — ลิงก์เข้าร่วมกลุ่ม ─────────────────────────
  /**
   * ลิงก์ใช้ไม่ได้ — token เดา/ถูกแก้/ไม่มีแถวนั้นอยู่จริง
   *
   * ★ ใช้ค่าเดียวกันกับทุกสาเหตุที่ "หาแถวไม่เจอ" โดยตั้งใจ
   *   ถ้าแยกเป็น TOKEN_NOT_FOUND กับ TOKEN_MALFORMED คนที่ยิง token มั่ว ๆ
   *   จะรู้ได้ว่าเดาใกล้เคียงแค่ไหน = ช่วยให้ brute-force ง่ายขึ้นฟรี ๆ
   */
  JOIN_LINK_INVALID: 'JOIN_LINK_INVALID',
  /** เลยเวลาใน expires_at แล้ว */
  JOIN_LINK_EXPIRED: 'JOIN_LINK_EXPIRED',
  /** ถูกเจ้าของยกเลิก หรือถูก rotate ทับด้วยลิงก์ใบใหม่ */
  JOIN_LINK_REVOKED: 'JOIN_LINK_REVOKED',
  /** used_count ถึง max_uses แล้ว — ลิงก์ยัง ACTIVE แต่โควตาหมด */
  JOIN_LINK_EXHAUSTED: 'JOIN_LINK_EXHAUSTED',
  /** สมาชิก ACTIVE ในกลุ่มถึงเพดาน FAMILY_GROUP_MAX_MEMBERS แล้ว */
  GROUP_MEMBER_LIMIT_REACHED: 'GROUP_MEMBER_LIMIT_REACHED',
  /**
   * กลุ่มยังไม่มีลิงก์ที่ใช้งานได้ — เจ้าของต้องกดสร้างก่อน
   * (สมาชิกธรรมดาก็ได้ code นี้ได้ตั้งแต่ PYG-478 — FE ต้องบอกให้ไปขอเจ้าของ ไม่ใช่โชว์ปุ่มสร้าง)
   */
  JOIN_LINK_NOT_FOUND: 'JOIN_LINK_NOT_FOUND',
  /**
   * PYG-500 — จองแทนสมาชิกที่ "ยังไม่เคยมีข้อมูล" แต่คนจองไม่ได้กรอกชื่อผู้รับบริการมาให้
   * (โมเดลสมาชิก=patient: ถ้าสมาชิกมีโปรไฟล์/ข้อมูลเดิมอยู่แล้วจะไม่เจอ error นี้เลย)
   */
  PATIENT_NAME_REQUIRED: 'PATIENT_NAME_REQUIRED',
  /**
   * PYG-516 — คนจองส่งชื่อผู้รับบริการมาเอง ทั้งที่จองแทนสมาชิกในกลุ่ม
   *
   * ชื่อ-นามสกุลเป็น "ตัวตน" ของเจ้าของบัญชี คนอื่นตั้งชื่อแทนไม่ได้
   * (ฟีดแบ็กอาจารย์ Sprint 9 ข้อ 6 → PYG-495)
   */
  PATIENT_NAME_NOT_ALLOWED: 'PATIENT_NAME_NOT_ALLOWED',
  /**
   * PYG-516 — สมาชิกที่ถูกจองแทนยังไม่มีชื่อในบัญชีเลย (ทั้ง first/last name และ display name ว่าง)
   * คนจองกรอกชื่อแทนไม่ได้แล้ว → เจ้าตัวต้องผ่าน Onboarding ก่อน (PYG-496)
   */
  MEMBER_NAME_MISSING: 'MEMBER_NAME_MISSING',
  /** ตั้งค่า APP_PUBLIC_BASE_URL ไว้ไม่ครบ ประกอบ URL ของลิงก์ไม่ได้ */
  JOIN_LINK_CONFIG_MISSING: 'JOIN_LINK_CONFIG_MISSING',
  /**
   * PYG-479 — เรียก joinLinkPreview / joinGroupByLink ถี่เกินเพดาน (ต่อผู้ใช้ หรือต่อ IP)
   *
   * ★ ไม่บอกว่าชนเพดานตัวไหน (ผู้ใช้ หรือ IP) — คนที่พยายามหลบการจำกัด
   *   ไม่ควรได้ข้อมูลว่าต้องเปลี่ยนอะไรถึงจะผ่าน บอกแค่ว่าต้องรออีกกี่วินาทีก็พอ
   */
  JOIN_LINK_RATE_LIMITED: 'JOIN_LINK_RATE_LIMITED',

  // ── PYG-421 — ฟีดกิจกรรม ───────────────────────────────────────────────
  /**
   * cursor ที่ส่งมาใน after ไม่ใช่ค่าที่เราเคยออกให้ (decode ไม่ออก / รูปทรงผิด)
   *
   * ★ เป็น error ไม่ใช่ "เริ่มจากหน้าแรกให้เงียบ ๆ" โดยตั้งใจ
   *   ถ้า fallback เงียบ ๆ หน้าจอ infinite scroll จะวนซ้ำหน้าแรกไม่รู้จบ
   *   โดยที่ไม่มีใครรู้ว่าเกิดอะไรขึ้น — ล้มดังกว่าให้ FE เห็นตอนพัฒนาเลยดีกว่า
   */
  ACTIVITY_CURSOR_INVALID: 'ACTIVITY_CURSOR_INVALID',
} as const;

export type FgErrorCode = (typeof FG_ERROR)[keyof typeof FG_ERROR];

/** ฐานร่วมของทุก error ในโมดูล — บังคับให้ทุกตัวมี extensions.code เสมอ */
export class FamilyGroupError extends GraphQLError {
  constructor(
    message: string,
    code: FgErrorCode,
    extra: Record<string, unknown> = {},
  ) {
    super(message, { extensions: { code, ...extra } });
  }
}

export class GroupNotFoundError extends FamilyGroupError {
  constructor() {
    super('ไม่พบกลุ่มครอบครัวนี้', FG_ERROR.GROUP_NOT_FOUND);
  }
}

export class NotAMemberError extends FamilyGroupError {
  constructor() {
    super('คุณไม่ได้เป็นสมาชิกของกลุ่มนี้', FG_ERROR.NOT_A_MEMBER);
  }
}

export class NotGroupOwnerError extends FamilyGroupError {
  constructor() {
    super(
      'เฉพาะเจ้าของกลุ่มเท่านั้นที่ทำรายการนี้ได้',
      FG_ERROR.NOT_GROUP_OWNER,
    );
  }
}

/**
 * LAST_OWNER — ใช้ทั้งตอน "เจ้าของขอออกเอง" และ "เจ้าของสั่งเตะตัวเอง"
 *
 * เพราะ invariant คือมี OWNER ที่ ACTIVE ได้คนเดียว → เจ้าของคือคนสุดท้ายเสมอ
 * ทางออกมีสองทางเท่านั้น: โอนสิทธิ์ให้คนอื่นก่อน หรือลบกลุ่มทิ้ง
 */
export class LastOwnerError extends FamilyGroupError {
  constructor() {
    super(
      'คุณเป็นเจ้าของกลุ่มคนสุดท้าย กรุณาโอนสิทธิ์ให้สมาชิกคนอื่นก่อน หรือลบกลุ่มทิ้ง',
      FG_ERROR.LAST_OWNER,
    );
  }
}

export class MemberNotFoundError extends FamilyGroupError {
  constructor() {
    super('ไม่พบสมาชิกคนนี้ในกลุ่ม', FG_ERROR.MEMBER_NOT_FOUND);
  }
}

export class AlreadyOwnerError extends FamilyGroupError {
  constructor() {
    super('ผู้ใช้คนนี้เป็นเจ้าของกลุ่มอยู่แล้ว', FG_ERROR.ALREADY_OWNER);
  }
}

/**
 * ชื่อกลุ่มไม่ผ่านกติกา — ส่ง maxLength กลับไปด้วยเพื่อให้ FE
 * โชว์ตัวนับอักษรได้โดยไม่ต้อง hardcode เลข 80 ซ้ำอีกฝั่ง
 */
export class GroupNameInvalidError extends FamilyGroupError {
  constructor(maxLength: number) {
    super(
      `ชื่อกลุ่มต้องไม่เว้นว่าง และยาวไม่เกิน ${maxLength} ตัวอักษร`,
      FG_ERROR.GROUP_NAME_INVALID,
      { maxLength },
    );
  }
}

/**
 * PYG-424 — จองแทนโดยอ้างโปรไฟล์ที่ไม่ได้อยู่ในกลุ่ม
 *
 * ข้อความไม่บอกว่า "ไม่มีโปรไฟล์นี้" หรือ "มีแต่ไม่ได้อยู่ในกลุ่ม" เพราะสองเคสนี้
 * ต้องแยกไม่ออกจากฝั่ง client (ดูเหตุผลที่ FG_ERROR.RECIPIENT_NOT_IN_GROUP)
 */
export class RecipientNotInGroupError extends FamilyGroupError {
  constructor() {
    super(
      'ไม่พบโปรไฟล์ผู้รับบริการนี้ในกลุ่มของคุณ',
      FG_ERROR.RECIPIENT_NOT_IN_GROUP,
    );
  }
}

/**
 * PYG-516 — ส่ง patientName มาตอนจองแทนสมาชิกในกลุ่ม
 *
 * ★ ตอบ error ไม่ใช่ "รับแล้วเงียบ ๆ ไม่ใช้": ถ้าเงียบ FE จะคิดว่าชื่อที่พิมพ์ถูกบันทึกแล้ว
 *   แต่ผู้ดูแลเห็นอีกชื่อหนึ่ง — สับสนกว่าการบอกตรง ๆ ว่าส่งมาไม่ได้
 *   (ทีมเลือกทางนี้ตามข้อเสนอในการ์ด PYG-516)
 */
export class PatientNameNotAllowedError extends FamilyGroupError {
  constructor() {
    super(
      'ชื่อ-นามสกุลผู้รับบริการมาจากบัญชีของสมาชิกเท่านั้น แก้ไขจากหน้าจองไม่ได้',
      FG_ERROR.PATIENT_NAME_NOT_ALLOWED,
    );
  }
}

/** PYG-516 — สมาชิกที่ถูกจองแทนยังไม่มีชื่อในบัญชี (เจ้าตัวต้องผ่าน Onboarding ก่อน) */
export class MemberNameMissingError extends FamilyGroupError {
  constructor() {
    super(
      'สมาชิกคนนี้ยังไม่ได้กรอกชื่อในบัญชี — ขอให้เจ้าตัวกรอกข้อมูลก่อนจึงจะจองแทนได้',
      FG_ERROR.MEMBER_NAME_MISSING,
    );
  }
}

/**
 * PYG-500 — จองแทนสมาชิกที่ยังไม่เคยมีข้อมูล แต่ไม่ได้ส่งชื่อผู้รับบริการมา
 *
 * @deprecated PYG-516 — ไม่มีโค้ดโยนแล้ว: คนจองส่งชื่อไม่ได้อีก ชื่อมาจากบัญชีเสมอ
 *   กรณีที่เคยตกมาที่นี่ตอนนี้ได้ MemberNameMissingError แทน
 *   คงคลาสกับ code ไว้ให้ FE รุ่นเก่าที่ยัง map code นี้อยู่ไม่พัง
 * (ปกติ FE จะบังคับกรอกชื่อในฟอร์ม "กรอกข้อมูลให้สมาชิก" อยู่แล้ว — เป็นด่านกันพลาดฝั่ง BE)
 */
export class PatientNameRequiredError extends FamilyGroupError {
  constructor() {
    super(
      'กรุณากรอกชื่อผู้รับบริการ เนื่องจากสมาชิกคนนี้ยังไม่มีข้อมูลในระบบ',
      FG_ERROR.PATIENT_NAME_REQUIRED,
    );
  }
}

/** PYG-385 — เฉพาะเจ้าของโปรไฟล์เท่านั้นที่แก้ไข/นำออกได้ (สมาชิกอื่นแก้ของคนอื่นไม่ได้) */
export class RecipientNotOwnerError extends FamilyGroupError {
  constructor() {
    super(
      'แก้ไขหรือนำออกได้เฉพาะโปรไฟล์ที่คุณเป็นคนเพิ่มเท่านั้น',
      FG_ERROR.RECIPIENT_NOT_OWNER,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  PYG-416 · SCR-FG2-001 — ลิงก์เข้าร่วมกลุ่ม
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ★ ข้อความของสาม error นี้ตั้งใจให้ "ต่างกันพอให้ผู้ใช้รู้ว่าต้องทำอะไรต่อ"
 *   แต่ทั้งสามตัวโผล่เฉพาะกับคนที่ถือ token ที่ hash ตรงกับแถวจริงเท่านั้น
 *   คนที่เดา token มั่ว ๆ จะได้ JOIN_LINK_INVALID เสมอ ไม่มีทางแยกออก
 */
export class JoinLinkInvalidError extends FamilyGroupError {
  constructor() {
    super(
      'ลิงก์นี้ใช้ไม่ได้ กรุณาขอลิงก์ใหม่จากเจ้าของกลุ่ม',
      FG_ERROR.JOIN_LINK_INVALID,
    );
  }
}

export class JoinLinkExpiredError extends FamilyGroupError {
  constructor(expiresAt: Date) {
    super(
      'ลิงก์นี้หมดอายุแล้ว กรุณาขอลิงก์ใหม่จากเจ้าของกลุ่ม',
      FG_ERROR.JOIN_LINK_EXPIRED,
      { expiresAt: expiresAt.toISOString() },
    );
  }
}

export class JoinLinkRevokedError extends FamilyGroupError {
  constructor() {
    super(
      'ลิงก์นี้ถูกยกเลิกไปแล้ว กรุณาขอลิงก์ใหม่จากเจ้าของกลุ่ม',
      FG_ERROR.JOIN_LINK_REVOKED,
    );
  }
}

/**
 * โควตาเต็ม — ส่ง maxUses กลับไปด้วยเพื่อให้ FE บอกผู้ใช้ได้ว่าเต็มที่เท่าไหร่
 * โดยไม่ต้อง hardcode เลขซ้ำอีกฝั่ง (แพตเทิร์นเดียวกับ GroupNameInvalidError)
 */
export class JoinLinkExhaustedError extends FamilyGroupError {
  constructor(maxUses: number) {
    super(
      'ลิงก์นี้ถูกใช้ครบจำนวนแล้ว กรุณาขอลิงก์ใหม่จากเจ้าของกลุ่ม',
      FG_ERROR.JOIN_LINK_EXHAUSTED,
      { maxUses },
    );
  }
}

export class GroupMemberLimitReachedError extends FamilyGroupError {
  constructor(maxMembers: number) {
    super(
      `กลุ่มนี้มีสมาชิกครบ ${maxMembers} คนแล้ว`,
      FG_ERROR.GROUP_MEMBER_LIMIT_REACHED,
      { maxMembers },
    );
  }
}

/**
 * กลุ่มยังไม่มีลิงก์ ACTIVE — code เดียวกันเสมอ ต่างกันแค่ "ข้อความ" ตามคนที่เรียก
 *
 * ★ PYG-478 (Amendment 1 · B10): สมาชิกธรรมดาเปิดดูลิงก์ได้แล้ว แต่ "สร้างลิงก์" ไม่ได้
 *   ถ้าส่งข้อความเดิม "กรุณากดสร้างลิงก์ก่อน" ไปให้สมาชิก = บอกให้เขาทำสิ่งที่ระบบ
 *   จะปฏิเสธด้วย NOT_GROUP_OWNER ทันที → สมาชิกต้องได้ข้อความ "ให้ไปขอเจ้าของกลุ่ม" แทน
 *
 * @param askOwner true  = ผู้เรียกเป็นสมาชิกธรรมดา → บอกให้ไปขอเจ้าของกลุ่มสร้างลิงก์
 *                 false = ผู้เรียกเป็นเจ้าของ (ค่าเดิม) → บอกให้กดสร้างลิงก์เอง
 *                 ค่า default เป็น false เพื่อให้จุดที่เรียกอยู่เดิม (revokeJoinLink ที่
 *                 เจ้าของเท่านั้นเรียกได้) ได้ข้อความเหมือนเดิมทุกตัวอักษร
 */
export class JoinLinkNotFoundError extends FamilyGroupError {
  constructor(askOwner = false) {
    super(
      askOwner
        ? 'กลุ่มนี้ยังไม่มีลิงก์เข้าร่วม กรุณาขอให้เจ้าของกลุ่มสร้างลิงก์'
        : 'กลุ่มนี้ยังไม่มีลิงก์เข้าร่วม กรุณากดสร้างลิงก์ก่อน',
      FG_ERROR.JOIN_LINK_NOT_FOUND,
    );
  }
}

/**
 * ตั้งค่า env ไม่ครบ — เป็นความผิดของฝั่ง deploy ไม่ใช่ของผู้ใช้
 * ข้อความจึงไม่บอกชื่อ env ออกไป (คนนอกไม่ต้องรู้โครงสร้าง config ของเรา)
 * ชื่อจริงอยู่ใน log ของเซิร์ฟเวอร์แทน
 */
export class JoinLinkConfigMissingError extends FamilyGroupError {
  constructor() {
    super(
      'ระบบยังตั้งค่าลิงก์เข้าร่วมกลุ่มไม่ครบ กรุณาแจ้งผู้ดูแลระบบ',
      FG_ERROR.JOIN_LINK_CONFIG_MISSING,
    );
  }
}

/**
 * PYG-479 — เรียกลิงก์เข้าร่วมถี่เกินไป
 *
 * ส่ง retryAfterSeconds กลับไปด้วย เพื่อให้ FE นับถอยหลัง / ปิดปุ่มชั่วคราวได้
 * โดยไม่ต้องเดาเวลาเอง (แพตเทิร์นเดียวกับ maxUses ของ JoinLinkExhaustedError)
 *
 * ★ ตอบเป็น GraphQL error ปกติ (HTTP 200 + extensions.code) ไม่ใช่ HTTP 429
 *   เพราะ error อื่นทุกตัวของโมดูลนี้เป็นแบบนี้ และ FE อ่าน extensions.code อยู่แล้ว
 *   (AC ของการ์ด: "error รูปแบบเดียวกับ error อื่นของ family group ไม่ใช่ 500")
 */
export class JoinLinkRateLimitedError extends FamilyGroupError {
  constructor(retryAfterSeconds: number) {
    super(
      `มีการเปิดหรือเข้าร่วมลิงก์กลุ่มถี่เกินไป กรุณารอ ${retryAfterSeconds} วินาทีแล้วลองใหม่`,
      FG_ERROR.JOIN_LINK_RATE_LIMITED,
      { retryAfterSeconds },
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  PYG-421 — ฟีดกิจกรรม
// ═══════════════════════════════════════════════════════════════════════════

/**
 * cursor พัง — ไม่แนบค่าที่ส่งมากลับไปใน extensions
 *
 * ค่าที่ client ส่งมาอาจเป็นอะไรก็ได้ ถ้าสะท้อนกลับไปตรง ๆ มันจะไปโผล่ใน
 * error log และหน้าจอ error ของ FE = ช่องทาง XSS/log injection ฟรี ๆ
 * โดยที่ไม่ได้ช่วย debug อะไรเลย (cursor ที่ผิดก็คือผิด ดูค่าแล้วก็ทำอะไรต่อไม่ได้)
 */
export class ActivityCursorInvalidError extends FamilyGroupError {
  constructor() {
    super(
      'ตำแหน่งหน้าที่ขอมาไม่ถูกต้อง กรุณาโหลดฟีดใหม่อีกครั้ง',
      FG_ERROR.ACTIVITY_CURSOR_INVALID,
    );
  }
}
