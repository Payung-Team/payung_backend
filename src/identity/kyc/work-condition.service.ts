/**
 * WorkConditionService — PYG-188
 *
 * จัดการ "เงื่อนไขการทำงาน" ของ caregiver 4 ส่วน ซึ่งกระจายอยู่หลายตาราง:
 *   1. availability     → ตาราง caregiver_availability       (1 แถว = 1 วัน × 1 ช่วงเวลา)
 *   2. serviceLocations → ตาราง caregiver_service_locations  (1 แถว = 1 สถานที่) [PYG-259]
 *   3. jobTypes         → ตาราง caregiver_job_types          (1 แถว = 1 ประเภทงาน)
 *   4. serviceArea      → คอลัมน์ service_area_* บนตาราง caregivers โดยตรง
 *
 * ทำไมแยกเป็น service ใหม่ (ไม่รวมใน CaregiverService)?
 * - CaregiverService = CRUD ของตาราง caregivers อย่างเดียว
 * - งานนี้ครอบ 3 ตาราง + มี logic upsert/transaction เฉพาะตัว → แยกออกมาเทสต์ง่ายกว่า
 *
 * Guard (ตกลงกับทีม — ต่างจากข้อความในตั๋ว PYG-188):
 * - ตั๋วเขียน is_searchable=true แต่ "หน้านี้คือที่ตั้ง availability ครั้งแรก"
 *   และ is_searchable เป็น toggle ปลายทาง (คุมโดย mutation setSearchable แยกต่างหาก)
 *   → ถ้าบังคับ is_searchable=true จะ lock onboarding (ไก่กับไข่)
 * - จึงบังคับแค่: JWT + role=caregiver (ที่ resolver) + kycStatus='verified' (ที่นี่)
 *   ตรงกับ pattern เดิมของ updateProfile() / setSearchableByUser()
 */
import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, job_type, service_location, time_slot } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { UpdateWorkConditionInput } from './dto/work-condition.input';
import {
  AvailabilitySlot,
  WorkCondition,
} from './entities/work-condition.entity';

/**
 * Shape ของ caregiver + relation ที่เราต้องใช้ map เป็น WorkCondition
 * (subset ของ Prisma type — ดึงเฉพาะ field ที่ใช้)
 */
type CaregiverWithWorkCondition = {
  id: string;
  kycStatus: string;
  serviceAreaProvince: string | null;
  serviceAreaDistrict: string | null;
  availability: { dayOfWeek: number; timeSlot: string; isActive: boolean }[];
  serviceLocations: { serviceLocation: string }[];
  jobTypes: { jobType: string }[];
};

