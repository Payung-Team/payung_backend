import { Field, ObjectType } from '@nestjs/graphql';
import { CareLevel } from '../../common/care-level/care-level';
@ObjectType()
export class BookingLevelBreakdown {
  @Field(() => CareLevel) adl!: CareLevel;
  @Field(() => CareLevel, { nullable: true }) flags!: CareLevel | null;
  @Field(() => CareLevel, { nullable: true }) services!: CareLevel | null;
  @Field(() => Date) calculatedAt!: Date;
}
export interface SavedBookingLevel {
  requiredLevel: CareLevel | null;
  levelBreakdown: BookingLevelBreakdown | null;
}
