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
 * PYG-518 — สอง bucket แยกตามความหมาย ห้ามใช้สลับกัน:
 * - PROFILE_PHOTOS_BUCKET  ('profile-photos') — รูปที่อัปผ่าน backend ของ role ที่ไม่ใช่ผู้ดูแล
 *   (ตั้ง users.avatar_url ทันที ไม่ต้องรีวิว) และเป็นที่พักรูป "รอรีวิว" ของผู้ดูแลใน kyc_documents
 *   (ยังไม่อนุมัติ — ห้าม sign ฟิลด์นี้ออก resolver สาธารณะเด็ดขาด)
 * - CAREGIVER_AVATARS_BUCKET ('caregiver-avatars') — รูปโปรไฟล์ผู้ดูแลที่ "อนุมัติแล้ว" เท่านั้น
 *   users.avatar_url ของผู้ดูแลจะชี้มาที่ bucket นี้หลังแอดมินอนุมัติ (ดู subtask อนุมัติรูป — ยังไม่ทำ)
 *   ทุกจุดที่ส่ง avatarUrl ของ "ผู้ดูแล" (ผลค้นหา, ใบจอง, public profile) ต้อง sign กับ bucket นี้
 */
import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from './supabase.service';
import { PROFILE_PHOTOS_BUCKET } from '../identity/kyc/profile-photo.constants';

/** อายุ signed URL ของรูปโปรไฟล์ — เท่ากับฝั่งอัปโหลด (profile-photo.service) */
const AVATAR_SIGNED_URL_TTL_SEC = 3600;

/** PYG-518 — bucket รูปโปรไฟล์ผู้ดูแลที่อนุมัติแล้วเท่านั้น (private, เขียนได้เฉพาะ flow อนุมัติ) */
export const CAREGIVER_AVATARS_BUCKET = 'caregiver-avatars';

export type AvatarBucket =
  | typeof PROFILE_PHOTOS_BUCKET
  | typeof CAREGIVER_AVATARS_BUCKET;

@Injectable()
export class AvatarUrlService {
  private readonly logger = new Logger(AvatarUrlService.name);

  constructor(private readonly supabaseService: SupabaseService) {}

  /**
   * @param stored ค่าดิบจาก avatar_url (ของ role ที่ไม่ใช่ผู้ดูแล — patient/family/admin)
   * @param ownerId ใช้ใน log อย่างเดียว
   */
  resolve(stored: string | null | undefined, ownerId?: string): Promise<string | null> {
    return this.resolveFromBucket(stored, PROFILE_PHOTOS_BUCKET, ownerId);
  }

  /**
   * เหมือน resolve() แต่ sign กับ bucket 'caregiver-avatars' — ใช้เฉพาะ avatarUrl
   * ของ "ผู้ดูแล" (caregiver.user.avatarUrl) เท่านั้น ห้ามใช้กับ role อื่น
   */
  resolveCaregiverAvatar(
    stored: string | null | undefined,
    ownerId?: string,
  ): Promise<string | null> {
    return this.resolveFromBucket(stored, CAREGIVER_AVATARS_BUCKET, ownerId);
  }

  private async resolveFromBucket(
    stored: string | null | undefined,
    bucket: AvatarBucket,
    ownerId?: string,
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
   * @param bucket bucket ที่จะ sign — เลือกผิด bucket = ได้ 404 เงียบ ๆ (ดู comment หัวไฟล์)
   */
  async resolveMany<T>(
    items: readonly T[],
    getPath: (item: T) => string | null | undefined,
    bucket: AvatarBucket,
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