@Injectable()
export class WorkConditionService {
  private readonly logger = new Logger(WorkConditionService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── READ ─────────────────────────────────────────────────────────────────

  /**
   * myWorkCondition — ดึงเงื่อนไขการทำงานปัจจุบันของ caregiver ที่ login อยู่
   *
   * @param userId - internal user id (จาก JWT)
   * @throws NotFoundException   ถ้าไม่พบ caregiver record
   * @throws ForbiddenException  ถ้า kycStatus ยังไม่ 'verified'
   */
  async getByUserId(userId: string): Promise<WorkCondition> {
    const caregiver = await this.prisma.caregiver.findUnique({
      where: { userId },
      // ดึง relation ครบทั้ง 3 ตาราง (availability + serviceLocations + jobTypes)
      include: { availability: true, serviceLocations: true, jobTypes: true },
    });

    this.assertVerifiedCaregiver(caregiver);

    return this.toEntity(caregiver as unknown as CaregiverWithWorkCondition);
  }

  // ─── WRITE (upsert) ─────────────────────────────────────────────────────────

  /**
   * updateWorkCondition — "upsert" เงื่อนไขการทำงาน (replace-all ต่อ section)
   *
   * Partial-update semantics:
   * - section ไหน undefined → ไม่แตะ (คงเดิม)
   * - section ที่ส่งมา (รวม []) → ลบของเก่าทั้งหมด แล้วใส่ของใหม่ (replace)
   *
   * ใช้ $transaction เพื่อ atomic — ถ้า step ไหนล้มเหลว rollback ทั้งหมด
   * (กันสภาพ availability ลบไปแล้วแต่ insert ใหม่พัง → ข้อมูลหาย)
   *
   * @param userId - internal user id (จาก JWT)
   * @param input  - section ที่ต้องการเปลี่ยน (ทั้งหมด optional)
   * @throws NotFoundException   ถ้าไม่พบ caregiver record
   * @throws ForbiddenException  ถ้า kycStatus ยังไม่ 'verified'
   */
  async updateByUserId(
    userId: string,
    input: UpdateWorkConditionInput,
  ): Promise<WorkCondition> {
    // อ่านสถานะ caregiver ก่อน (ไม่ต้อง include relation — แค่เช็ค guard + เอา id)
    const existing = await this.prisma.caregiver.findUnique({
      where: { userId },
      select: { id: true, kycStatus: true },
    });

    this.assertVerifiedCaregiver(existing);
    const caregiverId = existing!.id;

    await this.prisma.$transaction(async (tx) => {
      // ── 1) availability: replace-all ──────────────────────────────────────
      if (input.availability !== undefined) {
        await tx.caregiverAvailability.deleteMany({ where: { caregiverId } });

        // dedupe ตาม (dayOfWeek + timeSlot) — กันชน unique constraint
        // [caregiverId, dayOfWeek, timeSlot] โดยให้รายการ "หลังสุด" ชนะ
        const dedupedSlots = this.dedupeAvailability(input.availability);

        if (dedupedSlots.length > 0) {
          await tx.caregiverAvailability.createMany({
            data: dedupedSlots.map((slot) => ({
              caregiverId,
              dayOfWeek: slot.dayOfWeek,
              timeSlot: slot.timeSlot as time_slot,
              isActive: slot.isActive ?? true,
            })),
          });
        }
      }

      // ── 2) serviceLocations: replace-all ──────────────────────────────────
      // ล้อ logic เดียวกับ jobTypes เป๊ะ (replace-all + dedupe) แต่คนละตาราง
      // ค่าถูก validate ด้วย @IsEnum ที่ DTO แล้ว แต่ trim/filter ไว้กันพลาด
      if (input.serviceLocations !== undefined) {
        await tx.caregiverServiceLocation.deleteMany({ where: { caregiverId } });

        // dedupe + ตัดค่าว่าง → กันชน unique [caregiverId, serviceLocation]
        const dedupedLocations = [
          ...new Set(input.serviceLocations.map((l) => l.trim()).filter(Boolean)),
        ];

        if (dedupedLocations.length > 0) {
          await tx.caregiverServiceLocation.createMany({
            data: dedupedLocations.map((serviceLocation) => ({
              caregiverId,
              serviceLocation: serviceLocation as service_location,
            })),
          });
        }
      }

      // ── 3) jobTypes: replace-all ──────────────────────────────────────────
      if (input.jobTypes !== undefined) {
        await tx.caregiverJobType.deleteMany({ where: { caregiverId } });

        // dedupe + ตัดค่าว่าง → กันชน unique [caregiverId, jobType]
        const dedupedJobTypes = [
          ...new Set(input.jobTypes.map((t) => t.trim()).filter(Boolean)),
        ];

        if (dedupedJobTypes.length > 0) {
          await tx.caregiverJobType.createMany({
            data: dedupedJobTypes.map((jobType) => ({ caregiverId, jobType: jobType as job_type })),
          });
        }
      }

      // ── 4) serviceArea: field-level partial update บน caregivers ───────────
      if (input.serviceArea !== undefined) {
        const data: Prisma.CaregiverUpdateInput = {};
        // อัปเดตเฉพาะ sub-field ที่ส่งมาจริง (undefined = ไม่แตะ)
        if (input.serviceArea.province !== undefined) {
          data.serviceAreaProvince = input.serviceArea.province;
        }
        if (input.serviceArea.district !== undefined) {
          data.serviceAreaDistrict = input.serviceArea.district;
        }
        if (Object.keys(data).length > 0) {
          await tx.caregiver.update({ where: { id: caregiverId }, data });
        }
      }
    });

    // log analytics — บอกว่า section ไหนถูกแตะบ้าง (debug/audit ง่าย)
    this.logger.log({
      event: 'caregiver.workCondition.updated',
      caregiverId,
      userId,
      updatedSections: {
        availability: input.availability !== undefined,
        serviceLocations: input.serviceLocations !== undefined,
        jobTypes: input.jobTypes !== undefined,
        serviceArea: input.serviceArea !== undefined,
      },
      timestamp: new Date().toISOString(),
    });

    // อ่านค่าล่าสุดกลับไปคืน client (สะท้อนผลหลัง commit)
    return this.getByUserId(userId);
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /**
   * เช็คว่า caregiver มีอยู่ + ผ่าน KYC แล้ว
   * รวม guard 2 อย่างไว้ที่เดียวเพื่อให้ read/write ใช้ logic เดียวกัน
   */
  private assertVerifiedCaregiver(
    caregiver: { kycStatus: string } | null,
  ): asserts caregiver is { kycStatus: string } {
    if (!caregiver) {
      throw new NotFoundException('Caregiver not found');
    }
    if (caregiver.kycStatus !== 'verified') {
      throw new ForbiddenException('ต้องผ่านการยืนยันตัวตนก่อน');
    }
  }

  /**
   * dedupe availability slots ตาม key "dayOfWeek-timeSlot"
   * ให้รายการที่มาทีหลังทับของเดิม (ค่า is_active ล่าสุดชนะ)
   */
  private dedupeAvailability(
    slots: UpdateWorkConditionInput['availability'],
  ): NonNullable<UpdateWorkConditionInput['availability']> {
    const map = new Map<string, AvailabilitySlot>();
    for (const slot of slots ?? []) {
      map.set(`${slot.dayOfWeek}-${slot.timeSlot}`, {
        dayOfWeek: slot.dayOfWeek,
        timeSlot: slot.timeSlot,
        isActive: slot.isActive ?? true,
      });
    }
    return [...map.values()];
  }

  /** map Prisma caregiver (+ relations) → WorkCondition entity */
  private toEntity(caregiver: CaregiverWithWorkCondition): WorkCondition {
    // sort availability ให้ output เสถียร: เรียงตามวัน แล้วตามชื่อช่วงเวลา
    const availability: AvailabilitySlot[] = [...caregiver.availability]
      .sort(
        (a, b) =>
          a.dayOfWeek - b.dayOfWeek || a.timeSlot.localeCompare(b.timeSlot),
      )
      .map((slot) => ({
        dayOfWeek: slot.dayOfWeek,
        timeSlot: slot.timeSlot,
        isActive: slot.isActive,
      }));

    return {
      availability,
      // sort() ให้ output เสถียร เหมือน jobTypes
      serviceLocations: caregiver.serviceLocations
        .map((sl) => sl.serviceLocation)
        .sort(),
      jobTypes: caregiver.jobTypes.map((jt) => jt.jobType).sort(),
      serviceArea: {
        province: caregiver.serviceAreaProvince ?? undefined,
        district: caregiver.serviceAreaDistrict ?? undefined,
      },
    };
  }
}
