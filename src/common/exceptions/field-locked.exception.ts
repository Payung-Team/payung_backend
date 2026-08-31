import { GraphQLError } from 'graphql';

/**
 * FieldLockedError (PYG-146)
 *
 * โยน error นี้เมื่อ client พยายามแก้ field ที่ admin "lock" ไว้
 *
 * ทำไมใช้ GraphQLError (ไม่ใช่ ForbiddenException ของ Nest)?
 * - FE ใช้ Apollo Client → อ่าน error จาก `error.extensions` ตรงๆ
 * - ถ้าใช้ GraphQLError + extensions เราคุม shape ได้ 100% ตรงตาม contract
 *
 * Contract กับ FE (ห้ามเปลี่ยน key โดยไม่บอกทีม FE):
 *   {
 *     code: 'FIELD_LOCKED',
 *     lockedFields: ['phone', 'displayName'],  // ชื่อ field แบบ camelCase (ตาม GraphQL input)
 *     lockedBy: 'ชื่อแอดมินที่ lock'
 *   }
 *
 * หมายเหตุ: lockedBy เป็นค่าเดียว (ชื่อ admin ที่ lock field แรกที่ชน)
 * ตาม format ตัวอย่างใน ticket — ไม่ใช่ list
 */
export class FieldLockedError extends GraphQLError {
  constructor(lockedFields: string[], lockedBy: string) {
    super('ไม่สามารถแก้ไขข้อมูลบางรายการได้ เนื่องจากถูกล็อกโดยผู้ดูแลระบบ', {
      extensions: {
        code: 'FIELD_LOCKED',
        lockedFields,
        lockedBy,
      },
    });
  }
}
