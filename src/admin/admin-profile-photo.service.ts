/**
 * AdminProfilePhotoService — แอดมินรีวิวรูปโปรไฟล์ผู้ดูแล (PYG-508 / การ์ดแม่ PYG-488)
 *
 * ทำไมแยกจาก approveKyc / rejectKyc:
 *   approveKyc ทำงานได้เฉพาะ kycStatus = pending และตั้ง kycStatus = verified
 *   แต่เคส "เปลี่ยนรูปหลังผ่าน KYC" ผู้ดูแลเป็น verified อยู่แล้ว → ต้องมีเส้นแยกที่ **ไม่แตะ kycStatus**
 *   และ approve KYC ก็ **ไม่** อนุมัติรูปให้อัตโนมัติ (แอดมินต้องเทียบหน้าเอง)
 *
 * ไฟล์ไม่ย้าย bucket (ตามการ์ด PYG-508): ทุกใบอยู่ใน 'profile-photos'
 *   approve = ตั้ง users.avatar_url เป็น path ของใบนั้นเลย
 *   reject  = avatar_url ไม่เปลี่ยน · ไฟล์ที่ถูกปฏิเสธเก็บไว้เป็นหลักฐานคู่กับเหตุผลใน kyc_reviews
 *   รูปที่ยังไม่อนุมัติไม่ถูก sign ออก resolver สาธารณะ เพราะ path ไม่เคยถูกเขียนลง avatar_url
 *
 * กันแอดมินสองคนกดพร้อมกัน: เปลี่ยนสถานะด้วย updateMany ที่มีเงื่อนไข review_status = pending
 *   คนที่สองได้ count = 0 → 409
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { SupabaseService } from '../common/supabase.service';
import { AvatarUrlService } from '../common/avatar-url.service';
import { CaregiverService } from '../identity/kyc/caregiver.service';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/entities/notification-type.enum';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { KycReview } from '../identity/kyc/entities/kyc-review.entity';
import { SIGNED_URL_TTL_SEC } from '../monitoring/monitoring.constants';
import {
  DOCUMENT_REVIEW_STATUS,
  PROFILE_PHOTO_DOC_TYPE,
  PROFILE_PHOTO_REVIEW_ACTION,
  PROFILE_PHOTOS_BUCKET,
} from '../identity/kyc/profile-photo.constants';
import {
  AdminProfilePhotoQueueInput,
  AdminProfilePhotoQueuePayload,
  AdminProfilePhotoReviewPayload,
  ProfilePhotoQueueItem,
  ProfilePhotoReviewResult,
  RejectProfilePhotoInput,
} from './dto/admin-profile-photo.dto';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;

/** เอกสารที่ใช้เทียบใบหน้า — id_card เป็นชื่อเดิมของแถวรุ่นแรก */
const ID_CARD_DOC_TYPES: ReadonlySet<string> = new Set([
  'id_card_front',
  'id_card_selfie',
  'id_card',
]);

@Injectable()
export class AdminProfilePhotoService {
  private readonly logger = new Logger(AdminProfilePhotoService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly supabaseService: SupabaseService,
    private readonly avatarUrlService: AvatarUrlService,
    private readonly caregiverService: CaregiverService,
    private readonly notificationService: NotificationService,
  ) {}

