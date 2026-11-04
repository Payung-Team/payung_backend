import { Field, ID, Int, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class AdminAvailabilitySlot {
  /** 0 = อาทิตย์ … 6 = เสาร์ (ตาม caregiver_availability.day_of_week) */
  @Field(() => Int) dayOfWeek: number;
  /** morning | afternoon | evening */
  @Field() timeSlot: string;
}

@ObjectType()
export class AdminPayoutAccountInfo {
  @Field() bankCode: string;
  @Field() accountName: string;
  /** เลขบัญชี 4 ตัวท้ายเท่านั้น — เลขเต็มเข้ารหัสอยู่ใน DB ไม่ส่งออก */
  @Field() accountNumberLast4: string;
  /** pending | active | ... */
  @Field() status: string;
  /** สถานะฝั่ง Omise: unverified | verified | failed */
  @Field() recipientStatus: string;
  /** true = พร้อมรับโอน (เกณฑ์เดียวกับ evaluatePayoutReadiness) */
  @Field() ready: boolean;
  /** NO_ACCOUNT | PENDING | FAILED เมื่อ ready = false */
  @Field(() => String, { nullable: true }) notReadyReason?: string | null;
  @Field(() => Date, { nullable: true }) verifiedAt?: Date | null;
  @Field() updatedAt: Date;
}

@ObjectType()
export class AdminCaregiverWorkInfo {
  @Field(() => ID) caregiverId: string;
  /** สวิตช์ "พร้อมรับงาน / พักรับงาน" ของผู้ดูแล (caregivers.is_searchable) */
  @Field() isAcceptingJobs: boolean;
  /** basic | intermediate | advanced — null = ยังไม่มีระดับ */
  @Field(() => String, { nullable: true }) careLevel?: string | null;
  @Field(() => Date, { nullable: true }) careLevelSetAt?: Date | null;
  @Field(() => String, { nullable: true }) careLevelSetByName?: string | null;
  @Field(() => [AdminAvailabilitySlot]) availability: AdminAvailabilitySlot[];
  @Field(() => [String]) jobTypes: string[];
  @Field(() => [String]) serviceLocations: string[];
  @Field(() => String, { nullable: true }) serviceAreaProvince?: string | null;
  @Field(() => String, { nullable: true }) serviceAreaDistrict?: string | null;
  /** null = ยังไม่ได้เพิ่มบัญชีรับเงิน */
  @Field(() => AdminPayoutAccountInfo, { nullable: true }) payoutAccount?: AdminPayoutAccountInfo | null;
}
