import { Field, ID, InputType, Int, ObjectType } from '@nestjs/graphql';
import { Allow, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ElderCareGroup } from '../../common/graphql/elder-care-group.enum';

@InputType()
export class CareRecipientAssessmentAnswerInput {
  @Field() @Allow() code!: string;
  // No default: omitted must remain distinct from explicit null.
  @Field(() => Int, { nullable: true }) @Allow() value?: number | null;
}
@InputType()
export class SubmitCareRecipientAssessmentInput {
  @Field(() => ID) @Allow() careRecipientId!: string;
  @Field(() => [CareRecipientAssessmentAnswerInput])
  @ValidateNested({ each: true })
  @Type(() => CareRecipientAssessmentAnswerInput)
  answers!: CareRecipientAssessmentAnswerInput[];
  @Field(() => [String]) @Allow() flags!: string[];
  @Field() @Allow() noSpecialConditions!: boolean;
  @Field(() => Boolean, { nullable: true }) @Allow() dementiaSevere?:
    | boolean
    | null;
}
@ObjectType()
export class CareRecipientAssessmentAnswer {
  @Field() code!: string;
  @Field(() => Int, { nullable: true }) value!: number | null;
}
/** Private: never attach this to public/caregiver/admin projections. */
@ObjectType()
export class CareRecipientAssessment {
  @Field(() => ElderCareGroup) careGroup!: ElderCareGroup;
  @Field(() => ID) careRecipientId!: string;
  @Field(() => [CareRecipientAssessmentAnswer])
  answers!: CareRecipientAssessmentAnswer[];
  @Field(() => Int) adlTotalScore!: number;
  @Field(() => Int) unsureCount!: number;
  @Field(() => [String]) flags!: string[];
  @Field() noSpecialConditions!: boolean;
  @Field() hasUnsureFlag!: boolean;
  @Field(() => Boolean, { nullable: true }) dementiaSevere!: boolean | null;
  @Field(() => Date) assessedAt!: Date;
}
