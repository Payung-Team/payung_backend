import { Field, Float, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

export enum BookingStatusEnum {
  PENDING   = 'pending',
  ACCEPTED  = 'accepted',
  CONFIRMED = 'confirmed',
  REJECTED  = 'rejected',
  COMPLETED = 'completed',
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
  @Field(() => ID)                        id: string;
  @Field()                                bookingDate: string;
  @Field()                                status: string;
  @Field()                                serviceType: string;
  @Field()                                timeSlot: string;
  @Field()                                locationAddress: string;
  @Field(() => Float, { nullable: true }) estimatedCost?: number;
  @Field(() => CaregiverBriefDto)         caregiver: CaregiverBriefDto;
  @Field({ nullable: true })              careRecipientName?: string;
  @Field({ nullable: true })              confirmedAt?: Date;
  @Field()                                createdAt: Date;
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
