/**
 * Input / Output ของ flow เบอร์โทร — PYG-603 (contract: docs/pyg601-phone-auth-api-contract.md §4)
 *
 * ★ ชื่อ field และรูปทรงตรงกับที่ FE เขียนไว้แล้วใน payung_frontend/src/graphql/phoneAuth.ts ทุกตัว
 *   ห้ามเปลี่ยนชื่อ field โดยไม่บอกทีม FE
 *
 * ★ ทำไม field ที่เป็นข้อความมีแค่ @IsString() ไม่มี @Length / @Matches
 *   ValidationPipe ของแอปตอบ BAD_REQUEST ก่อนถึง service → FE ได้ code ที่ไม่รู้จัก แทนที่จะได้
 *   PHONE_INVALID_FORMAT / OTP_INVALID ตาม contract (การ์ด PYG-603 อ้าง PYG-415 ที่เคยเจอแบบนี้)
 *   → ตรวจรูปแบบที่ PhoneAuthService แทน · @IsString ต้องมีเพราะ ValidationPipe ตั้ง whitelist +
 *   forbidNonWhitelisted ไว้ field ที่ไม่มี decorator ของ class-validator จะถูกตีกลับว่า "ไม่ควรมี"
 */

import {
  Field,
  InputType,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { ConsentAnswerInput } from '../../../../consent/dto/consent-answer.input';

/** จุดประสงค์ของรหัสยืนยัน */
export enum PhoneOtpPurpose {
  /** สมัครบัญชีใหม่ */
  SIGNUP = 'SIGNUP',
  /** ล็อกอินด้วยเบอร์ที่ยืนยันแล้ว */
  LOGIN = 'LOGIN',
  /** ผูกเบอร์กับบัญชีที่ล็อกอินอยู่ (ต้องส่ง Authorization header) */
  LINK = 'LINK',
}

registerEnumType(PhoneOtpPurpose, {
  name: 'PhoneOtpPurpose',
  description: 'จุดประสงค์ของรหัสยืนยันทาง SMS',
  valuesMap: {
    SIGNUP: { description: 'สมัครบัญชีใหม่ด้วยเบอร์โทร' },
    LOGIN: { description: 'ล็อกอินด้วยเบอร์ที่ยืนยันแล้ว' },
    LINK: {
      description:
        'ผูกเบอร์กับบัญชีที่ล็อกอินอยู่ — ต้องส่ง Authorization: Bearer <token>',
    },
  },
});

// ─── Inputs ──────────────────────────────────────────────────────────────────

@InputType()
export class RequestPhoneOtpInput {
  @Field({
    description:
      'เบอร์มือถือไทย — รับ +66812345678 / 0812345678 / มีขีดหรือช่องว่างได้',
  })
  @IsString()
  phone!: string;

  @Field(() => PhoneOtpPurpose)
  @IsEnum(PhoneOtpPurpose)
  purpose!: PhoneOtpPurpose;
}

@InputType()
export class VerifyPhoneOtpInput {
  @Field()
  @IsString()
  phone!: string;

  @Field({ description: 'รหัสยืนยันจาก SMS' })
  @IsString()
  code!: string;

  /** รับเฉพาะ SIGNUP — LOGIN ใช้ loginWithPhone, LINK ใช้ linkPhone */
  @Field(() => PhoneOtpPurpose, { description: 'ต้องเป็น SIGNUP' })
  @IsEnum(PhoneOtpPurpose)
  purpose!: PhoneOtpPurpose;
}

@InputType()
export class SignUpWithPhoneInput {
  @Field({ description: 'ตั๋วจาก verifyPhoneOtp' })
  @IsString()
  verificationToken!: string;

  /** เหมือน RegisterInput.role — สมัครเป็นแอดมินเองไม่ได้ */
  @Field(() => Int, { description: '1 = ผู้สูงอายุ, 2 = ผู้ดูแล' })
  @IsIn([1, 2], { message: 'Role must be 1 (patient) or 2 (caregiver)' })
  role!: number;

  /**
   * ความยินยอมจากหน้าสมัคร — ชุดเดียวกับ RegisterInput.consents (consentPolicy source: register)
   * nullable ใน GraphQL ด้วยเหตุผลเดียวกับ RegisterInput: ไม่ส่ง = ได้ CONSENT_REQUIRED ที่มี code
   * แทนที่จะโดน GraphQL validation ตีกลับด้วยข้อความอังกฤษที่ไม่มี code
   */
  @Field(() => [ConsentAnswerInput], {
    nullable: true,
    description:
      'ความยินยอมจากหน้าสมัคร (consentPolicy source: register) — ต้องมี terms_of_service ' +
      'และ privacy_policy ที่ granted = true ไม่งั้นสมัครไม่ได้ (CONSENT_REQUIRED)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ConsentAnswerInput)
  consents?: ConsentAnswerInput[];
}

@InputType()
export class LoginWithPhoneInput {
  @Field()
  @IsString()
  phone!: string;

  @Field({ description: 'รหัสยืนยันจาก SMS' })
  @IsString()
  code!: string;
}

@InputType()
export class LinkPhoneInput {
  @Field()
  @IsString()
  phone!: string;

  @Field({ description: 'รหัสยืนยันจาก SMS' })
  @IsString()
  code!: string;
}

// ─── Outputs ─────────────────────────────────────────────────────────────────

/**
 * ผลของการขอรหัส — ★ ไม่มีรหัสอยู่ในนี้ (R10)
 * เวลาเป็น "จำนวนวินาที" ไม่ใช่ timestamp (ข้อเสนอของ FE): นาฬิกาเครื่องผู้ใช้ที่ไม่ตรงกับ server
 * จะทำให้ตัวนับเวลาผิดถ้าส่งเป็นเวลาแบบ timestamp
 */
@ObjectType()
export class PhoneOtpRequestPayload {
  @Field(() => Int, {
    description: 'ขอรหัสใหม่ได้อีกกี่วินาที (นับจากตอนได้ response)',
  })
  resendAfterSeconds!: number;

  @Field(() => Int, { description: 'รหัสหมดอายุในกี่วินาที' })
  expiresInSeconds!: number;
}

@ObjectType()
export class PhoneVerificationPayload {
  @Field({ description: 'ตั๋วสำหรับ signUpWithPhone — ทึบ (opaque) ห้าม log' })
  verificationToken!: string;

  @Field(() => Int, { description: 'ตั๋วหมดอายุในกี่วินาที' })
  expiresInSeconds!: number;
}
