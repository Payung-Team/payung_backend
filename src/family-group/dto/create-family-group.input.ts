import { Field, InputType } from '@nestjs/graphql';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';
import {
  GROUP_NAME_MAX_LENGTH,
  GROUP_NAME_MIN_LENGTH,
} from '../family-group.constants';
import { ConsentAnswerInput } from '../../consent/dto/consent-answer.input';

/**
 * ตัดช่องว่างหัวท้ายก่อน validate
 *
 * ★ ลำดับสำคัญมาก: ถ้า trim หลัง validate ชื่อ "   " (ช่องว่าง 3 ตัว) จะผ่าน Length(1,80)
 *   แล้วไปโดนดีบีปฏิเสธด้วย CHECK แทน → client ได้ error ดิบของ Postgres แทนข้อความไทยสวย ๆ
 *   class-transformer รัน @Transform ก่อน class-validator เสมอ จึงใช้ตรงนี้ได้พอดี
 */
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

@InputType()
export class CreateFamilyGroupInput {
  @Field({
    description: 'ชื่อกลุ่ม 1–80 ตัวอักษร (ตัดช่องว่างหัวท้ายให้อัตโนมัติ)',
  })
  @Transform(trim)
  @IsString()
  @Length(GROUP_NAME_MIN_LENGTH, GROUP_NAME_MAX_LENGTH, {
    message: `ชื่อกลุ่มต้องไม่เว้นว่าง และยาวไม่เกิน ${GROUP_NAME_MAX_LENGTH} ตัวอักษร`,
  })
  name: string;

  /**
   * คำตอบความยินยอมจากกล่อง consent ของจุดนี้ (source = family_group)
   * ไม่ส่ง = ไม่บันทึกอะไร (FE ไม่แสดงกล่องเมื่อยินยอมฉบับปัจจุบันไว้แล้ว)
   */
  @Field(() => [ConsentAnswerInput], {
    nullable: true,
    description: 'คำตอบความยินยอม disclose_to_family_group — ไม่บังคับ',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => ConsentAnswerInput)
  consents?: ConsentAnswerInput[];
}
