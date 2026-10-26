import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { SupabaseService } from '../common/supabase.service';
import {
  PROFILE_PHOTOS_BUCKET,
  PROFILE_PHOTO_MIME,
} from '../identity/kyc/profile-photo.constants';
import {
  prepareProfilePhotoJpeg,
  type UploadedProfilePhoto,
} from '../identity/kyc/profile-photo.service';
import { SIGNED_URL_TTL_SEC } from '../monitoring/monitoring.constants';
import { GROUP_ROLE, MEMBER_STATUS } from './family-group.constants';
import { NotGroupOwnerError } from './family-group.errors';

/**
 * ไฟล์ของกลุ่มหนึ่งอยู่ที่ path ตายตัว — ไม่มีคอลัมน์ในตาราง family_groups
 * มีไฟล์ = กลุ่มนี้ตั้งรูปแล้ว · ไม่มีไฟล์ = ใช้ตัวอักษรย่อ
 */
export function familyGroupAvatarPath(groupId: string): string {
  return `family-groups/${groupId}/avatar.jpg`;
}

/**
 * อายุ cache ของไฟล์ (วินาที) — เขียนทับ path เดิมทุกครั้งที่เปลี่ยนรูป
 * ตั้งสั้นไว้ไม่ให้ CDN เสิร์ฟรูปเก่านานหลังเปลี่ยน
 */
const AVATAR_CACHE_CONTROL_SEC = '60';

export interface FamilyGroupAvatarResult {
  /** signed URL ของรูปที่เพิ่งอัป (หมดอายุ 1 ชม.) — null ถ้า sign ไม่สำเร็จ */
  avatarUrl: string | null;
}

/**
 * FamilyGroupAvatarService — รูปของกลุ่มครอบครัว (เจ้าของกลุ่มเปลี่ยน/ลบได้)
 *
 * ★ ไม่ต้อง migrate: ใช้ bucket private 'profile-photos' เดิม (JPEG ≤ 5 MB, เขียนด้วย service-role เท่านั้น)
 *   และรู้ว่ากลุ่มมีรูปไหมจากการมีไฟล์ที่ path ตายตัว — Storage ตอบ "ไม่พบไฟล์" ตอน sign = ยังไม่ตั้งรูป
 *
 * ★ ไม่เขียนฟีดกิจกรรม: action ของ family_group_activity ถูกล็อกด้วย CHECK constraint
 *   เพิ่มชนิดใหม่ต้อง migrate
 */
@Injectable()
export class FamilyGroupAvatarService {
  private readonly logger = new Logger(FamilyGroupAvatarService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabaseService: SupabaseService,
  ) {}

  /** REST — controller ตรวจ JWT และรูปแบบ UUID ของ groupId มาแล้ว */
  async upload(
    userId: string,
    groupId: string,
    photo: UploadedProfilePhoto | undefined,
  ): Promise<FamilyGroupAvatarResult> {
    if (!(await this.isActiveOwner(userId, groupId))) {
      // ไม่แยก "ไม่มีกลุ่มนี้" กับ "ไม่ใช่เจ้าของ" — กันเดา id กลุ่ม
      throw new ForbiddenException(
        'เฉพาะเจ้าของกลุ่มเท่านั้นที่เปลี่ยนรูปกลุ่มได้',
      );
    }
    if (!photo) {
      throw new BadRequestException('ต้องแนบไฟล์รูปในฟิลด์ photo');
    }
    const bytes = prepareProfilePhotoJpeg(photo);
    const path = familyGroupAvatarPath(groupId);

    const { error } = await this.supabaseService
      .getAdminClient()
      .storage.from(PROFILE_PHOTOS_BUCKET)
      .upload(path, bytes, {
        contentType: PROFILE_PHOTO_MIME,
        upsert: true,
        cacheControl: AVATAR_CACHE_CONTROL_SEC,
      });

    if (error) {
      this.logger.error({
        event: 'family_group_avatar.upload_failed',
        bucket: PROFILE_PHOTOS_BUCKET,
        groupId,
        userId,
        reason: error.message,
      });
      throw new InternalServerErrorException(
        'อัปโหลดรูปไม่สำเร็จ กรุณาลองใหม่',
      );
    }

    return { avatarUrl: await this.signedUrl(groupId) };
  }

