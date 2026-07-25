/**
 * PayoutAccountInput — DTO บัญชีธนาคารรับเงินของ caregiver (PYG-266)
 *
 * ใช้ทั้งเป็น nested field ของ KycInput (ตอน submit/resubmit KYC) และเป็น
 * input ของ updatePayoutAccount mutation (caregiver ที่ verified แล้วแก้บัญชีเอง)
 *
 * all-or-nothing: ถ้าจะแตะบัญชีนี้เลย ต้องกรอกครบทั้ง 3 field เสมอ (เลขบัญชี
 * เข้ารหัสแล้วไม่มีทาง decrypt กลับมา prefill ให้แก้บางส่วนได้)
 */
import { Field, InputType } from '@nestjs/graphql';
import { IsIn, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { OMISE_BANK_CODES } from '../../../common/constants/omise-banks.constant';

@InputType()
export class PayoutAccountInput {
  /** bank code ของ Omise (bank_account.brand) เช่น 'kbank', 'scb' */
  @Field({ description: 'Omise bank code (e.g. kbank, scb, bbl)' })
  @IsString({ message: 'ธนาคารต้องเป็นข้อความ' })
  @IsIn(OMISE_BANK_CODES, { message: 'ธนาคารที่เลือกไม่รองรับ' })
  bankCode!: string;

  /** เลขบัญชีธนาคารไทย — 10 หลักพอดี */
  @Field({ description: 'Bank account number (10 digits, Thai bank accounts)' })
  @IsString({ message: 'เลขบัญชีต้องเป็นข้อความ' })
  @Matches(/^\d{10}$/, { message: 'เลขบัญชีต้องเป็นตัวเลข 10 หลัก' })
  accountNumber!: string;

  /** ชื่อบัญชี — ต้องตรงกับชื่อ-นามสกุลตามบัตรประชาชนของ caregiver (บังคับใน KycService) */
  @Field({ description: 'Account holder name' })
  @IsString({ message: 'ชื่อบัญชีต้องเป็นข้อความ' })
  @MinLength(2, { message: 'ชื่อบัญชีต้องมีอย่างน้อย 2 ตัวอักษร' })
  @MaxLength(100, { message: 'ชื่อบัญชีต้องไม่เกิน 100 ตัวอักษร' })
  accountName!: string;
}
