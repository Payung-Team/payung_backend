import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { SupabaseService } from '../../common/supabase.service';
import { ROLE_ID } from '../../common/constants/roles.constant';
import {
  hasJpegSignature,
  InvalidJpegError,
  stripJpegMetadata,
} from '../../monitoring/care-log-photo.util';
import { SIGNED_URL_TTL_SEC } from '../../monitoring/monitoring.constants';
import {
  DOCUMENT_REVIEW_STATUS,
  PROFILE_PHOTOS_BUCKET,
  PROFILE_PHOTO_DOC_TYPE,
  PROFILE_PHOTO_MIME,
} from './profile-photo.constants';

/** ไฟล์ที่ multer ส่งมา (รูปทรงเดียวกับที่ CareLogService ใช้) */
export type UploadedProfilePhoto = Pick<
  Express.Multer.File,
  'buffer' | 'mimetype' | 'size' | 'originalname'
>;

export interface ProfilePhotoResult {
  /** 'approved' = แสดงต่อผู้ใช้อื่นแล้ว (role อื่น), 'pending' = รอแอดมินอนุมัติ (ผู้ดูแล) */
  reviewStatus: string;
  /** signed URL ของรูปที่เพิ่งอัปโหลด — ให้เจ้าตัวดูรูปของตัวเอง (หมดอายุ 1 ชม.) */
  photoUrl: string | null;
}

/**
 * ProfilePhotoService — อัปโหลดรูปโปรไฟล์ผ่าน backend (PYG-507 / การ์ดแม่ PYG-488)
 *
 * ทำไมต้องผ่าน backend: เดิม `updateProfile(avatarUrl)` รับ URL อะไรก็ได้ที่ผ่าน @IsUrl
 * → ผู้ดูแลแปะรูปใครก็ได้โดยไม่มีใครตรวจ ซึ่งขัดกับ requirement ที่ว่ารูปผู้ดูแลต้องผ่านแอดมิน
 *
 * กฎตาม role:
 *   - ผู้ดูแล (role 2) → เข้าคิวรีวิว: สร้างแถว kyc_documents (doc_type = profile_photo,
 *     review_status = pending) และ **ไม่แตะ users.avatar_url** — ผู้ใช้อื่นยังเห็นรูปเดิมที่อนุมัติแล้ว
 *   - role อื่น → ตั้ง users.avatar_url ทันที ไม่ต้องรีวิว
 *
 * ลำดับ: ตรวจไฟล์ → อัปโหลดเข้า storage → เขียน DB
 *   เขียน DB ล้ม → ลบไฟล์ที่เพิ่งอัปโหลด แล้ว throw error เดิม (แพตเทิร์นเดียวกับ CareLogService)
 */
@Injectable()
export class ProfilePhotoService {
  private readonly logger = new Logger(ProfilePhotoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabaseService: SupabaseService,
  ) {}

  async upload(
    userId: string,
    role: number,
    photo: UploadedProfilePhoto | undefined,
  ): Promise<ProfilePhotoResult> {
    if (!photo) {
      throw new BadRequestException('ต้องแนบไฟล์รูปในฟิลด์ photo');
    }
    const bytes = this.prepare(photo);

    const caregiver =
      role === ROLE_ID.CAREGIVER
        ? await this.prisma.caregiver.findUnique({
            where: { userId },
            select: { id: true },
          })
        : null;

    if (role === ROLE_ID.CAREGIVER && !caregiver) {
      throw new ForbiddenException('ไม่พบโปรไฟล์ผู้ดูแลของบัญชีนี้');
    }

    // TODO(PYG-503/PYG-473): ผู้ดูแลต้องมี consent 'sensitive_biometric' ก่อนอัปโหลดรูปใบหน้า
    //   ยังไม่มีตาราง consent ในระบบ — จุดเสียบอยู่ตรงนี้ ห้ามปล่อยให้อัปโหลดผ่านหลังตาราง consent ขึ้น

    const path = `${userId}/profile-${randomUUID()}.jpg`;
    await this.uploadToStorage(path, bytes, userId);

    try {
      if (caregiver) {
        await this.queueForReview(caregiver.id, userId, path, bytes.length);
      } else {
        await this.setAvatarDirectly(userId, path);
      }
    } catch (writeError) {
      await this.removeOrphan(path, userId);
      throw writeError;
    }

    return {
      reviewStatus: caregiver
        ? DOCUMENT_REVIEW_STATUS.PENDING
        : DOCUMENT_REVIEW_STATUS.APPROVED,
      photoUrl: await this.sign(path),
    };
  }

