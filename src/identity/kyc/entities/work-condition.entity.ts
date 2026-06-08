/**
 * Work Condition entities — PYG-188 (output / GraphQL ObjectType)
 *
 * คู่ขนานกับ `dto/work-condition.input.ts` (ฝั่ง input)
 * ไฟล์นี้คือ "พิมพ์เขียว" ของข้อมูลที่ส่งกลับให้ client เมื่อ query `myWorkCondition`
 * หรือเมื่อ mutation `updateWorkCondition` คืนผลลัพธ์
 *
 * ประกอบด้วย 4 ส่วน ตรงกับ design (CG-Work Conditon Setting):
 *   1. availability     — ตารางว่างรายสัปดาห์
 *   2. serviceLocations — สถานที่รับงาน (at_home / accompany_outside) [PYG-259]
 *   3. jobTypes         — ประเภทงานที่รับ
 *   4. serviceArea      — พื้นที่ให้บริการ
 */
import { ObjectType, Field, Int } from '@nestjs/graphql';

/** 1 ช่องในตารางว่าง (map จาก Prisma `CaregiverAvailability`) */
@ObjectType()
export class AvailabilitySlot {
  @Field(() => Int, { description: 'Day of week: 0=Sunday, 1=Monday … 6=Saturday' })
  dayOfWeek!: number;

  @Field({ description: "Time slot label e.g. 'morning' | 'afternoon' | 'evening'" })
  timeSlot!: string;

  @Field({ description: 'Whether caregiver is available in this slot' })
  isActive!: boolean;
}

/** พื้นที่ให้บริการ (map จากคอลัมน์ service_area_* บน caregivers) */
@ObjectType()
export class ServiceArea {
  @Field({ nullable: true, description: 'Service area province (จังหวัด)' })
  province?: string;

  @Field({ nullable: true, description: 'Service area district (อำเภอ/เขต)' })
  district?: string;
}

/** ผลรวมเงื่อนไขการทำงานของ caregiver 1 คน */
@ObjectType()
export class WorkCondition {
  @Field(() => [AvailabilitySlot], { description: 'Weekly availability slots' })
  availability!: AvailabilitySlot[];

  // สถานที่รับงาน (at_home / accompany_outside) — แยกจาก jobTypes (PYG-259)
  @Field(() => [String], { description: 'Accepted service locations (at_home | accompany_outside)' })
  serviceLocations!: string[];

  @Field(() => [String], { description: 'Accepted job types' })
  jobTypes!: string[];

  @Field(() => ServiceArea, { description: 'Service area (province + district)' })
  serviceArea!: ServiceArea;
}
