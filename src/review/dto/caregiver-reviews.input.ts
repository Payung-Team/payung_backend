import { Field, ID, InputType, Int } from '@nestjs/graphql';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * CaregiverReviewsInput — พารามิเตอร์สำหรับดึงรายการรีวิวของ caregiver 1 คน
 * (รองรับ pagination แบบเดียวกับ search/booking history)
 */
@InputType()
export class CaregiverReviewsInput {
  @Field(() => ID, { description: 'caregiver.id ที่ต้องการดูรีวิว' })
  @IsString()
  caregiverId: string;

  @Field(() => Int, { nullable: true, defaultValue: 1, description: 'เลขหน้า (เริ่มที่ 1)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @Field(() => Int, { nullable: true, defaultValue: 10, description: 'จำนวนต่อหน้า (สูงสุด 50)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