  /**
   * คิวรูปโปรไฟล์ — อ่านจาก kyc_documents ตรง ๆ ไม่ใช่ caregivers.kyc_status
   * จึงเห็นผู้ดูแลที่ verified แล้วแต่เปลี่ยนรูปด้วย
   *
   * status (default pending):
   *   - pending  : ใบเก่าสุดขึ้นก่อน (มาก่อนได้ก่อน)
   *   - approved / rejected : ตัดสินล่าสุดขึ้นก่อน + ผู้ตรวจ / เหตุผลจาก kyc_reviews ล่าสุดของใบนั้น
   */
  async queue(input: AdminProfilePhotoQueueInput): Promise<AdminProfilePhotoQueuePayload> {
    const page = input.page ?? DEFAULT_PAGE;
    const limit = input.limit ?? DEFAULT_LIMIT;
    const search = input.search?.trim();
    const status = input.status ?? DOCUMENT_REVIEW_STATUS.PENDING;
    const isPending = status === DOCUMENT_REVIEW_STATUS.PENDING;

    const where: Prisma.KycDocumentWhereInput = {
      documentType: PROFILE_PHOTO_DOC_TYPE,
      reviewStatus: status,
      caregiverId: { not: null },
      ...(search
        ? { caregiver: { is: { fullName: { contains: search, mode: 'insensitive' } } } }
        : {}),
    };

    const [total, docs] = await Promise.all([
      this.prismaService.kycDocument.count({ where }),
      this.prismaService.kycDocument.findMany({
        where,
        orderBy: isPending ? { uploadedAt: 'asc' } : { reviewedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          uploadedAt: true,
          reviewStatus: true,
          reviewedAt: true,
          fileUrl: true,
          reviews: {
            orderBy: { reviewedAt: 'desc' },
            take: 1,
            select: { reason: true, reviewer: { select: { displayName: true } } },
          },
          caregiver: {
            select: {
              id: true,
              caregiverNumber: true,
              fullName: true,
              kycStatus: true,
              user: { select: { email: true, avatarUrl: true } },
            },
          },
        },
      }),
    ]);

    const items: ProfilePhotoQueueItem[] = docs.flatMap((doc) =>
      doc.caregiver
        ? [
            {
              documentId: doc.id,
              caregiverId: doc.caregiver.id,
              caregiverNumber: doc.caregiver.caregiverNumber ?? undefined,
              fullName: doc.caregiver.fullName ?? '',
              email: doc.caregiver.user.email,
              kycStatus: doc.caregiver.kycStatus,
              uploadedAt: doc.uploadedAt,
              hasApprovedPhoto: !!doc.caregiver.user.avatarUrl,
              reviewStatus: doc.reviewStatus ?? status,
              reviewedAt: doc.reviewedAt ?? undefined,
              reviewerName: doc.reviews[0]?.reviewer?.displayName ?? undefined,
              reason: doc.reviews[0]?.reason ?? undefined,
              isCurrentAvatar: doc.caregiver.user.avatarUrl === doc.fileUrl,
            },
          ]
        : [],
    );

    return {
      items,
      total,
      page,
      totalPages: total === 0 ? 1 : Math.ceil(total / limit),
    };
  }

  /**
   * ข้อมูลหน้าเทียบใบหน้า — รูปที่รออนุมัติ + รูปบัตร + รูปที่อนุมัติไว้เดิม ในการเรียกเดียว
   *
   * ★ ลง admin_audit_logs ก่อนออก signed URL ของรูปที่รออนุมัติ (รูปใบหน้า = ข้อมูลชีวภาพ
   *   ที่ยังไม่มีใครอนุมัติให้เปิดเผย) · รูปบัตรลง audit เองใน getDocumentsForAdminReview
   */
  async reviewDetail(
    caregiverId: string,
    adminId: string,
  ): Promise<AdminProfilePhotoReviewPayload> {
    const raw = await this.prismaService.caregiver.findUnique({
      where: { id: caregiverId },
      select: { userId: true, user: { select: { email: true, avatarUrl: true } } },
    });
    if (!raw) {
      throw new NotFoundException(`Caregiver ${caregiverId} not found`);
    }

    const pending = await this.prismaService.kycDocument.findFirst({
      where: {
        caregiverId,
        documentType: PROFILE_PHOTO_DOC_TYPE,
        reviewStatus: DOCUMENT_REVIEW_STATUS.PENDING,
      },
      orderBy: { uploadedAt: 'desc' },
      select: { id: true, fileUrl: true, uploadedAt: true, reviewStatus: true },
    });

    if (pending) {
      await this.auditPendingPhotoViewed(adminId, raw.userId, caregiverId, pending.id);
    }

    const [caregiver, pendingUrl, approvedPhotoUrl, kycDocuments, rawReviews] =
      await Promise.all([
        this.caregiverService.findByUserId(raw.userId),
        pending ? this.signPendingPhoto(pending.fileUrl) : Promise.resolve(null),
        this.avatarUrlService.resolve(raw.user.avatarUrl, raw.userId),
        this.caregiverService.getDocumentsForAdminReview(caregiverId, adminId),
        this.prismaService.kycReview.findMany({
          where: { caregiverId, documentId: { not: null } },
          orderBy: { reviewedAt: 'desc' },
          include: { reviewer: { select: { displayName: true } } },
        }),
      ]);

    const reviews: KycReview[] = rawReviews.map((r) => ({
      id: r.id,
      action: r.action,
      reason: r.reason ?? undefined,
      reviewedBy: r.reviewerId,
      reviewerName: r.reviewer?.displayName ?? undefined,
      reviewedAt: r.reviewedAt,
      documentId: r.documentId ?? undefined,
    }));

    return {
      caregiver: { ...caregiver, email: raw.user.email },
      pendingPhoto: pending
        ? {
            documentId: pending.id,
            reviewStatus: pending.reviewStatus ?? DOCUMENT_REVIEW_STATUS.PENDING,
            signedUrl: pendingUrl ?? undefined,
            uploadedAt: pending.uploadedAt,
          }
        : undefined,
      approvedPhotoUrl: approvedPhotoUrl ?? undefined,
      idCardDocuments: kycDocuments.filter((doc) => ID_CARD_DOC_TYPES.has(doc.docType)),
      reviews,
    };
  }

