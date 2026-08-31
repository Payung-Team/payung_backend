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
import { ObjectType, Field, ID, Int } from '@nestjs/graphql';

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

  /** เบอร์โทรศัพท์ — อาจเป็น null ได้ */
  @Field({ nullable: true, description: 'Phone number' })
  phone?: string;

  /** ที่อยู่ — อาจเป็น null ได้ */
  @Field({ nullable: true, description: 'User address' })
  address?: string;

  /** ตำบล/แขวง — อาจเป็น null ได้ */
  @Field({ nullable: true, description: 'Sub-district (ตำบล/แขวง)' })
  subDistrict?: string;

  /** อำเภอ/เขต — อาจเป็น null ได้ */
  @Field({ nullable: true, description: 'District (อำเภอ/เขต)' })
  district?: string;

  /** จังหวัด — อาจเป็น null ได้ */
  @Field({ nullable: true, description: 'Province (จังหวัด)' })
  province?: string;

  /** รหัสไปรษณีย์ — อาจเป็น null ได้ */
  @Field({ nullable: true, description: 'Postal code (รหัสไปรษณีย์)' })
  postalCode?: string;

  /** เกี่ยวกับตัวเอง / บรรยายสั้น — อาจเป็น null ได้ */
  @Field({ nullable: true, description: 'Bio or personal description' })
  bio?: string;

  /**
   * Role ID ของ user ในระบบ:
   * - 1 = patient (ผู้ป่วย / ผู้ใช้ทั่วไป)
   * - 2 = caregiver (ผู้ดูแล)
   * - 3 = admin (ผู้ดูแลระบบ)
   */
  @Field(() => Int, { description: 'User role ID: 1=patient, 2=caregiver, 3=admin' })
  role!: number;

  /** สถานะว่า account ยังใช้งานได้อยู่หรือไม่ */
  @Field({ description: 'Whether the user account is active' })
  isActive!: boolean;

  /** ถูก suspend หรือถูกลบหรือไม่ */
  @Field({ description: 'Whether the user is currently suspended' })
  isSuspended!: boolean;

  /** ต้องเปลี่ยนรหัสผ่านก่อนใช้งาน (admin invite flow) */
  @Field({ description: 'Whether the user must change their password before using the app' })
  mustChangePassword!: boolean;

  /** PYG-97: รับอีเมลแจ้งเตือนหรือไม่ (default: true) */
  @Field({ description: 'Whether the user receives email notifications' })
  emailPreferences!: boolean;

  /** วันเวลาที่สร้าง account */
  @Field({ description: 'Account creation timestamp' })
  createdAt!: Date;

  /** วันเวลาที่อัปเดตข้อมูลล่าสุด */
  @Field({ description: 'Last profile update timestamp' })
  updatedAt!: Date;
}
