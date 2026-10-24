/**
 * @ValidAppEmail() — กติกาอีเมลเดียวของระบบ (PYG-707 · QA PYG-706)
 *
 * แทน @IsEmail() ค่า default ที่ยอมภาษาไทย อักขระซ่อน (zero-width) และอักขระพิเศษตาม RFC
 * FE ใช้กติกาเดียวกันที่ src/lib/email.ts (PYG-708) — แก้ที่หนึ่งต้องแก้อีกที่
 *
 * ก่อนตรวจ (normalizeEmail):
 * - ตัดช่องว่างและอักขระซ่อนที่หัว/ท้าย (space, tab, NBSP, BOM, zero-width) — มาจากการ copy-paste
 *   อักขระซ่อนที่อยู่ "ข้างใน" ไม่ตัด → ไม่ผ่าน (เดาไม่ได้ว่าผู้ใช้ตั้งใจพิมพ์อะไร)
 * - แปลงเป็นตัวเล็กทั้งหมด — ตรงกับที่ Supabase Auth เก็บ
 *
 * กฎ (หลัง normalize):
 * - ASCII ที่พิมพ์ได้เท่านั้น — ภาษาไทย / zero-width / อักขระควบคุม ไม่ผ่าน
 * - ส่วนหน้า @ : a-z 0-9 . _ % + -  · 1–64 ตัว · ไม่ขึ้นต้น/ลงท้ายด้วยจุด · ไม่มีจุดติดกัน
 * - domain : อย่างน้อย 2 ส่วนคั่นด้วยจุด · แต่ละส่วน a-z 0-9 - ยาว 1–63 ไม่ขึ้นต้น/ลงท้ายด้วย -
 *            ส่วนสุดท้าย (TLD) เป็นตัวอักษร 2 ตัวขึ้นไป · ไม่รับ IP
 * - ทั้งหมด ≤ 254 ตัว
 *
 * วิธีใช้:
 * @Field()
 * @ValidAppEmail()
 * email!: string;
 */
import { Transform } from 'class-transformer';
import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

export const EMAIL_MAX_LENGTH = 254;
export const EMAIL_LOCAL_MAX_LENGTH = 64;
export const EMAIL_FORMAT_MESSAGE = 'กรุณากรอกอีเมลให้ถูกต้อง';

const LOCAL = '[a-z0-9_%+-]+(?:\\.[a-z0-9_%+-]+)*';
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const EMAIL_PATTERN = new RegExp(`^${LOCAL}@(?:${LABEL}\\.)+[a-z]{2,63}$`);
/** zero-width space/non-joiner/joiner, word joiner, BOM — String.trim() ไม่ตัด U+200B–U+200D, U+2060 */
const EDGE_INVISIBLE =
  /^[\s\u200b-\u200d\u2060\ufeff]+|[\s\u200b-\u200d\u2060\ufeff]+$/g;

/** ตัดช่องว่าง/อักขระซ่อนหัวท้าย + ตัวเล็ก · ค่าที่ไม่ใช่ string คืนตามเดิม (ให้ validator ปฏิเสธ) */
export function normalizeEmail<T>(value: T): T | string {
  return typeof value === 'string'
    ? value.replace(EDGE_INVISIBLE, '').toLowerCase()
    : value;
}

/** ตรวจค่าที่ normalize แล้ว */
export function isAppEmail(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.length > EMAIL_MAX_LENGTH) return false;
  const at = value.indexOf('@');
  if (at < 1 || at > EMAIL_LOCAL_MAX_LENGTH) return false;
  return EMAIL_PATTERN.test(value);
}

@ValidatorConstraint({ name: 'validAppEmail', async: false })
export class ValidAppEmailConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isAppEmail(value);
  }

  defaultMessage(): string {
    return EMAIL_FORMAT_MESSAGE;
  }
}

/**
 * normalize (ต้องเปิด transform: true ใน ValidationPipe — main.ts / configure-app.ts เปิดอยู่) แล้วตรวจ
 * ช่องที่ไม่บังคับ ใส่ @IsOptional() ไว้ก่อน — null/undefined ข้าม แต่ '' ไม่ผ่าน
 */
export function ValidAppEmail(validationOptions?: ValidationOptions) {
  const transform = Transform(({ value }: { value: unknown }) =>
    normalizeEmail(value),
  );
  return function (object: object, propertyName: string) {
    transform(object, propertyName);
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: { message: EMAIL_FORMAT_MESSAGE, ...validationOptions },
      constraints: [],
      validator: ValidAppEmailConstraint,
    });
  };
}
