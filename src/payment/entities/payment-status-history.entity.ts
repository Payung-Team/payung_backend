/**
 * PaymentStatusHistory Entity — GraphQL type ของ 1 แถวใน audit trail (PYG-277)
 *
 * ไฟล์นี้บอก GraphQL ว่า "ประวัติการเปลี่ยนสถานะ payment 1 รายการ" หน้าตาเป็นยังไง
 * client (เช่นหน้า admin ดูไทม์ไลน์ payment) จะ query field ตามที่กำหนดที่นี่
 *
 * @ObjectType() = output type (ข้อมูลที่ส่งกลับ client)
 */
import { ObjectType, Field, ID } from '@nestjs/graphql';
import { PaymentStatus } from './payment-status.enum';

@ObjectType()
export class PaymentStatusHistory {
  /** UUID ของแถว history */
  @Field(() => ID)
  id!: string;

  /** payment ที่ history นี้สังกัด */
  @Field({ description: 'Payment ID ที่ประวัตินี้สังกัด' })
  paymentId!: string;

  /**
   * สถานะก่อนหน้า — null ถ้าเป็นแถวแรกตอนสร้าง payment (ยังไม่มีสถานะเดิม)
   */
  @Field(() => PaymentStatus, {
    nullable: true,
    description: 'สถานะก่อนเปลี่ยน (null = แถวแรกตอนสร้าง payment)',
  })
  fromStatus?: PaymentStatus;

  /** สถานะปลายทาง — มีเสมอ */
  @Field(() => PaymentStatus, { description: 'สถานะหลังเปลี่ยน' })
  toStatus!: PaymentStatus;

  /** user ที่สั่งเปลี่ยน — null ถ้าระบบ/cron เป็นผู้เปลี่ยน */
  @Field({ nullable: true, description: 'User ID ผู้สั่งเปลี่ยน (null = ระบบ/cron)' })
  changedBy?: string;

  /** เหตุผลของการเปลี่ยน (ถ้ามี) */
  @Field({ nullable: true, description: 'เหตุผลของการเปลี่ยนสถานะ' })
  reason?: string;

  /**
   * metadata เสริม — serialize เป็น JSON string ก่อนส่ง client
   * (ยังไม่มี graphql-type-json ใน deps — ตามแนวเดียวกับ Notification.data)
   * ตัวอย่าง: '{"omiseChargeId":"chrg_xxx","refundAmount":1140}'
   */
  @Field(() => String, {
    nullable: true,
    description: 'metadata แบบ JSON-stringified (optional)',
  })
  metadata?: string;

  /** เวลาที่บันทึก history นี้ */
  @Field({ description: 'เวลาที่เกิดการเปลี่ยนสถานะ' })
  createdAt!: Date;
}
