import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';
import { TransactionType } from '../entities/transaction-type.enum';

/**
 * PYG-333 — GraphQL types สำหรับ admin transactions (read-only)
 *
 * "transaction" คือ view รวมของ payments + payouts (refund = payment ที่สถานะ refunded)
 * status ประกาศเป็น String (ไม่ใช่ enum) เพราะรวม 2 ชุดสถานะ:
 *   payment_status_enum (pending/held/captured/...) และ payout status (text อิสระ)
 */

/** ข้อมูลย่อของคู่กรณี (patient สำหรับ payment/refund, caregiver สำหรับ payout) */
@ObjectType()
export class TransactionParty {
  @Field(() => ID) id: string;
  @Field({ nullable: true }) displayName?: string;
  @Field() email: string;
}

/** 1 แถวในตาราง transactions ของ admin */
@ObjectType()
export class TransactionSummary {
  // composite id เช่น "payment:<uuid>" / "payout:<uuid>" (ใช้ query detail ต่อ)
  @Field(() => ID) id: string;

  @Field(() => TransactionType) type: TransactionType;

  // สถานะดิบจากตารางต้นทาง (payment status หรือ payout status)
  @Field() status: string;

  @Field(() => Float) amount: number;
  @Field() currency: string;

  @Field(() => ID) bookingId: string;

  // ช่องทาง: payment = credit_card/promptpay/... ; payout = omise_transfer
  @Field({ nullable: true }) method?: string;

  // คู่กรณีหลักของรายการ (payer สำหรับ payment/refund, payee สำหรับ payout)
  @Field(() => TransactionParty) counterparty: TransactionParty;

  @Field() createdAt: Date;
}

/**
 * TransactionSummaryConnection — ผล paginated ของ adminTransactions
 * รูปแบบเดียวกับ connection อื่นในโปรเจกต์ (nodes + meta)
 */
@ObjectType()
export class TransactionSummaryConnection {
  @Field(() => [TransactionSummary]) nodes: TransactionSummary[];
  @Field(() => Int) totalCount: number;
  @Field(() => Int) page: number;
  @Field(() => Int) limit: number;
  @Field() hasNextPage: boolean;
}

/**
 * TransactionTotals — ผลรวม aggregate ตาม filter เดียวกับ list (PYG-333 endpoint #2)
 * ให้ admin เห็นภาพรวมเงินเข้า/ออก/คืน ในชุดข้อมูลที่กำลังดู
 */
@ObjectType()
export class TransactionTotals {
  @Field(() => Int) totalCount: number;

  @Field(() => Int) paymentCount: number;
  @Field(() => Int) payoutCount: number;
  @Field(() => Int) refundCount: number;

  @Field(() => Float) totalPaymentAmount: number;
  @Field(() => Float) totalPayoutAmount: number;
  @Field(() => Float) totalRefundAmount: number;

  // เงินสุทธิที่ platform ถือ = เงินเข้า − เงินคืน − เงินจ่ายออก
  @Field(() => Float) netAmount: number;

  @Field() currency: string;
}

/** 1 event ใน timeline ของ transaction (มาจาก payment/payout status history) */
@ObjectType()
export class TransactionTimelineEntry {
  @Field({ nullable: true }) fromStatus?: string;
  @Field() toStatus: string;
  // user id ที่เปลี่ยนสถานะ (null = ระบบ/worker)
  @Field(() => ID, { nullable: true }) changedBy?: string;
  @Field({ nullable: true }) reason?: string;
  @Field() createdAt: Date;
}

/** ลิงก์ไปยัง entity ที่เกี่ยวข้อง เพื่อให้ admin กระโดดดูต่อได้ */
@ObjectType()
export class TransactionRelatedLinks {
  @Field(() => ID) bookingId: string;
  @Field(() => ID, { nullable: true }) paymentId?: string;
  @Field(() => ID, { nullable: true }) payoutId?: string;
  @Field(() => ID, { nullable: true }) patientId?: string;
  // caregiver user id (ให้ตรงกันทั้ง payment/payout)
  @Field(() => ID, { nullable: true }) caregiverId?: string;
}

/**
 * TransactionDetail — endpoint #3: รายละเอียด + timeline + related links
 * ต่อยอดจาก TransactionSummary (ใช้ field ชุดเดียวกัน) แล้วเพิ่ม timeline/relatedLinks
 */
@ObjectType()
export class TransactionDetail extends TransactionSummary {
  @Field(() => [TransactionTimelineEntry]) timeline: TransactionTimelineEntry[];
  @Field(() => TransactionRelatedLinks) relatedLinks: TransactionRelatedLinks;
}
