/**
 * KycReview Entity — GraphQL type สำหรับประวัติการ review KYC
 *
 * แต่ละ record คือ action ที่ admin ทำกับ KYC submission ของ caregiver:
 * - "approved" = อนุมัติ KYC
 * - "rejected" = ปฏิเสธ KYC พร้อมเหตุผล
 */
import { ObjectType, Field, ID } from '@nestjs/graphql';

@ObjectType({ description: 'A single KYC review action by an admin' })
export class KycReview {
    @Field(() => ID)
    id!: string;

    /**
     * action ที่ admin ทำ:
     * - "approved" = อนุมัติ
     * - "rejected" = ปฏิเสธ
     */
    @Field({ description: 'Review action: approved | rejected' })
    action!: string;

    /** เหตุผลที่ reject — null ถ้า action เป็น approved */
    @Field({ nullable: true, description: 'Rejection reason (null if approved)' })
    reason?: string;

    /** User ID ของ admin ที่ทำ review */
    @Field({ description: 'ID of the admin who performed this review' })
    reviewedBy!: string;

    /** ชื่อ admin ที่ทำ review (JOIN จาก users.display_name) */
    @Field({ nullable: true, description: 'Display name of the admin reviewer' })
    reviewerName?: string;

    /** วันเวลาที่ทำ review */
    @Field({ description: 'When this review was performed' })
    reviewedAt!: Date;
}
