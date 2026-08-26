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
