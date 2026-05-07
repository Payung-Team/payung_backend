/**
 * UserResolver — Field resolvers สำหรับ User type (PYG-90)
 *
 * ทำไมต้องมี?
 * - User entity ของเรามี field พื้นฐาน (id, email, role, ...) ซึ่ง resolve ตรงจาก DB
 * - แต่บาง field เช่น `caregiver` อยู่ในตารางอื่น (caregivers) → ต้อง query ต่อ
 * - GraphQL @ResolveField ช่วยให้เราเพิ่ม field ลงใน type ที่มีอยู่แล้วได้
 *   โดย client เรียก me { caregiver { kycStatus } } จะ trigger method ในนี้อัตโนมัติ
 *
 * ทำไมไม่ join ใน UserService.findById()?
 * - join เสมอ → ดึง caregiver มาทุกครั้งแม้ client ไม่ได้ขอ → waste DB query
 * - field resolver = lazy load → query เฉพาะตอน client ขอใน selection set
 *
 * วิธีใช้ฝั่ง frontend:
 *   query {
 *     me {
 *       id email role
 *       caregiver { kycStatus isSearchable kycSubmittedAt }
 *     }
 *   }
 *
 * - patient (role=1) → caregiver = null
 * - caregiver (role=2) → caregiver = { ... } (ดึงจาก caregivers table)
 */
import { Resolver, ResolveField, Parent } from '@nestjs/graphql';
import { NotFoundException } from '@nestjs/common';
import { User } from './entities/user.entity';
import { Caregiver } from '../kyc/entities/caregiver.entity';
import { CaregiverService } from '../kyc/caregiver.service';

// role IDs (ตรงกับ users.role: 1=patient, 2=caregiver, 3=admin)
const ROLE_CAREGIVER = 2;

@Resolver(() => User)
export class UserResolver {
  constructor(private readonly caregiverService: CaregiverService) {}

  /**
   * Field resolver สำหรับ User.caregiver
   *
   * ส่ง null กลับเมื่อ:
   * - user เป็น patient (role !== 2)
   * - user เป็น caregiver แต่ยังไม่มี caregiver record (edge case — เผื่อ data inconsistency)
   *
   * @param user - parent object (User ที่ resolve มาก่อนหน้า)
   * @returns Caregiver | null
   */
  @ResolveField(() => Caregiver, {
    nullable: true,
    description: 'Caregiver profile (null if user is not a caregiver)',
  })
  async caregiver(@Parent() user: User): Promise<Caregiver | null> {
    // กัน DB query เปล่าๆ ถ้า user ไม่ใช่ caregiver
    if (user.role !== ROLE_CAREGIVER) {
      return null;
    }

    // role=2 แต่ findByUserId throw NotFoundException ได้ (ถ้า caregiver row หาย)
    // → return null แทน throw เพื่อไม่ให้ me query พังทั้ง response
    try {
      return await this.caregiverService.findByUserId(user.id);
    } catch (err) {
      if (err instanceof NotFoundException) {
        return null;
      }
      throw err; // error อื่นๆ ปล่อยขึ้นไป
    }
  }
}
