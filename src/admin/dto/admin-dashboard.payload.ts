/**
 * AdminDashboardPayload — Output types สำหรับ query adminDashboard
 *
 * ข้อมูล dashboard สรุปภาพรวมระบบ KYC สำหรับ admin:
 *
 * 1. DashboardSummary   — ตัวเลขสรุป (total users, caregivers, สถานะ KYC แต่ละประเภท)
 * 2. WeeklySubmission   — จำนวน KYC submissions ในแต่ละสัปดาห์ (8 สัปดาห์ล่าสุด)
 * 3. RecentActivity     — กิจกรรมล่าสุด (admin review actions) 10 รายการ
 * 4. AdminDashboardPayload — wrapper ที่รวมทุกอย่าง + avgReviewTimeHours
 */
import { ObjectType, Field, Int, Float } from '@nestjs/graphql';

/**
 * DashboardSummary — ตัวเลขสรุปภาพรวม
 */
@ObjectType({ description: 'High-level KYC statistics for the admin dashboard' })
export class DashboardSummary {
  /** จำนวน users ทั้งหมดในระบบ (ไม่นับ is_deleted) */
  @Field(() => Int, { description: 'Total active users across all roles' })
  totalUsers!: number;

  /** จำนวน caregivers ทั้งหมดที่มี record ในระบบ */
  @Field(() => Int, { description: 'Total caregiver profiles created' })
  totalCaregivers!: number;

  /** จำนวน caregivers ที่ kyc_status = "pending" */
  @Field(() => Int, { description: 'Caregivers awaiting KYC review' })
  pendingKyc!: number;

  /** จำนวน caregivers ที่ kyc_status = "verified" */
  @Field(() => Int, { description: 'Caregivers with verified KYC' })
  verifiedKyc!: number;

  /** จำนวน caregivers ที่ kyc_status = "rejected" */
  @Field(() => Int, { description: 'Caregivers with rejected KYC' })
  rejectedKyc!: number;
}

/**
 * WeeklySubmission — จำนวน KYC submissions และ approvals ในแต่ละสัปดาห์
 *
 * week format: ISO 8601 (YYYY-MM-DD) ของวันจันทร์ต้นสัปดาห์
 */
@ObjectType({ description: 'KYC submission and approval counts for a single week' })
export class WeeklySubmission {
  /** วันจันทร์ต้นสัปดาห์ในรูปแบบ YYYY-MM-DD */
  @Field({ description: 'Monday of the week (YYYY-MM-DD format)' })
  week!: string;

  /** จำนวน KYC submissions ในสัปดาห์นั้น (by kyc_submitted_at) */
  @Field(() => Int, { description: 'Number of KYC submissions in this week' })
  count!: number;

  /** จำนวน KYC ที่ approved ในสัปดาห์นั้น (by kyc_verified_at) */
  @Field(() => Int, { description: 'Number of KYC approvals in this week' })
  approved!: number;
}

/**
 * RecentActivity — กิจกรรมล่าสุดที่ admin ทำกับ KYC
 */
@ObjectType({ description: 'A recent admin KYC review action' })
export class RecentActivity {
  /** ประเภทกิจกรรม: "kyc_review" */
  @Field({ description: 'Activity type (e.g. "kyc_review")' })
  type!: string;

  /** ชื่อ caregiver ที่ถูก review */
  @Field({ description: 'Name of the caregiver involved' })
  caregiverName!: string;

  /** action ที่ admin ทำ: "approved" | "rejected" */
  @Field({ description: 'What the admin did: "approved" or "rejected"' })
  action!: string;

  /** วันเวลาที่ทำ action */
  @Field({ description: 'When this activity occurred' })
  timestamp!: Date;
}

/**
 * AdminDashboardPayload — wrapper ที่รวมทุก dashboard data section
 */
@ObjectType({ description: 'Admin dashboard data: summary stats, trends, review time, and recent activity' })
export class AdminDashboardPayload {
  /** ตัวเลขสรุปภาพรวม */
  @Field(() => DashboardSummary, { description: 'High-level KYC statistics' })
  summary!: DashboardSummary;

  /** จำนวน KYC submissions 8 สัปดาห์ล่าสุด (เรียงจากเก่า → ใหม่) */
  @Field(() => [WeeklySubmission], { description: 'KYC submissions per week for the last 8 weeks (oldest first)' })
  weeklySubmissions!: WeeklySubmission[];

  /**
   * เวลาเฉลี่ยที่ใช้ review KYC (ชั่วโมง)
   *
   * คำนวณจาก AVG(kyc_verified_at - kyc_submitted_at) เฉพาะ caregiver ที่ verified แล้ว
   * null = ยังไม่มี caregiver ที่ verified (ไม่สามารถคำนวณได้)
   */
  @Field(() => Float, {
    nullable: true,
    description: 'Average hours between KYC submission and approval (null if no verified caregivers)',
  })
  avgReviewTimeHours?: number;

  /** กิจกรรม admin review ล่าสุด 10 รายการ */
  @Field(() => [RecentActivity], { description: 'Last 10 admin KYC review actions' })
  recentActivity!: RecentActivity[];
}
