import { Field, Float, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

export enum BookingStatusEnum {
  UNMATCHED = 'unmatched', // booking created, no caregiver assigned yet
  PENDING   = 'pending',   // caregiver assigned by matching engine, awaiting acceptance
  ACCEPTED  = 'accepted',
  CONFIRMED = 'confirmed',
  // PYG-352/358: monitoring module lifecycle, added after the enum's original 7 values shipped —
  // Booking.status is plain TEXT (no DB enum) and monitoring.constants.ts's BOOKING_STATUS already
  // writes these; this enum just never caught up, so caregiverBookings(status: IN_PROGRESS) etc.
  // failed GraphQL validation and a checked-in job had no query that could ever fetch it again.
  IN_PROGRESS      = 'in_progress',
  AWAITING_RELEASE = 'awaiting_release',
  NEEDS_REVIEW     = 'needs_review',
  REJECTED  = 'rejected',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled', // patient cancelled
}
registerEnumType(BookingStatusEnum, { name: 'BookingStatus' });


@ObjectType()
export class CaregiverBriefDto {
  @Field(() => ID)                    id: string;
  @Field({ nullable: true })          fullName?: string;
  @Field({ nullable: true })          avatarUrl?: string;
  @Field(() => Float, { nullable: true }) hourlyRate?: number;
}

@ObjectType()
export class BookingSummary {
  @Field(() => ID)                                    id: string;
  @Field()                                            bookingDate: string;
  @Field()                                            status: string;
  @Field({ nullable: true })                          disputeStatus?: string;
  @Field({ nullable: true })                          disputeReason?: string;
  @Field()                                            serviceType: string;
  @Field()                                            timeSlot: string;
  @Field({ nullable: true })                          startTime?: string;
  @Field(() => Float, { nullable: true })             durationHours?: number;
  @Field(() => [String])                              tasks: string[];
  @Field(() => [String])                              serviceLocations: string[];
  @Field()                                            locationAddress: string;
  // PYG-352: พิกัดจุดงานที่ลูกค้าปักหมุดตอนจอง — FE ใช้วาดหมุด "จุดงาน" + วงรัศมี 200/500 ม.
  // null = booking ใบนี้ไม่มีพิกัด (ใบเก่าทั้งหมด) → ระบบจะไม่คำนวณระยะและไม่ติดธง
  @Field(() => Float, { nullable: true })             locationLat?: number;
  @Field(() => Float, { nullable: true })             locationLng?: number;
  @Field({ nullable: true })                          notes?: string;
  @Field(() => Float, { nullable: true })             estimatedCost?: number;
  @Field(() => CaregiverBriefDto, { nullable: true }) caregiver?: CaregiverBriefDto;
  @Field({ nullable: true })                          careRecipientName?: string;
  @Field({ nullable: true })                          confirmedAt?: Date;
  @Field()                                            createdAt: Date;
}

@ObjectType()
export class BookingPagination {
  @Field(() => Int) page: number;
  @Field(() => Int) limit: number;
  @Field(() => Int) total: number;
  @Field(() => Int) totalPages: number;
}

@ObjectType()
export class BookingListResponse {
  @Field(() => [BookingSummary])   data: BookingSummary[];
  @Field(() => BookingPagination)  pagination: BookingPagination;
}
