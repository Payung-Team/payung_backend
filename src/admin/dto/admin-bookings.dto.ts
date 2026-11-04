import { Field, Float, ID, InputType, Int, ObjectType } from '@nestjs/graphql';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** ค่าที่ bookings.status เขียนได้จริง (TEXT ไม่ใช่ DB enum — ดู BookingStatusEnum) */
export const ADMIN_BOOKING_STATUSES = [
  'unmatched',
  'pending',
  'accepted',
  'confirmed',
  'in_progress',
  'completed',
  'rejected',
  'cancelled',
  'expired',
] as const;

@InputType()
export class AdminBookingsInput {
  @Field({ nullable: true, description: 'กรองตามสถานะ booking (ไม่ระบุ = ทั้งหมด)' })
  @IsOptional()
  @IsIn(ADMIN_BOOKING_STATUSES as unknown as string[])
  status?: string;

  @Field({ nullable: true, description: 'ค้นหาจากรหัส booking / ชื่อผู้จอง / ชื่อผู้ดูแล' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

@ObjectType()
export class AdminBookingRow {
  @Field(() => ID) id: string;
  @Field() status: string;
  @Field() bookingDate: Date;
  @Field() startTime: string;
  @Field(() => Float) durationHours: number;
  @Field() serviceType: string;
  @Field(() => Float, { nullable: true }) estimatedCost?: number | null;
  @Field(() => String, { nullable: true }) paymentStatus?: string | null;
  @Field() disputeStatus: string;
  @Field() createdAt: Date;

  @Field(() => ID) patientId: string;
  @Field() patientName: string;
  @Field(() => String, { nullable: true }) patientPhone?: string | null;

  @Field(() => ID, { nullable: true }) caregiverId?: string | null;
  @Field(() => String, { nullable: true }) caregiverName?: string | null;
  @Field(() => String, { nullable: true }) caregiverNumber?: string | null;
}

@ObjectType()
export class AdminBookingConnection {
  @Field(() => [AdminBookingRow]) nodes: AdminBookingRow[];
  @Field(() => Int) totalCount: number;
  @Field(() => Int) page: number;
  @Field(() => Int) limit: number;
  @Field() hasNextPage: boolean;
}

@ObjectType()
export class AdminBookingStatusChange {
  @Field(() => ID) id: string;
  @Field(() => String, { nullable: true }) fromStatus?: string | null;
  @Field() toStatus: string;
  @Field(() => String, { nullable: true }) reason?: string | null;
  @Field(() => String, { nullable: true }) changedByName?: string | null;
  @Field() createdAt: Date;
}

@ObjectType()
export class AdminBookingPaymentInfo {
  @Field(() => ID) id: string;
  @Field(() => Float) amount: number;
  @Field(() => Float, { nullable: true }) capturedAmount?: number | null;
  @Field(() => Float) refundedAmount: number;
  @Field() paymentMethod: string;
  @Field() paymentStatus: string;
  @Field(() => String, { nullable: true }) omiseChargeId?: string | null;
  @Field(() => String, { nullable: true }) failureMessage?: string | null;
  @Field() createdAt: Date;
}

@ObjectType()
export class AdminBookingRequiredSkill {
  @Field() code: string;
  @Field() nameTh: string;
  /** adl | flag | service — ทักษะนี้ถูกต้องการเพราะอะไร */
  @Field(() => [String]) sources: string[];
}

@ObjectType()
export class AdminBookingDetail extends AdminBookingRow {
  /** ระดับขั้นต่ำที่ booking ต้องการ (basic | intermediate | advanced) = ค่าสูงสุดของ 3 แหล่งด้านล่าง */
  @Field(() => String, { nullable: true }) requiredLevel?: string | null;
  @Field(() => String, { nullable: true }) levelFromAdl?: string | null;
  @Field(() => String, { nullable: true }) levelFromFlags?: string | null;
  @Field(() => String, { nullable: true }) levelFromServices?: string | null;
  /** null = ยังไม่เคยคำนวณระดับ (booking เก่า) */
  @Field(() => Date, { nullable: true }) levelCalculatedAt?: Date | null;
  @Field(() => [AdminBookingRequiredSkill]) requiredSkills: AdminBookingRequiredSkill[];
  @Field(() => String, { nullable: true }) patientEmail?: string | null;
  @Field(() => String, { nullable: true }) caregiverPhone?: string | null;
  /** users.id ของผู้ดูแล — ใช้ลิงก์ไปหน้า /admin/users/:id (caregiverId คือ caregivers.id ใช้แทนไม่ได้) */
  @Field(() => ID, { nullable: true }) caregiverUserId?: string | null;
  @Field(() => String, { nullable: true }) careRecipientName?: string | null;
  @Field(() => String, { nullable: true }) bookedByName?: string | null;
  @Field() timeSlot: string;
  @Field(() => [String]) serviceLocations: string[];
  @Field() locationAddress: string;
  @Field(() => Float, { nullable: true }) platformFee?: number | null;
  @Field(() => [String]) tasks: string[];
  @Field(() => String, { nullable: true }) notes?: string | null;
  @Field(() => String, { nullable: true }) rejectionReason?: string | null;
  @Field(() => String, { nullable: true }) disputeReason?: string | null;
  @Field(() => String, { nullable: true }) dayOfContactName?: string | null;
  @Field(() => String, { nullable: true }) dayOfContactPhone?: string | null;
  @Field(() => String, { nullable: true }) dayOfContactRelationship?: string | null;
  @Field(() => Date, { nullable: true }) acceptedAt?: Date | null;
  @Field(() => Date, { nullable: true }) confirmedAt?: Date | null;
  @Field(() => Date, { nullable: true }) completedAt?: Date | null;
  @Field(() => AdminBookingPaymentInfo, { nullable: true }) payment?: AdminBookingPaymentInfo | null;
  @Field(() => [AdminBookingStatusChange]) statusHistory: AdminBookingStatusChange[];
}
