/* eslint-disable @typescript-eslint/no-unsafe-call */
/**
 * @ValidThaiId() — Custom validator สำหรับเลขบัตรประชาชนไทย 13 หลัก
 *
 * ตรวจสอบ 2 ระดับ:
 * 1. Format: ต้องเป็นตัวเลข 13 หลักเท่านั้น
 * 2. Check digit: หลักที่ 13 ต้องถูกต้องตาม algorithm ของกรมการปกครอง
 *
 * วิธีคำนวณ check digit (หลักที่ 13):
 * - เอาหลักที่ 1-12 มาคูณกับ 13, 12, 11, ..., 2 ตามลำดับ
 * - รวมผลคูณทั้งหมด
 * - เอา 11 ลบ (ผลรวม mod 11)
 * - เอาผลลัพธ์ mod 10 → ได้ check digit
 * - ถ้า check digit == หลักที่ 13 → valid
 *
 * ตัวอย่าง:
 * - "1100600123456" → ต้องคำนวณว่าหลักสุดท้ายถูกไหม
 * - "0000000000000" → format ถูก แต่ check digit อาจไม่ผ่าน
 *
 * วิธีใช้ใน DTO:
 * @ValidThaiId({ message: 'เลขบัตรประชาชนไม่ถูกต้อง' })
 * idCardNumber!: string;
 */
import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'validThaiId', async: false })
export class ValidThaiIdConstraint implements ValidatorConstraintInterface {
  /**
   * validate — ฟังก์ชันหลักที่ class-validator เรียก
   *
   * @param value - ค่าที่ client ส่งมา (ควรเป็น string 13 หลัก)
   * @returns true ถ้า valid, false ถ้า invalid
   */
  validate(value: unknown): boolean {
    // ต้องเป็น string
    if (typeof value !== 'string') return false;

    // ต้องเป็นตัวเลข 13 หลักเท่านั้น
    if (!/^[0-9]{13}$/.test(value)) return false;

    // ── คำนวณ check digit ──
    // หลักที่ 1-12 คูณกับ weight 13, 12, 11, ..., 2
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      sum += parseInt(value[i], 10) * (13 - i);
    }

    // check digit = (11 - (sum % 11)) % 10
    const checkDigit = (11 - (sum % 11)) % 10;

    // เปรียบเทียบกับหลักที่ 13
    return checkDigit === parseInt(value[12], 10);
  }

  /** ข้อความ error default ถ้าไม่ได้กำหนด message */
  defaultMessage(): string {
    return 'เลขบัตรประชาชนไม่ถูกต้อง (Thai ID must be 13 valid digits)';
  }
}

/**
 * @ValidThaiId() — ใช้เป็น decorator บน property ใน DTO
 *
 * ตัวอย่าง:
 * ```typescript
 * @ValidThaiId({ message: 'กรุณากรอกเลขบัตรประชาชนให้ถูกต้อง' })
 * idCardNumber!: string;
 * ```
 */
export function ValidThaiId(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: ValidThaiIdConstraint,
    });
  };
}
