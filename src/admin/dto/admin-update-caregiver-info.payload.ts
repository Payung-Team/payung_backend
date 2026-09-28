import { ObjectType, Field, Float, ID } from '@nestjs/graphql';

@ObjectType()
export class AdminUpdateCaregiverInfoPayload {
  @Field(() => ID, { description: 'Caregiver UUID' })
  id: string;

  @Field({ description: 'First name (extracted from fullName)' })
  firstName: string;

  @Field({ description: 'Last name (extracted from fullName)' })
  lastName: string;

  @Field({ description: 'Thai national ID (13 digits)' })
  idCardNumber: string;

  @Field({ description: 'Email address of the linked user' })
  email: string;

  // PYG-534: คืนราคาล่าสุดกลับไปด้วย ให้หน้าแอดมินแสดงค่าที่บันทึกจริงได้ทันที
  // nullable เพราะผู้ดูแลใหม่ (หลัง PYG-533) ยังไม่มีราคา จนกว่าแอดมินจะตั้งให้
  @Field(() => Float, {
    nullable: true,
    description: 'Hourly rate in THB (null = not set yet)',
  })
  hourlyRate?: number;
}
