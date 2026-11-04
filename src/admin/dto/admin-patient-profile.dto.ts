import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class AdminAdlAnswer {
  @Field() code: string;
  /** null = ตอบ "ไม่แน่ใจ" (นับ 0 คะแนน) */
  @Field(() => Int, { nullable: true }) value?: number | null;
}

@ObjectType()
export class AdminRecipientAssessment {
  @Field(() => [AdminAdlAnswer]) answers: AdminAdlAnswer[];
  @Field(() => Int) adlTotalScore: number;
  @Field(() => Int) unsureCount: number;
  @Field(() => [String]) flags: string[];
  @Field() noSpecialConditions: boolean;
  @Field() hasUnsureFlag: boolean;
  @Field(() => Boolean, { nullable: true }) dementiaSevere?: boolean | null;
  /** social | homebound | bedridden */
  @Field(() => String, { nullable: true }) careGroup?: string | null;
  @Field(() => String, { nullable: true }) assessedByName?: string | null;
  @Field() assessedAt: Date;
}

@ObjectType()
export class AdminCareRecipient {
  @Field(() => ID) id: string;
  @Field() name: string;
  @Field(() => String, { nullable: true }) nickname?: string | null;
  @Field() isSelf: boolean;
  @Field(() => Date, { nullable: true }) dateOfBirth?: Date | null;
  @Field(() => String, { nullable: true }) gender?: string | null;
  @Field(() => Float, { nullable: true }) weightKg?: number | null;
  @Field(() => Float, { nullable: true }) heightCm?: number | null;
  @Field(() => String, { nullable: true }) bloodType?: string | null;
  @Field(() => String, { nullable: true }) mobilityLevel?: string | null;
  @Field(() => [String]) medicalConditions: string[];
  @Field(() => String, { nullable: true }) currentMedications?: string | null;
  @Field(() => String, { nullable: true }) allergies?: string | null;
  @Field(() => Boolean, { nullable: true }) hasInfectiousDisease?: boolean | null;
  @Field(() => String, { nullable: true }) emergencyContactName?: string | null;
  @Field(() => String, { nullable: true }) emergencyContactPhone?: string | null;
  @Field(() => String, { nullable: true }) emergencyContactRel?: string | null;
  @Field(() => String, { nullable: true }) preferredHospital?: string | null;
  @Field(() => String, { nullable: true }) careNotes?: string | null;
  /** null = ยังไม่ได้ทำแบบประเมิน ADL */
  @Field(() => AdminRecipientAssessment, { nullable: true }) assessment?: AdminRecipientAssessment | null;
}

@ObjectType()
export class AdminPatientBookingBrief {
  @Field(() => ID) id: string;
  @Field() status: string;
  @Field() bookingDate: Date;
  @Field() serviceType: string;
  @Field(() => Float, { nullable: true }) estimatedCost?: number | null;
  @Field(() => String, { nullable: true }) caregiverName?: string | null;
  @Field(() => String, { nullable: true }) careRecipientName?: string | null;
}

@ObjectType()
export class AdminPatientBookingStats {
  @Field(() => Int) total: number;
  @Field(() => Int) active: number;
  @Field(() => Int) completed: number;
  @Field(() => Int) cancelled: number;
  /** ยอดที่ชำระสำเร็จ (captured / transferred) หักยอดคืนแล้ว */
  @Field(() => Float) totalPaid: number;
}

@ObjectType()
export class AdminPatientProfile {
  @Field(() => ID) id: string;
  @Field() name: string;
  @Field(() => String, { nullable: true }) email?: string | null;
  @Field(() => String, { nullable: true }) phone?: string | null;
  @Field(() => String, { nullable: true }) avatarUrl?: string | null;
  @Field(() => String, { nullable: true }) address?: string | null;
  @Field(() => Int) role: number;
  @Field() isActive: boolean;
  @Field() isSuspended: boolean;
  @Field() createdAt: Date;
  @Field(() => Date, { nullable: true }) lastLoginAt?: Date | null;
  @Field(() => [AdminCareRecipient]) careRecipients: AdminCareRecipient[];
  @Field(() => AdminPatientBookingStats) bookingStats: AdminPatientBookingStats;
  /** 5 รายการล่าสุด (ใหม่ → เก่า) */
  @Field(() => [AdminPatientBookingBrief]) recentBookings: AdminPatientBookingBrief[];
}
