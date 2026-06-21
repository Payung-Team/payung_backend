import { Field, Float, ID, ObjectType } from '@nestjs/graphql';
import { DisputeStatus } from './dispute-status.enum';
import { PaymentStatusEnum } from '../../payment/dto/payment.type';

@ObjectType()
export class DisputePartyBrief {
  @Field(() => ID) id: string;
  @Field({ nullable: true }) displayName?: string;
  @Field({ nullable: true }) email?: string;
}

@ObjectType()
export class DisputePaymentBrief {
  @Field(() => ID) id: string;
  @Field(() => Float) amount: number;
  @Field() currency: string;
  @Field(() => PaymentStatusEnum) paymentStatus: PaymentStatusEnum;
}

/**
 * DisputeBooking — booking + dispute fields + parties + payment
 * ใช้ตอบ flagBookingDispute / resolveDispute / adminDisputes
 */
@ObjectType()
export class DisputeBooking {
  @Field(() => ID) id: string;
  @Field() bookingDate: string;
  @Field() status: string;
  @Field() serviceType: string;
  @Field() timeSlot: string;
  @Field() locationAddress: string;
  @Field(() => Float, { nullable: true }) estimatedCost?: number;

  @Field(() => DisputeStatus) disputeStatus: DisputeStatus;
  @Field({ nullable: true }) disputeReason?: string;
  @Field({ nullable: true }) disputeResolvedAt?: Date;

  @Field(() => DisputePartyBrief) patient: DisputePartyBrief;
  @Field(() => DisputePartyBrief, { nullable: true }) caregiver?: DisputePartyBrief;
  @Field(() => DisputePaymentBrief, { nullable: true }) payment?: DisputePaymentBrief;

  @Field() createdAt: Date;
  @Field() updatedAt: Date;
}