  /**
   * ผู้ดูแล: แถว pending เดิมถูกแทนที่ด้วยใบใหม่ — คิวของแอดมินต้องมีของคนนี้ได้ใบเดียว
   * ไฟล์ของใบเก่าลบหลัง transaction สำเร็จ (ลบไม่ได้ = log ไว้ ไม่ทำให้คำขอล้ม)
   */
  private async queueForReview(
    caregiverId: string,
    userId: string,
    path: string,
    fileSize: number,
  ): Promise<void> {
    const stalePaths = await this.prisma.$transaction(async (tx) => {
      const pending = await tx.kycDocument.findMany({
        where: {
          caregiverId,
          documentType: PROFILE_PHOTO_DOC_TYPE,
          reviewStatus: DOCUMENT_REVIEW_STATUS.PENDING,
        },
        select: { id: true, fileUrl: true },
      });

      if (pending.length > 0) {
        await tx.kycDocument.deleteMany({
          where: { id: { in: pending.map((doc) => doc.id) } },
        });
      }

      await tx.kycDocument.create({
        data: {
          caregiverId,
          userId,
          documentType: PROFILE_PHOTO_DOC_TYPE,
          fileUrl: path,
          fileName: path.split('/').pop() ?? 'profile.jpg',
          fileSize,
          mimeType: PROFILE_PHOTO_MIME,
          reviewStatus: DOCUMENT_REVIEW_STATUS.PENDING,
        },
      });

      // เฉพาะไฟล์ใน bucket ของการ์ดนี้ — ใบเก่าจาก flow อื่นไม่ใช่ของเราไปลบ
      return pending
        .map((doc) => doc.fileUrl)
        .filter((fileUrl) => fileUrl.startsWith(`${userId}/`));
    });

    for (const stale of stalePaths) {
      await this.removeOrphan(stale, userId);
    }
  }

  /** role อื่น: แสดงทันที — ลบไฟล์เดิมใน bucket นี้ทิ้ง (ค่าเก่าที่เป็น URL ภายนอกปล่อยไว้) */
  private async setAvatarDirectly(userId: string, path: string): Promise<void> {
    const previous = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { avatarUrl: true },
    });

    await this.prisma.user.update({
      where: { id: userId },
      data: { avatarUrl: path },
    });

    const old = previous?.avatarUrl;
    if (old && old !== path && old.startsWith(`${userId}/`)) {
      await this.removeOrphan(old, userId);
    }
  }

  /** MIME จาก client ปลอมได้ — signature จาก buffer คือด่านจริง แล้วค่อยตัด EXIF/GPS ทิ้ง */
  private prepare(photo: UploadedProfilePhoto): Buffer {
    if (photo.mimetype !== PROFILE_PHOTO_MIME) {
      throw new UnsupportedMediaTypeException('รองรับเฉพาะรูป JPEG');
    }
    if (!photo.buffer || photo.buffer.length === 0) {
      throw new BadRequestException('ไฟล์รูปว่างเปล่า');
    }
    if (!hasJpegSignature(photo.buffer)) {
      throw new UnsupportedMediaTypeException('ไฟล์ไม่ใช่รูป JPEG');
    }
    try {
      return stripJpegMetadata(photo.buffer);
    } catch (err) {
      if (err instanceof InvalidJpegError) {
        throw new UnsupportedMediaTypeException('ไฟล์ JPEG เสียหาย');
      }
      throw err;
    }
  }

  private async uploadToStorage(
    path: string,
    bytes: Buffer,
    userId: string,
  ): Promise<void> {
    const { error } = await this.supabaseService
      .getAdminClient()
      .storage.from(PROFILE_PHOTOS_BUCKET)
      .upload(path, bytes, { contentType: PROFILE_PHOTO_MIME, upsert: false });

    if (error) {
      this.logger.error({
        event: 'profile_photo.upload_failed',
        bucket: PROFILE_PHOTOS_BUCKET,
        path,
        userId,
        reason: error.message,
      });
      throw new InternalServerErrorException(
        'อัปโหลดรูปไม่สำเร็จ กรุณาลองใหม่',
      );
    }
  }

  /** sign ล้ม → คืน null ไม่ throw (รูปอัปโหลดขึ้นแล้ว คำขอไม่ควรล้มเพราะ URL ชั่วคราว) */
  private async sign(path: string): Promise<string | null> {
    try {
      const { data, error } = await this.supabaseService
        .getAdminClient()
        .storage.from(PROFILE_PHOTOS_BUCKET)
        .createSignedUrl(path, SIGNED_URL_TTL_SEC);

      if (error || !data?.signedUrl) {
        this.logSignFailure(path, error?.message ?? 'no signedUrl returned');
        return null;
      }
      return data.signedUrl;
    } catch (err) {
      this.logSignFailure(
        path,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  private logSignFailure(path: string, message: string): void {
    this.logger.warn({
      event: 'profile_photo.sign_url_failed',
      bucket: PROFILE_PHOTOS_BUCKET,
      path,
      error: message,
    });
  }

  private async removeOrphan(path: string, userId: string): Promise<void> {
    let reason: string;
    try {
      const { error } = await this.supabaseService
        .getAdminClient()
        .storage.from(PROFILE_PHOTOS_BUCKET)
        .remove([path]);
      if (!error) return;
      reason = error.message;
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }

    this.logger.error({
      event: 'profile_photo.orphan_file',
      bucket: PROFILE_PHOTOS_BUCKET,
      path,
      userId,
      reason,
    });
  }
}
