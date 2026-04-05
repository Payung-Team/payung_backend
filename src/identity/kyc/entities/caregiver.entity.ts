/**
 * Caregiver Entity — GraphQL type สำหรับข้อมูล caregiver ในระบบ
 *
 * ไฟล์นี้คือ "พิมพ์เขียว" ที่บอก GraphQL ว่าข้อมูล Caregiver มีหน้าตาเป็นยังไง
 * เมื่อ client (frontend) ขอข้อมูล Caregiver ผ่าน GraphQL จะได้ field ตามที่กำหนดไว้ที่นี่
 *
 * ทำไมแยก entity ออกจาก Prisma model?
 * - Prisma model (schema.prisma) = กำหนดโครงสร้าง database
 * - GraphQL entity (ไฟล์นี้)   = กำหนดว่า client เห็นอะไรได้บ้าง
 * - บาง field อาจเป็นข้อมูลภายในที่ไม่ควรให้ client เห็น
 *
 * @ObjectType() = บอก GraphQL ว่า class นี้คือ "output type" (ข้อมูลที่ส่งกลับให้ client)
 * @Field()      = บอก GraphQL ว่า property นี้เป็น field ที่ client ขอได้
 */
import { ObjectType, Field, ID, Int, Float } from '@nestjs/graphql';

@ObjectType()
export class Caregiver {
  /** UUID ของ caregiver ในระบบเรา */
  @Field(() => ID)
  id!: string;

  /** Internal user ID ที่เชื่อมโยง caregiver กับ users table */
  @Field({ description: 'Internal user ID linked to this caregiver' })
  userId!: string;

  /** ชื่อ-นามสกุลจริง (ต้องตรงกับบัตรประชาชน) */
  @Field()
  fullName!: string;

  /** เลขบัตรประชาชน 13 หลัก */
  @Field()
  idCardNumber!: string;

  /** เบอร์โทรศัพท์ติดต่อ */
  @Field()
  phone!: string;

  /** รายการทักษะของ caregiver */
  @Field(() => [String])
  skills!: string[];

  /** จำนวนปีของประสบการณ์ */
  @Field(() => Int)
  experienceYears!: number;

  /** ค่าบริการต่อชั่วโมง (บาท) */
  @Field(() => Float)
  hourlyRate!: number;

  /**
   * แนะนำตัวสั้นๆ — อาจเป็น null ได้ถ้ายังไม่ได้กรอก
   * nullable: true = field นี้ไม่บังคับ (อาจเป็น null ได้)
   */
  @Field({ nullable: true })
  bio?: string;

  /**
   * สถานะ KYC ของ caregiver:
   * - "none"     = ยังไม่เคย submit
   * - "pending"  = submit แล้ว รอ review
   * - "verified" = ผ่านแล้ว สามารถรับงานได้
   * - "rejected" = ไม่ผ่าน ต้อง submit ใหม่
   */
  @Field({ description: 'KYC status: none | pending | verified | rejected' })
  kycStatus!: string;

  /** วันเวลาที่ submit KYC ครั้งล่าสุด — null ถ้ายังไม่เคย submit */
  @Field({ nullable: true, description: 'When KYC was submitted' })
  kycSubmittedAt?: Date;

  /** ถ้า true = caregiver จะปรากฏในผลการค้นหา (เปิดใช้หลังผ่าน KYC) */
  @Field({ description: 'Whether caregiver appears in search results' })
  isSearchable!: boolean;

  /** วันเวลาที่สร้าง caregiver record */
  @Field()
  createdAt!: Date;

  /** วันเวลาที่อัปเดตข้อมูลล่าสุด */
  @Field()
  updatedAt!: Date;
}
