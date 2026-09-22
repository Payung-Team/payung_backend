/**
 * AvatarUrlService — แปลงค่า users.avatar_url ให้เป็น URL ที่ <img> โหลดได้
 *
 * users.avatar_url เก็บได้ 2 แบบ:
 * - URL เต็ม (Google OAuth, หรือ bucket public เดิม) → คืนตามนั้น
 * - storage path ใน bucket profile-photos ซึ่งเป็น private (PYG-507)
 *   → ต้อง sign ก่อน ไม่งั้น FE ได้ path ดิบแล้ว <img> โหลดไม่ขึ้น
 *
 * ★ ทุกที่ที่ส่ง avatarUrl ของ user ออก GraphQL ต้องผ่านตัวนี้
 *   (User.avatarUrl, สมาชิกกลุ่มครอบครัว, ผู้ลงมือในฟีดกิจกรรม)
 *   เคยลืมในกลุ่มครอบครัว → หน้าสมาชิกโชว์แต่ตัวอักษรย่อ ทั้งที่ header ขึ้นรูปปกติ
 *
 * sign ล้ม → คืน null ให้ FE ตก fallback เป็นตัวอักษรย่อ ไม่ throw ทิ้งทั้ง query
 * เพราะรูปโปรไฟล์ไม่ควรทำให้ query ล้มทั้งก้อน
 */
import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from './supabase.service';
import { PROFILE_PHOTOS_BUCKET } from '../identity/kyc/profile-photo.constants';

/** อายุ signed URL ของรูปโปรไฟล์ — เท่ากับฝั่งอัปโหลด (profile-photo.service) */
const AVATAR_SIGNED_URL_TTL_SEC = 3600;

@Injectable()
export class AvatarUrlService {
  private readonly logger = new Logger(AvatarUrlService.name);

  constructor(private readonly supabaseService: SupabaseService) {}

  /**
   * @param stored ค่าดิบจาก users.avatar_url
   * @param userId ใช้ใน log อย่างเดียว
   */
  async resolve(
    stored: string | null | undefined,
    userId?: string,
  ): Promise<string | null> {
    if (!stored) {
      return null;
    }
    if (stored.startsWith('http://') || stored.startsWith('https://')) {
      return stored;
    }

    try {
      const { data, error } = await this.supabaseService
        .getAdminClient()
        .storage.from(PROFILE_PHOTOS_BUCKET)
        .createSignedUrl(stored, AVATAR_SIGNED_URL_TTL_SEC);

      if (error || !data?.signedUrl) {
        this.logger.warn({
          event: 'avatar.sign_failed',
          userId,
          reason: error?.message ?? 'no signedUrl returned',
        });
        return null;
      }
      return data.signedUrl;
    } catch (err) {
      this.logger.warn({
        event: 'avatar.sign_failed',
        userId,
        reason: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
