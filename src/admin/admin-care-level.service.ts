/**
 * AdminCareLevelService — แอดมินแก้ระดับผู้ดูแลหลังอนุมัติ และอ่านประวัติ (PYG-581 · contract PYG-579 §4)
 *
 * Methods:
 * - setCaregiverCareLevel() — แก้ระดับของผู้ดูแลที่ KYC อนุมัติแล้ว + เขียนประวัติ
 * - getCareLevelInfo()      — ระดับปัจจุบัน + ผู้กำหนด + เวลา
 * - careLevelHistory()      — ประวัติการเปลี่ยนระดับ ใหม่ไปเก่า
 *
 * ★ ระดับแรกของผู้ดูแลใหม่ "ไม่ได้" ตั้งที่นี่ — ตั้งตอนกดอนุมัติ KYC (AdminService.approveKyc รับระดับมาด้วย)
 *   มติ 2026-10-18: ส่งระดับมาพร้อมคำสั่งอนุมัติ เพื่อให้ระดับ ประวัติ และ kyc_status อยู่ในทรานแซคชันเดียว
 *   และผู้ดูแลที่ยังไม่อนุมัติจะไม่มีระดับ (story R7) → ที่นี่จึงรับเฉพาะผู้ดูแลที่ verified แล้ว
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { careLevelFromDb } from '../common/care-level/care-level';
import {
  careLevelKycNotVerifiedError,
  parseCareLevelInput,
  parseCareLevelReason,
} from '../common/care-level/care-level.errors';
import {
  CareLevelChange,
  CaregiverCareLevelInfo,
  SetCaregiverCareLevelInput,
  SetCaregiverCareLevelPayload,
} from './dto/care-level.dto';
import {
  dbClockNow,
  lockCaregiverForCareLevel,
  toCareLevelChange,
  toCareLevelInfo,
  writeCareLevelChange,
} from './admin-care-level.helpers';

/** คอลัมน์ที่ต้องใช้สร้าง CaregiverCareLevelInfo — ใช้ซ้ำทั้งไฟล์ (และใน AdminService) */
export const CARE_LEVEL_INFO_SELECT = {
  id: true,
  careLevel: true,
  careLevelSetBy: true,
  careLevelSetAt: true,
  careLevelSetByUser: { select: { displayName: true } },
} as const;

@Injectable()
export class AdminCareLevelService {
  private readonly logger = new Logger(AdminCareLevelService.name);

  constructor(private readonly prismaService: PrismaService) {}

