import { ObjectType, Field, ID, Int, Float } from '@nestjs/graphql';

@ObjectType()
export class CaregiverSummary {
  @Field(() => ID, { description: 'Caregiver UUID' })
  id: string;

  @Field({ description: 'Full name' })
  fullName: string;

  @Field({ nullable: true, description: 'Avatar URL from user profile' })
  avatarUrl?: string;

  @Field(() => Float, { description: 'Hourly rate in THB' })
  hourlyRate: number;

  @Field(() => Float, { nullable: true, description: 'Average rating (null if no reviews yet)' })
  avgRating?: number;

  @Field(() => Int, { description: 'Total number of patient reviews' })
  reviewCount: number;

  @Field(() => [String], { description: 'Skill tags' })
  skills: string[];

  @Field({ nullable: true, description: 'Service area province' })
  province?: string;

  @Field({ nullable: true, description: 'Service area district' })
  district?: string;

  /**
   * เพศของผู้ดูแล — FE โชว์เป็นไอคอนบนการ์ดผลค้นหา (SearchPage)
   *
   * ★ FE ขอฟิลด์นี้มาตั้งแต่ก่อนแล้วแต่ BE ไม่เคยมี → GraphQL ปฏิเสธคำขอทั้งก้อน
   *   ที่ขั้น validation (400) ทำให้ "หน้าค้นหาไม่ขึ้นผลเลย" ไม่ใช่แค่ไอคอนหาย
   *
   * nullable เพราะ caregivers.gender เป็น optional — ผู้ดูแลที่ยังไม่กรอกจะไม่มีไอคอน
   * ซึ่งเป็นพฤติกรรมที่ FE รองรับอยู่แล้ว (GENDER_DISPLAY[cg.gender ?? ''] ?? null)
   */
  @Field({ nullable: true, description: 'Caregiver gender (null if not provided)' })
  gender?: string;
}

@ObjectType()
export class SearchPagination {
  @Field(() => Int)
  page: number;

  @Field(() => Int)
  limit: number;

  @Field(() => Int)
  total: number;

  @Field(() => Int)
  totalPages: number;
}

@ObjectType()
export class SearchCaregiverPayload {
  @Field(() => [CaregiverSummary])
  data: CaregiverSummary[];

  @Field(() => SearchPagination)
  pagination: SearchPagination;
}
