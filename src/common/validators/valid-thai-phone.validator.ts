/* eslint-disable @typescript-eslint/no-unsafe-call */
/**
 * @ValidThaiPhone() — Custom validator สำหรับเบอร์โทรศัพท์ไทย
 *
 * รองรับ format:
 * - 0812345678   (10 หลัก, มือถือ)
 * - 081-234-5678 (มีขีด)
 * - 021234567    (9 หลัก, บ้าน/สำนักงาน กทม.)
 * - 02-123-4567  (มีขีด)
 * - 0531234567   (10 หลัก, ต่างจังหวัด)
 * - 053-123-4567 (มีขีด)
 *
 * กฎ:
 * - ต้องขึ้นต้นด้วย 0
 * - ตามด้วยรหัสพื้นที่ 1-2 หลัก
 * - ตัวเลขที่เหลือ 7 หลัก
 * - ขีด (-) เป็น optional ใส่ตรงไหนก็ได้
 * - รวมตัวเลข (ไม่นับขีด) ต้อง 9-10 หลัก
 *
 * วิธีใช้:
 * @ValidThaiPhone({ message: 'กรุณากรอกเบอร์โทรให้ถูกต้อง' })
 * phone!: string;
 */
import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'validThaiPhone', async: false })
export class ValidThaiPhoneConstraint implements ValidatorConstraintInterface {
  /**
   * validate — ตรวจสอบเบอร์โทรศัพท์ไทย
   *
   * ขั้นตอน:
   * 1. ลบขีดออก → เหลือแต่ตัวเลข
   * 2. เช็ค format: ขึ้นต้น 0 + ตัวเลข 8-9 หลัก (รวม 9-10 หลัก)
   */
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return false;

    // ลบขีดออก เหลือแต่ตัวเลข
    const digitsOnly = value.replace(/-/g, '');

    // ต้องขึ้นต้น 0 + ตัวเลข 8-9 หลัก (รวม 9 หรือ 10 หลัก)
    // 9 หลัก = เบอร์บ้าน กทม. (02-xxx-xxxx)
    // 10 หลัก = มือถือ (08x-xxx-xxxx) หรือต่างจังหวัด (05x-xxx-xxxx)
    return /^0[0-9]{8,9}$/.test(digitsOnly);
  }

  defaultMessage(): string {
    return 'เบอร์โทรศัพท์ไม่ถูกต้อง (Thai phone: 0xx-xxx-xxxx)';
  }
}

/**
 * @ValidThaiPhone() — ใช้เป็น decorator บน property ใน DTO
 */
export function ValidThaiPhone(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: ValidThaiPhoneConstraint,
    });
  };
}
