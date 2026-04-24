/**
 * KycService — Business logic สำหรับ KYC (Know Your Customer)
 * ...
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { KycInput } from './dto/kyc.input';
import { KycStatusPayload } from './dto/kyc-status.payload';
import { Caregiver } from './entities/caregiver.entity';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { CaregiverService } from './caregiver.service';
import { NotificationService } from '../../notification/notification.service';
import { NotificationType } from '../../notification/entities/notification-type.enum';

@Injectable()
export class KycService {
  constructor(
    private prismaService: PrismaService,
    private caregiverService: CaregiverService,
    private notificationService: NotificationService,
  ) { }

  /**
   * submitKyc — สร้างหรืออัปเดต caregiver record พร้อม link เอกสาร KYC
   *
   * Business rules:
   * - status = "none"  → submit ได้ (สร้าง/อัปเดต record, set pending)
   * - status = อื่นๆ  → throw ConflictException (ห้าม submit ซ้ำ)
   * - documentIds ทุกตัวต้องมีอยู่จริง และต้องเป็นของ user คนนี้
   *
   * @param user  - user ที่ login อยู่ (inject โดย SupabaseAuthGuard)
   * @param input - ข้อมูล KYC ที่ client ส่งมา
   * @returns Caregiver entity ที่ถูกสร้าง/อัปเดต
   */
  async submitKyc(user: AuthUser, input: KycInput): Promise<Caregiver> {
    // ── ขั้นตอนที่ 1: เช็ค KYC status ปัจจุบัน ────────────────────────
    // ไม่ annotate type เป็น Caregiver เพราะ Prisma return nullable fields
    // ที่ไม่ตรงกับ GraphQL entity — ใช้ inferred type แทน
    const existing = await this.prismaService.caregiver.findUnique({
      where: { userId: user.id },
    });

    if (existing && existing.kycStatus !== 'none') {
      throw new ConflictException(
        `KYC already submitted. Current status: "${existing.kycStatus}"`,
      );
    }

    // ── ขั้นตอนที่ 2: Validate documentIds ───────────────────────────
    // ต้องมีอยู่จริงในตาราง kyc_documents
    // และต้องเป็น document ของ user คนนี้ (ป้องกัน user A ใช้ doc ของ user B)
    if (input.documentIds.length > 0) {
      const foundDocs = await this.prismaService.kycDocument.findMany({
        where: {
          id: { in: input.documentIds },
          userId: user.id, // เช็คว่าเป็นของ user นี้จริงๆ
        },
        select: { id: true },
      });

      const foundIds = foundDocs.map((d) => d.id);
      const missingIds = input.documentIds.filter(
        (id) => !foundIds.includes(id),
      );

      if (missingIds.length > 0) {
        throw new NotFoundException(
          `Document IDs not found or not owned by user: ${missingIds.join(', ')}`,
        );
      }
    }

    // ── ขั้นตอนที่ 3: Upsert caregiver record ────────────────────────
    // upsert = สร้างถ้ายังไม่มี, อัปเดตถ้ามีแล้ว
    // ทำใน transaction เพื่อให้ upsert + link documents เป็น atomic
    // (ถ้า link documents ล้มเหลว → upsert จะถูก rollback ด้วย)
    const caregiver = await this.prismaService.$transaction(async (tx) => {
      // 3a. Upsert caregivers table
      const upserted = await tx.caregiver.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          fullName: input.fullName,
          idCardNumber: input.idCardNumber,
          phone: input.phone,
          skills: input.skills,
          experienceYears: input.experienceYears,
          hourlyRate: input.hourlyRate,
          bio: input.bio,
          kycStatus: 'pending',
          kycSubmittedAt: new Date(),
          isSearchable: false,
        },
        update: {
          fullName: input.fullName,
          idCardNumber: input.idCardNumber,
          phone: input.phone,
          skills: input.skills,
          experienceYears: input.experienceYears,
          hourlyRate: input.hourlyRate,
          bio: input.bio,
          kycStatus: 'pending',
          kycSubmittedAt: new Date(),
        },
      });

      // 3b. Link documents → caregiverId
      if (input.documentIds.length > 0) {
        await tx.kycDocument.updateMany({
          where: {
            id: { in: input.documentIds },
            userId: user.id,
          },
          data: { caregiverId: upserted.id },
        });
      }

      return upserted;
    });

    return this.mapPrismaToEntity(caregiver);
  }

  /**
   * getCaregiverByUserId — ดึงข้อมูล caregiver ของ user
   *
   * @param userId - ID ของ user ที่ต้องการดึงข้อมูล
   */
  async getCaregiverByUserId(userId: string): Promise<Caregiver> {
    const caregiver = await this.prismaService.caregiver.findUnique({
      where: { userId },
    });

    if (!caregiver) {
      throw new NotFoundException(`Caregiver not found for user ${userId}`);
    }

    return this.mapPrismaToEntity(caregiver);
  }

  /**
   * getKycStatus — ดึงข้อมูล KYC status ครบสำหรับ Status Page
   *
   * รองรับทุก status:
   * - "none"     → { status: 'none', documents: [] }
   * - "pending"  → { status, submittedAt, caregiver, documents[] }
   * - "verified" → { status, submittedAt, verifiedAt, caregiver, documents[] }
   * - "rejected" → { status, submittedAt, rejectedAt, rejectedReason, caregiver, documents[] }
   *
   * สำหรับ rejected: ดึง KycReview ล่าสุดที่ action = 'rejected' เพื่อหา rejectedAt + reason
   *
   * @param userId - internal user ID จาก JWT token
   * @returns KycStatusPayload ครบทุก field
   */
  async getKycStatus(userId: string): Promise<KycStatusPayload> {
    // ── 1: ค้นหา caregiver จาก userId ──────────────────────────────
    const caregiver = await this.prismaService.caregiver.findUnique({
      where: { userId },
    });

    // ยังไม่เคย submit → คืน status: 'none' พร้อม empty documents
    if (!caregiver) {
      return {
        status: 'none',
        documents: [],
      };
    }

    const caregiverEntity = this.mapPrismaToEntity(caregiver);

    // ── 2: โหลดเอกสาร KYC พร้อม signed URLs ───────────────────────
    const documents = await this.caregiverService.getDocumentsWithSignedUrls(
      caregiver.id,
    );

    // ── 3: Base payload ───────────────────────────────────────────
    const payload: KycStatusPayload = {
      status: caregiver.kycStatus,
      submittedAt: caregiver.kycSubmittedAt ?? undefined,
      verifiedAt: caregiver.kycVerifiedAt ?? undefined,
      caregiver: caregiverEntity,
      documents,
    };

    // ── 4: ถ้า rejected → ดึง KycReview ล่าสุดเพื่อหา rejectedAt + reason
    if (caregiver.kycStatus === 'rejected') {
      const latestReview = await this.prismaService.kycReview.findFirst({
        where: {
          caregiverId: caregiver.id,
          action: 'rejected',
        },
        orderBy: { reviewedAt: 'desc' },
      });

      if (latestReview) {
        payload.rejectedAt = latestReview.reviewedAt;
        payload.rejectedReason = latestReview.reason ?? undefined;
      }
    }

    return payload;
  }

  /**
   * resubmitKyc — ยื่น KYC ใหม่หลังถูก reject
   *
   * Business rules:
   * - status = "rejected" เท่านั้น → resubmit ได้
   * - status = "none"              → BadRequestException (ยังไม่เคย submit)
   * - status = "pending"           → ConflictException (กำลังรอ review อยู่)
   * - status = "verified"          → ConflictException (ผ่านแล้ว ไม่ต้อง resubmit)
   *
   * Flow (atomic transaction):
   * 1. Validate status → ต้อง "rejected"
   * 2. Validate documentIds → ต้องมีอยู่จริง และเป็นของ user นี้
   * 3. Update caregivers row:
   *    - อัปเดต fields ทั้งหมดจาก input
   *    - kycStatus = 'pending', kycSubmittedAt = now(), kycVerifiedAt = null
   *    - resubmitCount += 1 (audit log)
   * 4. Link document_ids ใหม่ → caregiverId
   * 5. (หลัง tx) Fire notification: kyc_resubmitted
   *
   * @param user  - user ที่ login อยู่ (inject โดย SupabaseAuthGuard)
   * @param input - ข้อมูล KYC ที่ resubmit (reuse KycInput DTO)
   * @returns Caregiver entity ที่ถูกอัปเดต
   */
  async resubmitKyc(user: AuthUser, input: KycInput): Promise<Caregiver> {
    // ── 1: ค้นหา caregiver และตรวจสอบ status ────────────────────────
    const existing = await this.prismaService.caregiver.findUnique({
      where: { userId: user.id },
    });

    if (!existing) {
      throw new BadRequestException(
        'ไม่พบข้อมูล KYC — กรุณา submit KYC ก่อน',
      );
    }

    if (existing.kycStatus === 'pending') {
      throw new ConflictException(
        'KYC กำลังรอการตรวจสอบอยู่ — ไม่สามารถ resubmit ได้ในขณะนี้',
      );
    }

    if (existing.kycStatus === 'verified') {
      throw new ConflictException(
        'KYC ผ่านการตรวจสอบแล้ว — ไม่จำเป็นต้อง resubmit',
      );
    }

    if (existing.kycStatus !== 'rejected') {
      // guard ป้องกัน status ที่ไม่คาดคิด
      throw new BadRequestException(
        `ไม่สามารถ resubmit ได้ในสถานะ "${existing.kycStatus}"`,
      );
    }

    // ── 2: Validate documentIds ─────────────────────────────────────
    if (input.documentIds.length > 0) {
      const foundDocs = await this.prismaService.kycDocument.findMany({
        where: {
          id: { in: input.documentIds },
          userId: user.id,
        },
        select: { id: true },
      });

      const foundIds = foundDocs.map((d) => d.id);
      const missingIds = input.documentIds.filter(
        (id) => !foundIds.includes(id),
      );

      if (missingIds.length > 0) {
        throw new NotFoundException(
          `Document IDs not found or not owned by user: ${missingIds.join(', ')}`,
        );
      }
    }

    // ── 3 & 4: Update caregiver + link documents (atomic transaction) ──
    const updated = await this.prismaService.$transaction(async (tx) => {
      // 3a. อัปเดต caregivers row
      const caregiver = await tx.caregiver.update({
        where: { userId: user.id },
        data: {
          // อัปเดต fields จาก input
          fullName: input.fullName,
          idCardNumber: input.idCardNumber,
          phone: input.phone,
          skills: input.skills,
          experienceYears: input.experienceYears,
          hourlyRate: input.hourlyRate,
          bio: input.bio,
          // Reset KYC status
          kycStatus: 'pending',
          kycSubmittedAt: new Date(),
          kycVerifiedAt: null,       // clear verifiedAt
          // Audit log: increment resubmitCount
          resubmitCount: { increment: 1 },
        },
      });

      // 3b. Link document_ids ใหม่ → caregiverId
      if (input.documentIds.length > 0) {
        await tx.kycDocument.updateMany({
          where: {
            id: { in: input.documentIds },
            userId: user.id,
          },
          data: { caregiverId: caregiver.id },
        });
      }

      return caregiver;
    });

    // ── 5: Fire notification (หลัง tx เพื่อไม่ให้ rollback notification) ──
    // fire-and-forget: ไม่ await เพื่อไม่ให้ response ช้า
    // ถ้า notification ล้มเหลว → ไม่ควรทำให้ resubmit fail
    void this.notificationService
      .create(
        user.id,
        NotificationType.kyc_resubmitted,
        'ส่งเอกสาร KYC ใหม่แล้ว',
        'เราได้รับเอกสาร KYC ของคุณแล้ว ทีมงานจะตรวจสอบภายใน 1-3 วันทำการ',
        { caregiverId: updated.id, resubmitCount: updated.resubmitCount },
      )
      .catch(() => {
        // log เพื่อ debug แต่ไม่ throw — ไม่ให้ resubmit fail เพราะ notification
      });

    return this.mapPrismaToEntity(updated);
  }

  private mapPrismaToEntity(caregiver: any): Caregiver {
    return {
      id: caregiver.id,
      userId: caregiver.userId,
      fullName: caregiver.fullName ?? undefined,
      idCardNumber: caregiver.idCardNumber ?? undefined,
      phone: caregiver.phone ?? undefined,
      skills: caregiver.skills ?? undefined,
      experienceYears: caregiver.experienceYears ?? undefined,
      hourlyRate: caregiver.hourlyRate ?? undefined,
      bio: caregiver.bio ?? undefined,
      kycStatus: caregiver.kycStatus,
      kycSubmittedAt: caregiver.kycSubmittedAt ?? undefined,
      isSearchable: caregiver.isSearchable,
      resubmitCount: caregiver.resubmitCount ?? 0,
      createdAt: caregiver.createdAt,
      updatedAt: caregiver.updatedAt,
    };
  }
}
