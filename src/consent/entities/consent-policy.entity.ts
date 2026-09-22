/**
 * GraphQL type ของนโยบายความยินยอม (PYG-472)
 *
 * เป็นข้อมูล "คงที่" ที่มาจากไฟล์ ไม่ใช่จาก DB — เสิร์ฟผ่าน GraphQL เพราะ FE อยู่คนละ repo
 * และข้อความต้องผูกกับ policyVersion เดียวกับที่ BE บันทึกลง user_consents เสมอ
 */
import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType({ description: 'ความยินยอมหนึ่งข้อ พร้อมข้อความ TH/EN' })
export class ConsentItem {
  @Field({ description: 'ค่าที่ต้องส่งกลับมาตอนบันทึก (user_consents.consent_type)' })
  type!: string;

  @Field({ description: 'ข้อความบน checkbox (ไทย)' })
  labelTh!: string;

  @Field({ description: 'ข้อความบน checkbox (อังกฤษ)' })
  labelEn!: string;

  @Field({ description: 'คำอธิบายใต้ checkbox (ไทย)' })
  descriptionTh!: string;

  @Field({ description: 'คำอธิบายใต้ checkbox (อังกฤษ)' })
  descriptionEn!: string;

  @Field({ description: 'ไม่ติ๊กแล้วไปต่อไม่ได้ ณ จุดที่ขอ' })
  required!: boolean;

  /**
   * ★ FE ต้องเคารพค่านี้: true = ข้อมูลอ่อนไหวตาม ม.26
   *   ต้องแสดงแยกกล่องจากข้ออื่น และ **ห้ามติ๊กมาให้ล่วงหน้า**
   *   (กฎหมายต้องการการกระทำโดยชัดแจ้งของผู้ใช้ ไม่ใช่การไม่ยกเลิกค่าเริ่มต้น)
   */
  @Field({ description: 'ข้อมูลอ่อนไหวตาม ม.26 — ต้องแยกกล่องและห้ามติ๊กล่วงหน้า' })
  sensitive!: boolean;
}

@ObjectType({ description: 'หัวข้อและคำนำของกล่อง consent ณ จุดหนึ่ง' })
export class ConsentScreenCopy {
  @Field() titleTh!: string;
  @Field() titleEn!: string;
  @Field() introTh!: string;
  @Field() introEn!: string;
}

@ObjectType({ description: 'นโยบายความยินยอมที่บังคับใช้อยู่' })
export class ConsentPolicy {
  /**
   * ★ ค่านี้ต้องถูกส่งกลับมาพร้อมคำตอบ consent เสมอ — BE บันทึกเวอร์ชันนี้ลง user_consents
   *   ห้าม FE ใส่ค่าเอง ไม่งั้นจะเกิดกรณี "ผู้ใช้เห็นข้อความเวอร์ชันหนึ่ง แต่ระบบบันทึกอีกเวอร์ชัน"
   *   ซึ่งทำให้หลักฐานความยินยอมใช้ไม่ได้
   */
  @Field({ description: 'เวอร์ชันนโยบายที่ต้องบันทึกคู่กับคำตอบ' })
  version!: string;

  @Field({ description: 'วันที่เริ่มใช้เวอร์ชันนี้ (YYYY-MM-DD)' })
  effectiveDate!: string;

  @Field(() => [ConsentItem], { description: 'ความยินยอมที่ต้องขอ ณ จุดที่ร้องขอมา' })
  items!: ConsentItem[];

  @Field(() => ConsentScreenCopy, { nullable: true, description: 'หัวข้อ/คำนำของจุดนั้น' })
  screen?: ConsentScreenCopy;

  @Field({ description: 'ข้อความสิทธิ์เจ้าของข้อมูล (ไทย) — แสดงท้ายกล่องเสมอ' })
  rightsNoteTh!: string;

  @Field({ description: 'ข้อความสิทธิ์เจ้าของข้อมูล (อังกฤษ)' })
  rightsNoteEn!: string;

  @Field({ description: 'ประกาศความเป็นส่วนตัวฉบับเต็ม (ไทย, Markdown)' })
  privacyNoticeTh!: string;

  @Field({ description: 'ประกาศความเป็นส่วนตัวฉบับเต็ม (อังกฤษ, Markdown)' })
  privacyNoticeEn!: string;
}
