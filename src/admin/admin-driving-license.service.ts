/**
 * AdminDrivingLicenseService — แอดมินอนุมัติ/ปฏิเสธใบขับขี่ (PYG-597 / การ์ดแม่ PYG-561)
 *
 * แพตเทิร์นเดียวกับ AdminLicenseService (ตรวจรายเอกสาร ไม่แตะ caregivers.kyc_status):
 *   - เปลี่ยนสถานะด้วย updateMany ที่มีเงื่อนไข review_status = pending → แอดมินสองคนกดพร้อมกัน คนที่สองได้ 409
 *   - เปลี่ยน review_status + เขียน kyc_reviews (document_id) ใน transaction เดียว (ประวัติแต่ละรอบ)
 * ไม่มีแจ้งเตือน: ผู้ดูแลเห็นผลและเหตุผลในโปรไฟล์ตัวเอง (การแจ้งเตือนไม่อยู่ในขอบเขตการ์ดนี้)
 */
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { ClockService } from '../common/clock.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import {
  DRIVING_LICENSE_DOC_TYPE,
  DRIVING_LICENSE_REVIEW_ACTION,
  DRIVING_LICENSE_REVIEW_STATUS,
} from '../identity/kyc/driving-license/driving-license.constants';
import {
  DRIVING_LICENSE_ERROR,
  DrivingLicenseError,
} from '../identity/kyc/driving-license/driving-license.errors';
import { isDrivingLicenseUnexpired } from '../identity/kyc/driving-license/driving-license-status';
import { LicenseReviewResult, RejectLicenseInput } from './dto/admin-license.dto';

@Injectable()
export class AdminDrivingLicenseService {
  private readonly logger = new Logger(AdminDrivingLicenseService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly clock: ClockService,
  ) {}

  /** อนุมัติ — ใบที่เลยวันหมดอายุแล้วอนุมัติไม่ได้ (วันหมดอายุเองยังอนุมัติได้ ตาม R5) */
  async approve(documentId: string, admin: AuthUser): Promise<LicenseReviewResult> {
    const doc = await this.loadPending(documentId);
    const now = this.clock.now();

    if (!doc.expiresAt || !isDrivingLicenseUnexpired(doc.expiresAt, now)) {
      throw new DrivingLicenseError(DRIVING_LICENSE_ERROR.EXPIRED);
    }

    await this.decide(documentId, doc.caregiver.id, admin, {
      status: DRIVING_LICENSE_REVIEW_STATUS.APPROVED,
      action: DRIVING_LICENSE_REVIEW_ACTION.APPROVED,
      now,
    });

    this.logger.log({
      event: 'admin.driving_license.approved',
      documentId,
      caregiverId: doc.caregiver.id,
      adminId: admin.id,
    });
    return {
      documentId,
      caregiverId: doc.caregiver.id,
      status: DRIVING_LICENSE_REVIEW_STATUS.APPROVED,
      reviewedAt: now,
    };
  }

  /** ปฏิเสธ — บังคับเหตุผล (ตัดช่องว่างหัวท้ายแล้วต้องไม่ว่าง) */
  async reject(input: RejectLicenseInput, admin: AuthUser): Promise<LicenseReviewResult> {
    const reason = input.reason?.trim() ?? '';
    if (!reason) throw new DrivingLicenseError(DRIVING_LICENSE_ERROR.REJECT_REASON_REQUIRED);

    const doc = await this.loadPending(input.documentId);
    const now = this.clock.now();

    await this.decide(input.documentId, doc.caregiver.id, admin, {
      status: DRIVING_LICENSE_REVIEW_STATUS.REJECTED,
      action: DRIVING_LICENSE_REVIEW_ACTION.REJECTED,
      reason,
      now,
    });

    this.logger.log({
      event: 'admin.driving_license.rejected',
      documentId: input.documentId,
      caregiverId: doc.caregiver.id,
      adminId: admin.id,
    });
    return {
      documentId: input.documentId,
      caregiverId: doc.caregiver.id,
      status: DRIVING_LICENSE_REVIEW_STATUS.REJECTED,
      reviewedAt: now,
    };
  }

  /** ผลตรวจ + ประวัติ อยู่ใน transaction เดียว */
  private async decide(
    documentId: string,
    caregiverId: string,
    admin: AuthUser,
    d: { status: string; action: string; reason?: string; now: Date },
  ): Promise<void> {
    await this.prismaService.$transaction(async (tx) => {
      await this.claimPending(tx, documentId, d.status, d.now);
      // แถวใหม่ทุกครั้ง ไม่ทับ ไม่ลบ — เหตุผลของรอบก่อนยังดูย้อนหลังได้ (E7)
      await tx.kycReview.create({
        data: {
          caregiverId,
          reviewerId: admin.id,
          action: d.action,
          ...(d.reason !== undefined && { reason: d.reason }),
          documentId,
          reviewedAt: d.now,
        },
      });
    });
  }

  private async loadPending(documentId: string) {
    const doc = await this.prismaService.kycDocument.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        documentType: true,
        reviewStatus: true,
        expiresAt: true,
        caregiver: { select: { id: true } },
      },
    });

    if (!doc || doc.documentType !== DRIVING_LICENSE_DOC_TYPE || !doc.caregiver) {
      throw new NotFoundException(`Driving license "${documentId}" not found`);
    }
    if (doc.reviewStatus !== DRIVING_LICENSE_REVIEW_STATUS.PENDING) {
      throw new ConflictException(
        `ใบขับขี่นี้ไม่ได้อยู่ในสถานะรอตรวจแล้ว (สถานะ: ${doc.reviewStatus ?? 'ไม่ระบุ'})`,
      );
    }
    return { ...doc, caregiver: doc.caregiver };
  }

  private async claimPending(
    tx: Prisma.TransactionClient,
    documentId: string,
    status: string,
    reviewedAt: Date,
  ): Promise<void> {
    const claimed = await tx.kycDocument.updateMany({
      where: { id: documentId, reviewStatus: DRIVING_LICENSE_REVIEW_STATUS.PENDING },
      data: { reviewStatus: status, reviewedAt },
    });
    if (claimed.count === 0) {
      throw new ConflictException('ใบขับขี่นี้ถูกตัดสินไปแล้ว — กรุณารีเฟรช');
    }
  }
}
