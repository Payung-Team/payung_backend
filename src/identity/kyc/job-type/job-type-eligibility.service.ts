/**
 * JobTypeEligibilityService — ตัวตรวจกลางตัวเดียวของประเภทงาน (PYG-592 / การ์ดแม่ PYG-559)
 *
 * ทุกทางที่เขียน caregiver_job_types ต้องเรียก assertAllowed() ใน transaction เดียวกับการเขียน
 * (ทางเขียนที่พบใน repo: WorkConditionService.updateByUserId — ดูรายการใน PR) ส่วน operation อ่าน
 * (myJobTypeOptions) เรียก evaluateAll() ซึ่งใช้ evaluateJobType() ตัวเดียวกัน
 *
 * อ่านวิชาชีพจาก caregivers.profession (ค่าที่บันทึกอยู่ ไม่ใช่ค่าที่ขอเปลี่ยนที่รอแอดมิน)
 * และใบประกอบฯ จาก kyc_documents ชนิด professional_license ของ S03
 *   - จับคู่ทั้ง caregiver_id และ user_id: kyc_documents.caregiver_id เป็น NULL ได้ (ส่ง KYC ใหม่แล้วปลดเอกสารเก่า)
 *     ถ้าดูแค่ caregiver_id จะมองไม่เห็นใบที่อนุมัติไปแล้ว
 * ตัวตรวจอยู่ชั้น service ไม่พึ่ง DTO เพื่อให้ได้ JOB_TYPE_NOT_ALLOWED + 422 (PYG-415)
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma.service';
import { ClockService } from '../../../common/clock.service';
import { LICENSE_DOC_TYPE } from '../license/license.constants';
import {
  JOB_TYPES,
  JobTypeEvaluation,
  evaluateJobType,
} from './job-type-rules';
import { JobTypeNotAllowedError } from './job-type.errors';

/** PrismaService หรือ tx ของ $transaction ก็ได้ */
type Db = Pick<Prisma.TransactionClient, 'caregiver' | 'kycDocument'>;

@Injectable()
export class JobTypeEligibilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  /** รายการครบ 5 ประเภทพร้อมเลือกได้/เหตุผล (operation อ่าน) */
  async evaluateAll(caregiverId: string, db: Db = this.prisma): Promise<JobTypeEvaluation[]> {
    return this.evaluate(caregiverId, [...JOB_TYPES], db);
  }

  /** ตรวจเฉพาะรายการที่ส่งมา */
  async evaluate(
    caregiverId: string,
    jobTypes: string[],
    db: Db = this.prisma,
  ): Promise<JobTypeEvaluation[]> {
    const caregiver = await db.caregiver.findUnique({
      where: { id: caregiverId },
      select: { profession: true, userId: true },
    });
    if (!caregiver) throw new NotFoundException('Caregiver not found');

    const needsLicense = jobTypes.length > 0;
    const licenses = needsLicense
      ? await db.kycDocument.findMany({
          where: {
            documentType: LICENSE_DOC_TYPE,
            OR: [{ caregiverId }, { userId: caregiver.userId }],
          },
          select: { reviewStatus: true, expiresAt: true, uploadedAt: true },
        })
      : [];

    const now = this.clock.now();
    return jobTypes.map((t) => evaluateJobType(t, caregiver.profession, licenses, now));
  }

  /**
   * ตรวจก่อนเขียน — มีรายการไม่ผ่านแม้รายการเดียว → ปฏิเสธทั้งคำขอ (E4)
   * เรียกด้วย tx ของ transaction ที่จะเขียน เพื่อให้ตรวจ+เขียนเป็นหน่วยเดียว
   * @throws JobTypeNotAllowedError (422)
   */
  async assertAllowed(caregiverId: string, jobTypes: string[], db: Db = this.prisma): Promise<void> {
    const blocked = (await this.evaluate(caregiverId, jobTypes, db)).filter((e) => !e.selectable);
    if (blocked.length > 0) throw new JobTypeNotAllowedError(blocked);
  }
}