  /**
   * อนุมัติรูป — สถานะเอกสาร = approved, users.avatar_url = path ของรูปนี้,
   * บันทึก kyc_reviews (document_id) · ไม่แตะ kycStatus
   *
   * ไฟล์ของรูปเดิมที่เคยอนุมัติไม่ลบ — เป็นหลักฐานคู่กับแถว kyc_documents (approved) ของใบนั้น
   */
  async approve(documentId: string, admin: AuthUser): Promise<ProfilePhotoReviewResult> {
    const doc = await this.loadPendingDocument(documentId);
    const { userId, id: caregiverId } = doc.caregiver;
    const reviewedAt = new Date();

    await this.prismaService.$transaction(async (tx) => {
      await this.claimPending(tx, documentId, DOCUMENT_REVIEW_STATUS.APPROVED, reviewedAt);
      await tx.user.update({
        where: { id: userId },
        data: { avatarUrl: doc.fileUrl },
      });
      await tx.kycReview.create({
        data: {
          caregiverId,
          reviewerId: admin.id,
          action: PROFILE_PHOTO_REVIEW_ACTION.APPROVED,
          documentId,
          reviewedAt,
        },
      });
    });

    this.logger.log({
      event: 'admin.profile_photo.approved',
      documentId,
      caregiverId,
      adminId: admin.id,
    });

    void this.notify(
      userId,
      NotificationType.profile_photo_approved,
      'รูปโปรไฟล์ได้รับการอนุมัติแล้ว',
      'ผู้ใช้บริการจะเห็นรูปโปรไฟล์ใหม่ของคุณตั้งแต่ตอนนี้',
      { documentId, link: '/caregiver/edit-profile' },
    );

    return {
      documentId,
      caregiverId,
      reviewStatus: DOCUMENT_REVIEW_STATUS.APPROVED,
      reviewedAt,
    };
  }

