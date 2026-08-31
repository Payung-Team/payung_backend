import { InputType, Field } from '@nestjs/graphql';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

@InputType()
export class RejectionReasonItem {
  @Field({ description: 'Short title e.g. "เอกสารไม่ชัดเจน", "ข้อมูลไม่ตรงกัน"' })
  @IsString()
  @IsNotEmpty({ message: 'แต่ละเหตุผลต้องมีหัวข้อ' })
  title: string;

  @Field({ nullable: true, description: 'Free-text detail for the caregiver' })
  @IsOptional()
  @IsString()
  detail?: string;

  @Field({ nullable: true, description: 'Which document: id_card_photo, id_card_number, etc.' })
  @IsOptional()
  @IsString()
  documentType?: string;
}
