/**
 * User Entity — GraphQL type สำหรับข้อมูลผู้ใช้ในระบบ
 *
 * ไฟล์นี้คือ "พิมพ์เขียว" ที่บอก GraphQL ว่าข้อมูล User มีหน้าตาเป็นยังไง
 * เมื่อ client (frontend) ขอข้อมูล User ผ่าน GraphQL จะได้ field ตามที่กำหนดไว้ที่นี่
 *
 * ทำไมแยก entity ออกจาก Prisma model?
 * - Prisma model (schema.prisma) = กำหนดโครงสร้าง database (มี supabaseUid, ฯลฯ)
 * - GraphQL entity (ไฟล์นี้) = กำหนดว่า client เห็นอะไรได้บ้าง
 * - บาง field เช่น supabaseUid เป็นข้อมูลภายใน ไม่ควรให้ client เห็น
 *   ดังนั้นเราจึงไม่ใส่ไว้ใน GraphQL type
 *
 * @ObjectType() = บอก GraphQL ว่า class นี้คือ "output type" (ข้อมูลที่ส่งกลับให้ client)
 * @Field()      = บอก GraphQL ว่า property นี้เป็น field ที่ client ขอได้
 *
 * ตัวอย่างการ query ใน GraphQL Playground:
 *   query {
 *     me {
 *       id
 *       email
 *       displayName
 *       avatarUrl
 *       role
 *       isActive
 *       createdAt
 *       updatedAt
 *     }
 *   }
 */
import { ObjectType, Field, ID } from '@nestjs/graphql';

@ObjectType()
export class User {
  /** UUID ของ user ในระบบเรา (ไม่ใช่ supabaseUid) */
  @Field(() => ID, { description: 'Unique identifier of the user' })
  id!: string;

  /** Email ของ user — ใช้สำหรับ login */
  @Field({ description: 'Email address of the user' })
  email!: string;

  /**
   * ชื่อแสดงผล — อาจเป็น null ได้ถ้ายังไม่เคยตั้ง
   * nullable: true = field นี้ไม่บังคับ (อาจเป็น null ได้)
   */
  @Field({ nullable: true, description: 'Display name of the user' })
  displayName?: string;

  /**
   * URL รูปโปรไฟล์ — อาจเป็น null ได้ถ้ายังไม่เคยอัปโหลด
   * nullable: true = field นี้ไม่บังคับ (อาจเป็น null ได้)
   */
  @Field({ nullable: true, description: 'Avatar image URL' })
  avatarUrl?: string;

  /**
   * Role ของ user ในระบบ:
   * - 'patient'   = ผู้ป่วย / ผู้ใช้ทั่วไป
   * - 'caregiver' = ผู้ดูแล
   * - 'admin'     = ผู้ดูแลระบบ
   */
  @Field({ description: 'User role: patient, caregiver, or admin' })
  role!: string;

  /** สถานะว่า account ยังใช้งานได้อยู่หรือไม่ */
  @Field({ description: 'Whether the user account is active' })
  isActive!: boolean;

  /** วันเวลาที่สร้าง account */
  @Field({ description: 'Account creation timestamp' })
  createdAt!: Date;

  /** วันเวลาที่อัปเดตข้อมูลล่าสุด */
  @Field({ description: 'Last profile update timestamp' })
  updatedAt!: Date;
}
