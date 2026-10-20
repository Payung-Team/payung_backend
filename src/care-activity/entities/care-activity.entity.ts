/**
 * กิจกรรมการดูแล (PYG-634 · S15 · contract PYG-632)
 *
 * CareActivity        = รายการกลางในตาราง care_activities (แอดมินจัดการ / หน้าจองเลือก)
 * BookingActivity     = กิจกรรมที่ booking เลือก — "สำเนา" ชื่อ หมวด ระดับ ณ ตอนจอง (booking_activities · R6)
 */
import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { CareLevel } from '../../common/care-level/care-level';

@ObjectType({ description: 'Central care activity (care_activities)' })
export class CareActivity {
  @Field(() => ID)
  id!: string;

  @Field(() => String, {
    nullable: true,
    description: 'T-01 code (A01…) · null for admin-added activities',
  })
  code!: string | null;

  @Field()
  nameTh!: string;

  @Field(() => String, { nullable: true })
  nameEn!: string | null;

  @Field()
  category!: string;

  @Field(() => CareLevel)
  careLevel!: CareLevel;

  @Field()
  isActive!: boolean;

  @Field(() => Int)
  sortOrder!: number;

  @Field()
  updatedAt!: Date;
}

@ObjectType({
  description:
    'Activity chosen for a booking — snapshot at booking time (does not follow later edits)',
})
export class BookingActivity {
  @Field(() => ID)
  activityId!: string;

  @Field({ description: 'Thai name at booking time' })
  name!: string;

  @Field()
  category!: string;

  @Field(() => CareLevel)
  careLevel!: CareLevel;
}
