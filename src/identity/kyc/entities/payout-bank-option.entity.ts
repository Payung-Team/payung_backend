/**
 * PayoutBankOption — ตัวเลือกธนาคาร + กฎความยาวเลขบัญชี ที่ FE ดึงไปสร้าง dropdown
 *
 * มีไว้เพื่อไม่ให้รายชื่อธนาคารกับกฎ validate ถูก hardcode ซ้ำสองที่ (TASK 4)
 * source of truth อยู่ที่ src/common/constants/omise-banks.constant.ts ฝั่ง BE เท่านั้น
 */
import { Field, Int, ObjectType } from '@nestjs/graphql';

@ObjectType({
  description: 'ธนาคารที่ใช้เป็นบัญชีรับเงินได้ + กฎความยาวเลขบัญชี (source of truth ฝั่ง BE)',
})
export class PayoutBankOption {
  @Field({ description: 'bank code ที่ต้องส่งกลับมาใน PayoutAccountInput.bankCode' })
  code!: string;

  @Field({ description: 'ชื่อธนาคารภาษาไทย — ใช้แสดงใน dropdown' })
  nameTh!: string;

  @Field({ description: 'ชื่อธนาคารภาษาอังกฤษ' })
  nameEn!: string;

  @Field(() => Int, { description: 'จำนวนหลักต่ำสุดที่ยอมรับ' })
  minDigits!: number;

  @Field(() => Int, { description: 'จำนวนหลักสูงสุดที่ยอมรับ' })
  maxDigits!: number;

  @Field(() => [Int], {
    nullable: true,
    description:
      'ความยาวที่ทีมยืนยันกับธนาคารแล้ว — null = ยังไม่ยืนยัน ให้ใช้ช่วง minDigits–maxDigits แทน',
  })
  exactDigits?: number[] | null;
}
