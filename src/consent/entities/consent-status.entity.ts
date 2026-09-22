/**
 * GraphQL type ของสถานะความยินยอมของผู้ใช้ — PYG-474
 *
 * หนึ่งตัว = หนึ่งข้อ (terms_of_service / privacy_policy / marketing / ...)
 * ค่ามาจาก "แถวล่าสุด" ของข้อนั้นใน user_consents (ตาราง append-only)
 *
 * ★ ใช้คู่กับ query `consentPolicy` เสมอ — type นี้ไม่มีข้อความ label/คำอธิบาย
 *   FE เอา `type` ไปจับคู่กับ `consentPolicy.items[].type` เพื่อแสดงข้อความ
 *   (ข้อความอยู่ที่ BE ที่เดียว ไม่ต้องส่งซ้ำ)
 *
 * ★ policyVersion / answeredAt / source เป็น nullable ตั้งแต่แรก เผื่อหน้า "ความยินยอมของฉัน"
 *   (PYG-540) ที่ต้องแสดงข้อที่ผู้ใช้ยังไม่เคยตอบด้วย — ตอนนี้ (PYG-474) ทุกตัวที่คืนมามีค่าครบ
 */
import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType({ description: 'สถานะความยินยอมล่าสุดของผู้ใช้ต่อหนึ่งข้อ' })
export class ConsentStatus {
  @Field({ description: 'ชนิดความยินยอม — ตรงกับ consentPolicy.items[].type' })
  type!: string;

  @Field({ description: 'true = ยินยอมอยู่ (แถวล่าสุด granted = true)' })
  granted!: boolean;

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
}
