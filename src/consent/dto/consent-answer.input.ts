/**
 * คำตอบความยินยอมหนึ่งข้อที่ผู้ใช้กดมา (PYG-538)
 */
import { Field, InputType } from '@nestjs/graphql';
import { IsBoolean, IsNotEmpty, IsString, MaxLength } from 'class-validator';

@InputType({ description: 'คำตอบความยินยอมหนึ่งข้อ' })
export class ConsentAnswerInput {
  @Field({ description: 'ค่าจาก consentPolicy.items[].type' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  type!: string;

  @Field({ description: 'true = ยินยอม, false = ไม่ยินยอม' })
  @IsBoolean()
  granted!: boolean;

  /**
   * ★ ต้องเป็นค่าที่ได้จาก `consentPolicy.version` ไม่ใช่ค่าที่ FE ตั้งเอง
   *   BE ตรวจว่าตรงกับเวอร์ชันที่บังคับใช้อยู่ — ถ้าไม่ตรงแปลว่าผู้ใช้อ่านข้อความคนละฉบับ
   *   กับที่ระบบกำลังจะบันทึกว่าเขายินยอม ซึ่งทำให้หลักฐานใช้ไม่ได้
   */
  @Field({ description: 'เวอร์ชันนโยบายที่ผู้ใช้เห็นตอนกด (จาก consentPolicy.version)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  policyVersion!: string;
}