  /**
   * setCaregiverCareLevel — แอดมินแก้ระดับของผู้ดูแลที่ KYC อนุมัติแล้ว (S02-AC4)
   *
   * ลำดับการตรวจ (ตรงกับ contract §4.2):
   * 1. ค่าระดับ — ว่าง = CARE_LEVEL_REQUIRED · นอกรายการ = CARE_LEVEL_INVALID (ก่อนแตะ DB · E9)
   * 2. ล็อกแถวผู้ดูแล — ไม่พบ = NotFound
   * 3. KYC ต้องเป็น verified — ไม่ใช่ = CARE_LEVEL_KYC_NOT_VERIFIED
   * 4. ค่าเดิมที่แอดมินกำหนดไว้แล้ว → สำเร็จ changed=false ไม่เขียนอะไรเลย (E4)
   * 5. เหตุผล — ว่าง = CARE_LEVEL_REASON_REQUIRED (บังคับเฉพาะเมื่อจะเปลี่ยนจริง)
   * 6. เขียนระดับ + ผู้กำหนด + เวลา + แถวประวัติ ในทรานแซคชันเดียว
   *
   * ★ ค่าเดิมแต่ "ยังไม่เคยมีแอดมินกำหนด" (ค่าเริ่มต้นจาก migration) นับเป็นการเปลี่ยน
   *   = แอดมินยืนยันระดับเดิม → บันทึกผู้กำหนด/เวลา + แถวประวัติ old = new
   *   ไม่งั้นผู้ดูแลกลุ่มนี้จะค้างสถานะ "ยังไม่ทบทวน" ตลอดไปถ้าแอดมินเห็นว่าระดับ ต้น ถูกแล้ว (story E3 / AC6)
   *   E4 ในการ์ดจึงใช้กับค่าที่แอดมินเคยกำหนดไว้แล้วเท่านั้น — เขียนไว้ใน contract §4.2 ให้ทีมยืนยัน
   *
   * @param input - caregiverId + level + reason
   * @param admin - แอดมินที่ล็อกอิน (ผู้กำหนดมาจากตรงนี้เสมอ ไม่รับจาก input)
   */
  async setCaregiverCareLevel(
    input: SetCaregiverCareLevelInput,
    admin: AuthUser,
  ): Promise<SetCaregiverCareLevelPayload> {
    // ─── 1. ตรวจค่าระดับก่อนแตะ DB ────────────────────────────────────────
    const newLevel = parseCareLevelInput(input.level);

    // ─── 2–6. ทั้งหมดอยู่ใต้ล็อกแถวเดียวกัน ─────────────────────────────────
    const result = await this.prismaService.$transaction(async (tx) => {
      const locked = await lockCaregiverForCareLevel(tx, input.caregiverId);
      if (!locked) {
        throw new NotFoundException(
          `Caregiver "${input.caregiverId}" not found`,
        );
      }

      if (locked.kyc_status !== 'verified') {
        throw careLevelKycNotVerifiedError(locked.kyc_status);
      }

      const oldLevel = careLevelFromDb(locked.care_level);
      const alreadySetByAdmin = locked.care_level_set_by !== null;

      // E4: ค่าเดิมที่แอดมินกำหนดไว้แล้ว → ไม่ใช่การเปลี่ยน ไม่ต้องมีเหตุผล ไม่เขียนอะไร
      if (oldLevel === newLevel && alreadySetByAdmin) {
        return { changed: false, oldLevel };
      }

      const reason = parseCareLevelReason(input.reason);
      const at = await dbClockNow(tx);

      await writeCareLevelChange(tx, {
        caregiverId: input.caregiverId,
        oldLevel,
        newLevel,
        changedBy: admin.id,
        reason,
        at,
      });

      return { changed: true, oldLevel };
    });

    this.logger.log({
      event: result.changed
        ? 'admin.care_level.changed'
        : 'admin.care_level.unchanged',
      caregiverId: input.caregiverId,
      adminId: admin.id,
      oldLevel: result.oldLevel,
      newLevel,
    });

    // อ่านกลับหลัง commit เพื่อได้ชื่อผู้กำหนด (กรณี unchanged = ผู้กำหนดคนเดิม ไม่ใช่แอดมินที่กดอยู่)
    const careLevel = await this.getCareLevelInfo(input.caregiverId);
    return { changed: result.changed, careLevel };
  }

  /**
   * getCareLevelInfo — ระดับปัจจุบัน + ผู้กำหนด + เวลา ของผู้ดูแลหนึ่งคน
   * @throws NotFoundException เมื่อไม่พบผู้ดูแล
   */
  async getCareLevelInfo(caregiverId: string): Promise<CaregiverCareLevelInfo> {
    const row = await this.prismaService.caregiver.findUnique({
      where: { id: caregiverId },
      select: CARE_LEVEL_INFO_SELECT,
    });

    if (!row) {
      throw new NotFoundException(`Caregiver "${caregiverId}" not found`);
    }

    return toCareLevelInfo(row);
  }

  /**
   * careLevelHistory — ประวัติการเปลี่ยนระดับ เรียงใหม่ไปเก่า (S02-AC4)
   *
   * คืนทุกแถวไม่แบ่งหน้า: ระดับเปลี่ยนไม่บ่อย (ผู้ดูแลหนึ่งคนมีไม่กี่แถว) และมี index
   * caregiver_care_level_logs_caregiver_idx (caregiver_id, created_at DESC) รองรับ query นี้พอดี
   *
   * @throws NotFoundException เมื่อไม่พบผู้ดูแล (แยกจาก "พบแต่ยังไม่มีประวัติ" ซึ่งได้ [])
   */
  async careLevelHistory(caregiverId: string): Promise<CareLevelChange[]> {
    const caregiver = await this.prismaService.caregiver.findUnique({
      where: { id: caregiverId },
      select: { id: true },
    });

    if (!caregiver) {
      throw new NotFoundException(`Caregiver "${caregiverId}" not found`);
    }

    const rows = await this.prismaService.caregiver_care_level_logs.findMany({
      where: { caregiver_id: caregiverId },
      orderBy: { created_at: 'desc' },
      include: { users: { select: { displayName: true } } },
    });

    return rows.map(toCareLevelChange);
  }
}
