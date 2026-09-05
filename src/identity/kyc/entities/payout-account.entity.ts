/**
 * PayoutAccountSummary — PYG-266: ข้อมูลบัญชีธนาคารรับเงินแบบ masked
 *
 * ใช้ร่วมกันทั้ง caregiver-facing (kycStatus query, updatePayoutAccount mutation)
 * และ admin-facing (AdminKycDetailPayload ขยายเพิ่ม hasOmiseRecipient)
 *
 * ไม่มี field accountNumberEnc หรือเลขบัญชีเต็มเด็ดขาด — เห็นได้แค่ accountNumberLast4
 */
import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType({
  description: 'Caregiver payout bank account summary (masked — never the full account number)',
})
export class PayoutAccountSummary {
  @Field() bankCode!: string;
  @Field() accountName!: string;
  @Field() accountNumberLast4!: string;
  @Field() status!: string;
  @Field() recipientStatus!: string;
}