  /**
   * ปฏิเสธรูป — ต้องมีเหตุผล · avatar_url ไม่เปลี่ยน (ยังเป็นรูปเดิมที่อนุมัติแล้ว หรือ null)
   * ไฟล์ที่ถูกปฏิเสธเก็บไว้ใน profile-photos เป็นหลักฐานคู่กับเหตุผลใน kyc_reviews
   */
  async reject(input: RejectProfilePhotoInput, admin: AuthUser): Promise<ProfilePhotoReviewResult> {
    const reason = input.reason?.trim() ?? '';
    if (!reason) {
      throw new BadRequestException('ต้องระบุเหตุผลที่ปฏิเสธ');
    }

    const doc = await this.loadPendingDocument(input.documentId);
    const { userId, id: caregiverId } = doc.caregiver;
    const reviewedAt = new Date();

    await this.prismaService.$transaction(async (tx) => {
      await this.claimPending(tx, input.documentId, DOCUMENT_REVIEW_STATUS.REJECTED, reviewedAt);
      await tx.kycReview.create({
        data: {
          caregiverId,
          reviewerId: admin.id,
          action: PROFILE_PHOTO_REVIEW_ACTION.REJECTED,
          reason,
          documentId: input.documentId,
          reviewedAt,
        },
      });
    });

    this.logger.log({
      event: 'admin.profile_photo.rejected',
      documentId: input.documentId,
      caregiverId,
      adminId: admin.id,
    });

    void this.notify(
      userId,
      NotificationType.profile_photo_rejected,
      'รูปโปรไฟล์ไม่ผ่านการตรวจสอบ',
      `เหตุผล: ${reason} — กรุณาอัปโหลดรูปใหม่`,
      { documentId: input.documentId, link: '/caregiver/edit-profile' },
    );

    return {
      documentId: input.documentId,
      caregiverId,
      reviewStatus: DOCUMENT_REVIEW_STATUS.REJECTED,
      reviewedAt,
    };
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  /** เอกสารต้องเป็นรูปโปรไฟล์ที่ผูกกับผู้ดูแลและยัง pending — ไม่งั้น 404 / 409 */
  private async loadPendingDocument(documentId: string) {
    const doc = await this.prismaService.kycDocument.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        documentType: true,
        reviewStatus: true,
        fileUrl: true,
        caregiver: { select: { id: true, userId: true } },
      },
    });

    if (!doc || doc.documentType !== PROFILE_PHOTO_DOC_TYPE || !doc.caregiver) {
      throw new NotFoundException(`Profile photo "${documentId}" not found`);
    }
    if (doc.reviewStatus !== DOCUMENT_REVIEW_STATUS.PENDING) {
      throw new ConflictException(
        `รูปนี้ไม่ได้อยู่ในสถานะรออนุมัติแล้ว (สถานะ: ${doc.reviewStatus ?? 'ไม่ระบุ'})`,
      );
    }
    return { ...doc, caregiver: doc.caregiver };
  }

  /** เปลี่ยน pending → สถานะใหม่แบบมีเงื่อนไข — ได้ 0 แถว = มีคนตัดสิน (หรือผู้ดูแลอัปใบใหม่) ไปก่อน */
  private async claimPending(
    tx: Prisma.TransactionClient,
    documentId: string,
    status: string,
    reviewedAt: Date,
  ): Promise<void> {
    const claimed = await tx.kycDocument.updateMany({
      where: { id: documentId, reviewStatus: DOCUMENT_REVIEW_STATUS.PENDING },
      data: { reviewStatus: status, reviewedAt },
    });
    if (claimed.count === 0) {
      throw new ConflictException('รูปนี้ถูกตัดสินไปแล้ว หรือผู้ดูแลอัปโหลดรูปใหม่แทน — กรุณารีเฟรช');
    }
  }

  /** sign ล้ม → null (FE แสดงว่าโหลดรูปไม่ได้) ไม่ throw ทิ้งทั้งหน้า */
  private async signPendingPhoto(path: string): Promise<string | null> {
    try {
      const { data, error } = await this.supabaseService
        .getAdminClient()
        .storage.from(PROFILE_PHOTOS_BUCKET)
        .createSignedUrl(path, SIGNED_URL_TTL_SEC);
      if (!error && data?.signedUrl) return data.signedUrl;
      this.logger.warn({
        event: 'profile_photo.sign_url_failed',
        bucket: PROFILE_PHOTOS_BUCKET,
        path,
        error: error?.message ?? 'no signedUrl returned',
      });
    } catch (err) {
      this.logger.warn({
        event: 'profile_photo.sign_url_failed',
        bucket: PROFILE_PHOTOS_BUCKET,
        path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }

  /** audit ล้ม = throw (ไม่ออก URL) — แพตเทิร์นเดียวกับ getDocumentsForAdminReview */
  private async auditPendingPhotoViewed(
    adminId: string,
    targetUserId: string,
    caregiverId: string,
    documentId: string,
  ): Promise<void> {
    const details = JSON.stringify({
      caregiverId,
      bucket: PROFILE_PHOTOS_BUCKET,
      ttlSeconds: SIGNED_URL_TTL_SEC,
      documentId,
    });

    await this.prismaService.$executeRaw`
      INSERT INTO admin_audit_logs (id, admin_id, action, target_user_id, details, created_at)
      VALUES (gen_random_uuid(), ${adminId}, 'profile_photo_viewed',
              ${targetUserId}, ${details}::jsonb, NOW())
    `;
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
        event: 'profile_photo.notify_failed',
        type,
        userId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
