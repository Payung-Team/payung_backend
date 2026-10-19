/**
 * GraphQL type ของสถานะความยินยอมของผู้ใช้ — PYG-474 · PYG-540
 *
 * หนึ่งตัว = หนึ่งข้อ (terms_of_service / privacy_policy / marketing / ...)
 * ค่ามาจาก "แถวล่าสุด" ของข้อนั้นใน user_consents (ตาราง append-only)
 *
 * ★ ใช้คู่กับ query `consentPolicy` เสมอ — type นี้ไม่มีข้อความ label/คำอธิบาย
 *   FE เอา `type` ไปจับคู่กับ `consentPolicy.items[].type` เพื่อแสดงข้อความ
 *   (ข้อความอยู่ที่ BE ที่เดียว ไม่ต้องส่งซ้ำ)
 *
 * ★ PYG-540: `myConsents` คืน "ทุกข้อที่เกี่ยวกับ role" รวมข้อที่ยังไม่เคยตอบ
 *   (answered = false → policyVersion / answeredAt / source เป็น null)
 */
import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType({ description: 'สถานะความยินยอมล่าสุดของผู้ใช้ต่อหนึ่งข้อ' })
export class ConsentStatus {
  @Field({ description: 'ชนิดความยินยอม — ตรงกับ consentPolicy.items[].type' })
  type!: string;

  @Field({
    description:
      'true = ยินยอมอยู่ (แถวล่าสุด granted = true) · ยังไม่เคยตอบถือว่า false',
  })
  granted!: boolean;

  @Field({ description: 'เคยตอบข้อนี้แล้วหรือยัง (PYG-540)' })
  answered!: boolean;

  @Field({ nullable: true, description: 'เวอร์ชันนโยบายของแถวล่าสุด' })
  policyVersion?: string;

  @Field({ nullable: true, description: 'เวลาที่ผู้ใช้กดตอบข้อนี้ครั้งล่าสุด' })
  answeredAt?: Date;

  @Field({
    nullable: true,
    description: 'จุดในแอปที่กดล่าสุด เช่น register / onboarding / settings',
  })
  source?: string;

  /**
   * ★ false = ยินยอมไว้กับนโยบายฉบับเก่า ต้องขอใหม่ (re-consent, PYG-504)
   *   แยกจาก `granted` เพราะ "เคยยินยอม" กับ "ยินยอมฉบับที่บังคับใช้อยู่" เป็นคนละเรื่อง
   */
  @Field({
    description: 'เวอร์ชันของแถวล่าสุดตรงกับนโยบายที่บังคับใช้อยู่หรือไม่',
  })
  isCurrentVersion!: boolean;

  @Field({
    description:
      'ข้อบังคับ — ถอนแล้วจะใช้งานบางส่วนไม่ได้ (FE ต้องเตือนผลที่ตามมาก่อนถอน) (PYG-540)',
  })
  required!: boolean;

  /**
   * ★ false = ถอนผ่านหน้าตั้งค่าไม่ได้ (ข้อกำหนดการใช้บริการ / ประกาศความเป็นส่วนตัว)
   *   FE ไม่ต้องแสดงปุ่มถอน ให้แสดงช่องทางขอลบบัญชีแทน
   */
  @Field({ description: 'ถอนผ่านหน้าตั้งค่าได้หรือไม่ (PYG-540)' })
  withdrawable!: boolean;
}
