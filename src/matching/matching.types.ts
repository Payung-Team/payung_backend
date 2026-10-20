import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { CareLevel } from '../common/care-level/care-level';
import { CaregiverProfession } from '../identity/kyc/profession.constants';
import { CaregiverSummary } from '../search/dto/search-caregiver.payload';
import { MatchRejectReason } from './matching.evaluate';
registerEnumType(MatchRejectReason, { name: 'MatchRejectReason' });
@ObjectType('MatchRejection')
export class MatchRejectionType {
  @Field(() => MatchRejectReason) reason!: MatchRejectReason;
  @Field({ nullable: true }) skillCode?: string;
}
@ObjectType()
export class MatchChecks {
  @Field() level!: boolean;
  @Field() skills!: boolean;
  @Field() profession!: boolean;
  @Field() evidence!: boolean;
}
@ObjectType()
export class MatchingAdminContact {
  @Field() label!: string;
  @Field() url!: string;
}
@ObjectType()
export class EligibleCaregivers {
  @Field(() => [CaregiverSummary]) caregivers!: CaregiverSummary[];
  @Field(() => String, { nullable: true }) emptyMessage!: string | null;
  @Field(() => MatchingAdminContact, { nullable: true })
  adminContact!: MatchingAdminContact | null;
}
@ObjectType()
export class MatchReportCaregiver {
  @Field(() => ID) id!: string;
  @Field() fullName!: string;
  @Field(() => CaregiverProfession) profession!: CaregiverProfession;
  @Field(() => CareLevel, { nullable: true }) careLevel!: CareLevel | null;
}
@ObjectType()
export class BookingCaregiverMatchResult {
  @Field(() => MatchReportCaregiver) caregiver!: MatchReportCaregiver;
  @Field() passed!: boolean;
  @Field(() => MatchChecks) checks!: MatchChecks;
  @Field(() => [MatchRejectionType]) reasons!: MatchRejectionType[];
}
@ObjectType()
export class BookingMatchReport {
  @Field(() => ID) bookingId!: string;
  @Field(() => Date) evaluatedAt!: Date;
  @Field(() => Date) evidenceReferenceDate!: Date;
  /** AC6 persistence is pending a storage decision; this is explicitly a live evaluation. */
  @Field() persisted!: boolean;
  @Field(() => [BookingCaregiverMatchResult])
  results!: BookingCaregiverMatchResult[];
}
@ObjectType()
export class BookingCaregiverSelection {
  @Field(() => ID) bookingId!: string;
  @Field(() => ID) caregiverId!: string;
  @Field() status!: string;
}
