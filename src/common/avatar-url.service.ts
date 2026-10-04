/**
 * AvatarUrlService — แปลงค่า avatar_url (storage path) ให้เป็น URL ที่ <img> โหลดได้
 *
 * avatar_url เก็บได้ 2 แบบ:
 * - URL เต็ม (Google OAuth, หรือ bucket public เดิม) → คืนตามนั้น
 * - storage path ใน private bucket → ต้อง sign ก่อน ไม่งั้น FE ได้ path ดิบแล้ว <img> โหลดไม่ขึ้น
 *
 * ★ ทุกที่ที่ส่ง avatarUrl ออก GraphQL/REST ต้องผ่านตัวนี้
 *   (User.avatarUrl, สมาชิกกลุ่มครอบครัว, ผู้ลงมือในฟีดกิจกรรม, caregiver brief ในผลค้นหา/ใบจอง)
 *   เคยลืมในกลุ่มครอบครัว → หน้าสมาชิกโชว์แต่ตัวอักษรย่อ ทั้งที่ header ขึ้นรูปปกติ
 *
 * sign ล้ม → คืน null ให้ FE ตก fallback เป็นตัวอักษรย่อ ไม่ throw ทิ้งทั้ง query
 * เพราะรูปโปรไฟล์ไม่ควรทำให้ query ล้มทั้งก้อน
 *
 * PYG-508 — รูปโปรไฟล์ทุก role อยู่ bucket เดียว: PROFILE_PHOTOS_BUCKET ('profile-photos')
 * - role อื่น: อัปแล้วตั้ง users.avatar_url ทันที
 * - ผู้ดูแล: อัปแล้วรอรีวิวใน kyc_documents · แอดมินอนุมัติ = ตั้ง users.avatar_url เป็น path ของใบนั้น
 *   (ไม่ย้ายไฟล์) — รูปที่ยังไม่อนุมัติจึงไม่มีทางถูก sign ออกจากที่นี่ เพราะ path ไม่เคยอยู่ใน avatar_url
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
   * @param stored ค่าดิบจาก users.avatar_url (ทุก role)
   * @param ownerId ใช้ใน log อย่างเดียว
   */
  async resolve(stored: string | null | undefined, ownerId?: string): Promise<string | null> {
    const bucket = PROFILE_PHOTOS_BUCKET;
    if (!stored) {
      return null;
    }
    if (stored.startsWith('http://') || stored.startsWith('https://')) {
      return stored;
    }

    try {
      const { data, error } = await this.supabaseService
        .getAdminClient()
        .storage.from(bucket)
        .createSignedUrl(stored, AVATAR_SIGNED_URL_TTL_SEC);

      if (error || !data?.signedUrl) {
        this.logger.warn({
          event: 'avatar.sign_failed',
          bucket,
          ownerId,
          reason: error?.message ?? 'no signedUrl returned',
        });
        return null;
      }
      return data.signedUrl;
    } catch (err) {
      this.logger.warn({
        event: 'avatar.sign_failed',
        bucket,
        ownerId,
        reason: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * เซ็น avatar ของหลายรายการพร้อมกัน — createSignedUrls ครั้งเดียว ไม่ยิงทีละรูป
   * (ผลค้นหา / ใบจองหลายใบ / สมาชิกกลุ่มครอบครัว ฯลฯ)
   *
   * คืน Map จาก "ตัว item เอง" (object identity) → signed URL หรือ null
   * ใช้ identity ของ item เป็น key แทน id เพื่อให้ generic กับทุกรูปทรง DTO
   * โดยไม่ต้องบังคับให้ทุกที่มีฟิลด์ id ชื่อเดียวกัน
   *
   * @param items รายการต้นฉบับ (แถวจาก DB หรือ DTO ก็ได้)
   * @param getPath ดึงค่าดิบจาก avatar_url ของแต่ละ item
   * @param bucket มีค่าเดียวที่ใช้ได้ (profile-photos) — คงพารามิเตอร์ไว้ให้ผู้เรียกเดิมไม่ต้องแก้
   */
  async resolveMany<T>(
    items: readonly T[],
    getPath: (item: T) => string | null | undefined,
    bucket: typeof PROFILE_PHOTOS_BUCKET = PROFILE_PHOTOS_BUCKET,
  ): Promise<Map<T, string | null>> {
    const result = new Map<T, string | null>();
    // dedup ตาม path จริง — หลาย item อาจชี้ path เดียวกัน ไม่ควร sign ซ้ำ
    const itemsByPath = new Map<string, T[]>();

    for (const item of items) {
      const stored = getPath(item);
      if (!stored) {
        result.set(item, null);
        continue;
      }
      if (stored.startsWith('http://') || stored.startsWith('https://')) {
        result.set(item, stored);
        continue;
      }
      const bucketItems = itemsByPath.get(stored);
      if (bucketItems) {
        bucketItems.push(item);
      } else {
        itemsByPath.set(stored, [item]);
      }
    }

    const paths = [...itemsByPath.keys()];
    if (paths.length === 0) {
      return result;
    }

    try {
      const { data, error } = await this.supabaseService
        .getAdminClient()
        .storage.from(bucket)
        .createSignedUrls(paths, AVATAR_SIGNED_URL_TTL_SEC);

      if (error || !data) {
        this.logger.warn({
          event: 'avatar.sign_batch_failed',
          bucket,
          count: paths.length,
          reason: error?.message ?? 'no data returned',
        });
        for (const path of paths) {
          for (const item of itemsByPath.get(path)!) result.set(item, null);
        }
        return result;
      }

      const signedByPath = new Map(data.map((d) => [d.path ?? '', d]));
      for (const path of paths) {
        const signed = signedByPath.get(path);
        const url = signed && !signed.error ? (signed.signedUrl ?? null) : null;
        if (!url) {
          this.logger.warn({
            event: 'avatar.sign_failed',
            bucket,
            path,
            reason: signed?.error ?? 'no signedUrl returned',
          });
        }
        for (const item of itemsByPath.get(path)!) result.set(item, url);
      }
    } catch (err) {
      this.logger.warn({
        event: 'avatar.sign_batch_failed',
        bucket,
        count: paths.length,
        reason: err instanceof Error ? err.message : String(err),
      });
      for (const path of paths) {
        for (const item of itemsByPath.get(path)!) result.set(item, null);
      }
    }

    return result;
  }
}
