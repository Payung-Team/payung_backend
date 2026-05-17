import { SetMetadata } from '@nestjs/common';

/**
 * @FieldLock decorator (PYG-146)
 *
 * บอก FieldLockGuard ว่า mutation นี้ "แก้ข้อมูลของ entity ชนิดไหน"
 * เพื่อให้ guard รู้ว่าจะไปอ่าน lock จากตาราง field_locks ด้วย entity_type อะไร
 *
 * ทำไมต้องมี decorator แยก (ไม่ hardcode ใน guard)?
 * - guard ตัวเดียวใช้ซ้ำได้กับหลาย mutation (USER / CAREGIVER_PROFILE)
 * - อ่านโค้ดที่ resolver แล้วเห็นชัดว่า mutation นี้ถูกคุมด้วย field-lock
 * - เพิ่ม entity ชนิดใหม่ภายหลังได้โดยไม่ต้องแก้ guard
 *
 * @example
 *   // updateProfile แก้ข้อมูลในตาราง users
 *   @UseGuards(SupabaseAuthGuard, FieldLockGuard)
 *   @FieldLock('USER')
 *   async updateProfile(...) { ... }
 *
 * @example
 *   // updateCaregiverProfile แก้ข้อมูลในตาราง caregivers
 *   @UseGuards(FieldLockGuard)
 *   @FieldLock('CAREGIVER_PROFILE')
 *   async updateCaregiverProfile(...) { ... }
 */

/** key ที่ใช้เก็บ metadata — guard อ่านค่านี้ผ่าน Reflector */
export const FIELD_LOCK_ENTITY_KEY = 'fieldLockEntity';

/**
 * ชนิด entity ที่รองรับการ lock field
 * ต้องตรงกับค่าในคอลัมน์ field_locks.entity_type (ฝั่ง PYG-145 จะเขียนด้วยค่าเดียวกัน)
 */
export type FieldLockEntityType = 'USER' | 'CAREGIVER_PROFILE';

export const FieldLock = (entityType: FieldLockEntityType) =>
  SetMetadata(FIELD_LOCK_ENTITY_KEY, entityType);