  /** GraphQL — guard ตรวจ OWNER มาแล้ว ที่นี่ตรวจซ้ำชั้นที่สองแบบเดียวกับ rename */
  async remove(userId: string, groupId: string): Promise<void> {
    if (!(await this.isActiveOwner(userId, groupId))) {
      throw new NotGroupOwnerError();
    }
    const reason = await this.removeFile(groupId);
    if (reason) {
      this.logger.error({
        event: 'family_group_avatar.remove_failed',
        bucket: PROFILE_PHOTOS_BUCKET,
        groupId,
        userId,
        reason,
      });
      throw new InternalServerErrorException(
        'ลบรูปกลุ่มไม่สำเร็จ กรุณาลองใหม่',
      );
    }
  }

  /** หลังลบกลุ่ม — ไฟล์ไม่ถูกลบตาม FK ของดีบี ต้องลบเอง · ล้มแค่ log ไม่ทำให้การลบกลุ่มล้ม */
  async removeQuietly(groupId: string): Promise<void> {
    const reason = await this.removeFile(groupId);
    if (reason) {
      this.logger.error({
        event: 'family_group_avatar.orphan_file',
        bucket: PROFILE_PHOTOS_BUCKET,
        groupId,
        reason,
      });
    }
  }

  /**
   * signed URL ของรูปกลุ่ม — null ถ้ายังไม่ตั้งรูป หรือ sign ไม่สำเร็จ (FE ตกเป็นตัวอักษรย่อ)
   * ไม่ throw: รูปกลุ่มไม่ควรทำให้ query ล้มทั้งก้อน
   */
  async signedUrl(groupId: string): Promise<string | null> {
    try {
      const { data, error } = await this.supabaseService
        .getAdminClient()
        .storage.from(PROFILE_PHOTOS_BUCKET)
        .createSignedUrl(familyGroupAvatarPath(groupId), SIGNED_URL_TTL_SEC);

      if (error || !data?.signedUrl) {
        // ไม่มีไฟล์ = กลุ่มนี้ยังไม่ตั้งรูป เป็นเรื่องปกติ ไม่ต้อง log
        if (error && isObjectNotFound(error)) return null;
        this.logSignFailure(groupId, error?.message ?? 'no signedUrl returned');
        return null;
      }
      return data.signedUrl;
    } catch (err) {
      this.logSignFailure(
        groupId,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  private async isActiveOwner(
    userId: string,
    groupId: string,
  ): Promise<boolean> {
    const owner = await this.prisma.familyGroupMember.findFirst({
      where: {
        groupId,
        userId,
        role: GROUP_ROLE.OWNER,
        status: MEMBER_STATUS.ACTIVE,
      },
      select: { id: true },
    });
    return owner !== null;
  }

  /** คืนเหตุผลถ้าลบไม่สำเร็จ · ลบไฟล์ที่ไม่มีอยู่ Storage ไม่ถือเป็น error */
  private async removeFile(groupId: string): Promise<string | null> {
    try {
      const { error } = await this.supabaseService
        .getAdminClient()
        .storage.from(PROFILE_PHOTOS_BUCKET)
        .remove([familyGroupAvatarPath(groupId)]);
      return error ? error.message : null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  private logSignFailure(groupId: string, reason: string): void {
    this.logger.warn({
      event: 'family_group_avatar.sign_failed',
      bucket: PROFILE_PHOTOS_BUCKET,
      groupId,
      reason,
    });
  }
}

/** Storage ตอบ "ไม่พบไฟล์" เป็น HTTP 400 ที่มี statusCode '404' ในเนื้อหา */
function isObjectNotFound(error: { message?: string }): boolean {
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return (
    String(statusCode) === '404' || /not\s*found/i.test(error.message ?? '')
  );
}
