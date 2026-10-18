/**
 * AdminLicenseService — แอดมินอนุมัติ/ปฏิเสธใบประกอบวิชาชีพ (PYG-587 / การ์ดแม่ PYG-558)
 *
 * แพตเทิร์นเดียวกับ AdminProfilePhotoService (ตรวจรายเอกสาร ไม่แตะ caregivers.kyc_status):
 *   - เปลี่ยนสถานะด้วย updateMany ที่มีเงื่อนไข review_status = pending → แอดมินสองคนกดพร้อมกัน คนที่สองได้ 409
 *   - เปลี่ยน review_status + บันทึก kyc_reviews (document_id) อยู่ใน transaction เดียว
 *   - แจ้งเตือนหลัง commit · ส่งไม่สำเร็จ log อย่างเดียว ไม่ทำให้การตรวจล้ม
 */
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { ClockService } from '../common/clock.service';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/entities/notification-type.enum';
import { AuthUser } from '../common/decorators/current-user.decorator';
import {
  LICENSE_DOC_TYPE,
  LICENSE_REVIEW_ACTION,
  LICENSE_STATUS,
} from '../identity/kyc/license/license.constants';
import { LICENSE_ERROR, LicenseError } from '../identity/kyc/license/license.errors';
import { LicenseReviewResult, RejectLicenseInput } from './dto/admin-license.dto';

@Injectable()
export class AdminLicenseService {
  private readonly logger = new Logger(AdminLicenseService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly notificationService: NotificationService,
    private readonly clock: ClockService,
  ) {}

  /** อนุมัติ — ใบที่วันหมดอายุผ่านไปแล้วอนุมัติไม่ได้ (E7: LICENSE_EXPIRED) */
  async approve(documentId: string, admin: AuthUser): Promise<LicenseReviewResult> {
    const doc = await this.loadPendingLicense(documentId);
    const now = this.clock.now();

    if (!doc.expiresAt || doc.expiresAt.getTime() <= now.getTime()) {
      throw new LicenseError(LICENSE_ERROR.EXPIRED);
    }

    const { userId, id: caregiverId } = doc.caregiver;

    await this.prismaService.$transaction(async (tx) => {
      await this.claimPending(tx, documentId, LICENSE_STATUS.APPROVED, now);
      await tx.kycReview.create({
        data: {
          caregiverId,
          reviewerId: admin.id,
          action: LICENSE_REVIEW_ACTION.APPROVED,
          documentId,
          reviewedAt: now,
        },
      });
    });

    this.logger.log({ event: 'admin.license.approved', documentId, caregiverId, adminId: admin.id });

    await this.notify(
      userId,
      NotificationType.license_approved,
      'ใบประกอบวิชาชีพได้รับการอนุมัติแล้ว',
      'ทีมงานตรวจสอบใบประกอบวิชาชีพของคุณเรียบร้อยแล้ว',
      { documentId, caregiverId, linkPath: '/kyc' },
    );

    return { documentId, caregiverId, status: LICENSE_STATUS.APPROVED, reviewedAt: now };
  }

  /** ปฏิเสธ — บังคับเหตุผล (ตัดช่องว่างหัวท้ายแล้วต้องไม่ว่าง) */
  async reject(input: RejectLicenseInput, admin: AuthUser): Promise<LicenseReviewResult> {
    const reason = input.reason?.trim() ?? '';
    if (!reason) throw new LicenseError(LICENSE_ERROR.REJECT_REASON_REQUIRED);

    const doc = await this.loadPendingLicense(input.documentId);
    const now = this.clock.now();
    const { userId, id: caregiverId } = doc.caregiver;

    await this.prismaService.$transaction(async (tx) => {
      await this.claimPending(tx, input.documentId, LICENSE_STATUS.REJECTED, now);
      // ประวัติการปฏิเสธเก็บถาวร (E6) — แถวใหม่ทุกครั้ง ไม่ทับ ไม่ลบ
      await tx.kycReview.create({
        data: {
          caregiverId,
          reviewerId: admin.id,
          action: LICENSE_REVIEW_ACTION.REJECTED,
          reason,
          documentId: input.documentId,
          reviewedAt: now,
        },
      });
    });

    this.logger.log({
      event: 'admin.license.rejected',
      documentId: input.documentId,
      caregiverId,
      adminId: admin.id,
    });

    await this.notify(
      userId,
      NotificationType.license_rejected,
      'ใบประกอบวิชาชีพไม่ผ่านการตรวจสอบ',
      `เหตุผล: ${reason} — กรุณาอัปโหลดใบประกอบวิชาชีพใหม่`,
      { documentId: input.documentId, caregiverId, reason, linkPath: '/kyc' },
    );

    return {
      documentId: input.documentId,
      caregiverId,
      status: LICENSE_STATUS.REJECTED,
      reviewedAt: now,
    };
  }

  private async loadPendingLicense(documentId: string) {
    const doc = await this.prismaService.kycDocument.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        documentType: true,
        reviewStatus: true,
        expiresAt: true,
        caregiver: { select: { id: true, userId: true } },
      },
    });

    if (!doc || doc.documentType !== LICENSE_DOC_TYPE || !doc.caregiver) {
      throw new NotFoundException(`Professional license "${documentId}" not found`);
    }
    if (doc.reviewStatus !== LICENSE_STATUS.PENDING) {
      throw new ConflictException(
        `ใบประกอบวิชาชีพนี้ไม่ได้อยู่ในสถานะรอตรวจแล้ว (สถานะ: ${doc.reviewStatus ?? 'ไม่ระบุ'})`,
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
      where: { id: documentId, reviewStatus: LICENSE_STATUS.PENDING },
      data: { reviewStatus: status, reviewedAt },
    });
    if (claimed.count === 0) {
      throw new ConflictException('ใบประกอบวิชาชีพนี้ถูกตัดสินไปแล้ว — กรุณารีเฟรช');
    }
  }

  private async notify(
    userId: string,
    type: NotificationType,
    title: string,
    body: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.notificationService.create(userId, type, title, body, data);
    } catch (err) {
      this.logger.error({
        event: 'license.notify_failed',
        type,
        userId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
