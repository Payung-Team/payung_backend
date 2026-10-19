/**
 * PayoutAccountInput — DTO บัญชีธนาคารรับเงินของ caregiver (PYG-307)
 *
 * ใช้ทั้งเป็น nested field ของ KycInput (ตอน submit/resubmit KYC) และเป็น
 * input ของ updatePayoutAccount mutation (caregiver ที่ verified แล้วแก้บัญชีเอง)
 *
 * all-or-nothing: ถ้าจะแตะบัญชีนี้เลย ต้องกรอกครบทั้ง 3 field เสมอ (เลขบัญชี
 * เข้ารหัสแล้วไม่มีทาง decrypt กลับมา prefill ให้แก้บางส่วนได้)
 *
 * ⚠️ ความยาวเลขบัญชีตรวจสองชั้น:
 *   ชั้นนี้ = ช่วงกว้าง 10–15 หลัก (กฎที่ใช้ได้กับทุกธนาคาร)
 *   ชั้นที่สอง = validateAccountNumberForBank() ใน KycService ซึ่งรู้ว่าเลือกธนาคารไหน
 *   แยกสองชั้นเพราะ class-validator ตรวจทีละ field ไม่เห็น bankCode ตอนตรวจ accountNumber
 */
import { Field, InputType } from '@nestjs/graphql';
import { Transform } from 'class-transformer';
import { IsIn, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import {
  OMISE_BANK_CODES,
  PAYOUT_ACCOUNT_DIGITS_MAX,
  PAYOUT_ACCOUNT_DIGITS_MIN,
  normalizeAccountNumber,
} from '../../../common/constants/omise-banks.constant';

@InputType()
export class PayoutAccountInput {
  /** bank code ของ Omise (bank_account.brand) เช่น 'kbank', 'scb' */
  @Field({ description: 'Omise bank code — ดึงรายการจาก query payoutBankOptions' })
  @IsString({ message: 'ธนาคารต้องเป็นข้อความ' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsIn(OMISE_BANK_CODES, { message: 'ธนาคารที่เลือกไม่รองรับ' })
  bankCode!: string;

  /**
   * เลขบัญชีธนาคาร — strip ทุกอย่างที่ไม่ใช่ตัวเลขก่อนตรวจเสมอ
   * ผู้ใช้ copy จากแอปธนาคารมามักติดขีด/เว้นวรรค เช่น "123-4-56789-0"
   */
  @Field({
    description: `Bank account number — ตัวเลขเท่านั้น ${PAYOUT_ACCOUNT_DIGITS_MIN}–${PAYOUT_ACCOUNT_DIGITS_MAX} หลัก (กฎเฉพาะธนาคารดูที่ payoutBankOptions)`,
  })
  @IsString({ message: 'เลขบัญชีต้องเป็นข้อความ' })
  @Transform(({ value }) =>
    typeof value === 'string' ? normalizeAccountNumber(value) : value,
  )
  @Matches(/^\d+$/, { message: 'เลขบัญชีต้องเป็นตัวเลขเท่านั้น' })
  @MinLength(PAYOUT_ACCOUNT_DIGITS_MIN, {
    message: `เลขบัญชีต้องมีอย่างน้อย ${PAYOUT_ACCOUNT_DIGITS_MIN} หลัก`,
  })
  @MaxLength(PAYOUT_ACCOUNT_DIGITS_MAX, {
    message: `เลขบัญชีต้องไม่เกิน ${PAYOUT_ACCOUNT_DIGITS_MAX} หลัก`,
  })
  accountNumber!: string;

  /** ชื่อบัญชี — ควรตรงกับชื่อในบัตรประชาชนของ caregiver */
  @Field({ description: 'Account holder name' })
  @IsString({ message: 'ชื่อบัญชีต้องเป็นข้อความ' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(2, { message: 'ชื่อบัญชีต้องมีอย่างน้อย 2 ตัวอักษร' })
  @MaxLength(100, { message: 'ชื่อบัญชีต้องไม่เกิน 100 ตัวอักษร' })
  accountName!: string;
}
