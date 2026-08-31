import { ObjectType, Field, ID, Float } from '@nestjs/graphql';
import { PaymentStatus as PaymentStatusEnum } from '../entities/payment-status.enum';

export { PaymentStatusEnum };

@ObjectType()
export class Payment {
  @Field(() => ID)
  id: string;

  @Field()
  bookingId: string;

  @Field()
  patientId: string;

  @Field()
  caregiverId: string;

  @Field(() => Float)
  amount: number;

  @Field()
  currency: string;

  @Field({ nullable: true })
  omiseChargeId?: string;

  @Field()
  paymentMethod: string;

  @Field(() => PaymentStatusEnum)
  paymentStatus: PaymentStatusEnum;

  @Field({ nullable: true })
  failureCode?: string;

  @Field({ nullable: true })
  failureMessage?: string;

  /** PYG-278: PromptPay QR code URL — มาจาก Omise source.scannable_code.image.download_uri
   *  เก็บใน payment.metadata.qrCodeUrl (jsonb) ไม่ใช่ column → ไม่ต้อง migration */
  @Field({ nullable: true, description: 'QR code URL สำหรับ PromptPay (มาจาก Omise)' })
  qrCodeUrl?: string;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}
