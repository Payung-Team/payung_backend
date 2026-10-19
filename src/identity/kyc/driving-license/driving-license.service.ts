/**
 * DrivingLicenseService — ใบขับขี่ของผู้ดูแล (PYG-597 / การ์ดแม่ PYG-561)
 *
 * - getState():          สถานะ ณ เวลาที่เรียก (ใช้ computeDrivingLicenseState ตัวเดียว)
 * - isVerified():        สำหรับโปรไฟล์ Elder
 * - assertVerified():    ประตูของการรับงานที่ต้องขับรถรับส่ง (AC5) → DRIVING_LICENSE_NOT_VERIFIED
 *                        ⚠ ยังไม่ผูกกับ operation รับงานใด — "งานไหนต้องขับรถรับส่ง" ยังไม่เคาะ (PYG-561)
 * - validateExpiry():    กฎวันหมดอายุตอนอัปโหลด/ส่ง KYC
 * - assertForKyc():      ผู้ดูแลที่ระบุว่าขับเองต้องมีใบขับขี่ที่ใช้ได้ในรอบส่ง KYC
 *
 * จับคู่เอกสารทั้ง caregiver_id และ user_id: kyc_documents.caregiver_id เป็น NULL ได้ (ยังไม่ส่ง KYC / ถูกปลดตอนส่งใหม่)
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma.service';
import { ClockService } from '../../../common/clock.service';
import { isBangkokDateInFuture, toBangkokEndOfDay } from '../license/license-date';
import {
  DRIVING_LICENSE_DOC_TYPE,
  DRIVING_LICENSE_REVIEW_STATUS,
} from './driving-license.constants';
import { DRIVING_LICENSE_ERROR, DrivingLicenseError } from './driving-license.errors';
import { TransportMode } from './transport-mode';
import {
  DrivingLicenseState,
  computeDrivingLicenseState,
  isDrivingLicenseUnexpired,
} from './driving-license-status';

type Db = Pick<Prisma.TransactionClient, 'kycDocument'>;

export interface DrivingLicenseOwner {
  caregiverId: string;
  userId: string;
}

@Injectable()
export class DrivingLicenseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  async getState(owner: DrivingLicenseOwner, db: Db = this.prisma): Promise<DrivingLicenseState> {
    const rows = await db.kycDocument.findMany({
      where: {
        documentType: DRIVING_LICENSE_DOC_TYPE,
        OR: [{ caregiverId: owner.caregiverId }, { userId: owner.userId }],
      },
      select: { id: true, reviewStatus: true, expiresAt: true, uploadedAt: true },
    });
    return computeDrivingLicenseState(rows, this.clock.now());
  }

  /**
   * สำหรับโปรไฟล์ Elder (driving_license_verified) — PYG-661 E2:
   * ผ่านการตรวจ (R5) และผู้ดูแลยังขับเอง (transport_mode = self_drive) หรือยังไม่เคยตอบ (NULL ถือตามใบที่มี)
   * เปลี่ยนเป็น hired_ride / none → ป้ายหาย แม้ใบยังผ่าน
   */
  async isVerified(owner: DrivingLicenseOwner & { transportMode: string | null }): Promise<boolean> {
    if (owner.transportMode !== null && owner.transportMode !== TransportMode.SELF_DRIVE) return false;
    return (await this.getState(owner)).verified;
  }

  /**
   * ประตูรับงานที่ต้องขับรถรับส่ง (AC5) — อ่านผลตรวจใบเท่านั้น ไม่อ่าน transport_mode
   * @throws DrivingLicenseError DRIVING_LICENSE_NOT_VERIFIED (422)
   */
  async assertVerified(owner: DrivingLicenseOwner): Promise<void> {
    if (!(await this.getState(owner)).verified) {
      throw new DrivingLicenseError(DRIVING_LICENSE_ERROR.NOT_VERIFIED);
    }
  }

  /**
   * วันหมดอายุตอนอัปโหลด: ต้องมี และต้องเป็นวันหลังจากวันนี้ตามปฏิทินไทย (วันนี้และย้อนหลังตอบ DRIVING_LICENSE_EXPIRED)
   * — ตรงกับ FE (ช่องวันที่ปิดวันนี้) และใบประกอบฯ ของ S03
   * ⚠ คนละเรื่องกับ "ผ่านการตรวจ": ใบที่อัปโหลดไว้แล้วยังใช้ได้ถึงสิ้นวันหมดอายุ (R5) ดู computeDrivingLicenseState
   * @returns สิ้นวันเวลาไทยของวันหมดอายุ (ค่าที่เก็บใน expires_at)
   */
  validateExpiry(expiresAt: Date | null | undefined): Date {
    if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
      throw new DrivingLicenseError(DRIVING_LICENSE_ERROR.EXPIRY_REQUIRED);
    }
    if (!isBangkokDateInFuture(expiresAt, this.clock.now())) {
      throw new DrivingLicenseError(DRIVING_LICENSE_ERROR.EXPIRED);
    }
    return toBangkokEndOfDay(expiresAt);
  }

  /**
   * ตอนส่ง KYC: selfDriveTransport = true ต้องมีใบขับขี่ใน documentIds ของรอบนี้ (ของผู้ใช้นี้ ไม่ใช่ rejected)
   * พร้อมวันหมดอายุที่ยังไม่ผ่านมา · false/ไม่ส่ง = ไม่ตรวจ (R2)
   */
  async assertForKyc(userId: string, selfDriveTransport: boolean | undefined, documentIds: string[]): Promise<void> {
    if (selfDriveTransport !== true) return;

    const docs =
      documentIds.length > 0
        ? await this.prisma.kycDocument.findMany({
            where: { id: { in: documentIds }, userId, documentType: DRIVING_LICENSE_DOC_TYPE },
            select: { id: true, reviewStatus: true, expiresAt: true, uploadedAt: true },
            orderBy: { uploadedAt: 'desc' },
          })
        : [];

    // ใบที่ถูกปฏิเสธส่งซ้ำไม่ได้ ต้องอัปโหลดใบใหม่ (E7)
    const usable = docs.find((d) => d.reviewStatus !== DRIVING_LICENSE_REVIEW_STATUS.REJECTED);
    if (!usable) throw new DrivingLicenseError(DRIVING_LICENSE_ERROR.REQUIRED);

    if (!usable.expiresAt) throw new DrivingLicenseError(DRIVING_LICENSE_ERROR.EXPIRY_REQUIRED);
    if (!isDrivingLicenseUnexpired(usable.expiresAt, this.clock.now())) {
      throw new DrivingLicenseError(DRIVING_LICENSE_ERROR.EXPIRED);
    }
  }
}
