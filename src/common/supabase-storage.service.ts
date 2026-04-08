/**
 * SupabaseStorageService — จัดการ File Upload ไปยัง Supabase Storage
 *
 * ทำไมใช้ service_role key แทน anon key?
 * - anon key มี Row Level Security (RLS) → upload ได้เฉพาะเมื่อ user มี session ที่ถูกต้อง
 * - service_role key ข้าม RLS ทั้งหมด → เหมาะกับ server-side upload ที่ backend ควบคุม
 * - Backend ทำ validation เอง (size, mime) แล้วจึง upload → ปลอดภัย
 *
 * Bucket: kyc-documents (ต้องสร้างใน Supabase Dashboard ก่อนใช้)
 * Path format: {userId}/{timestamp}_{filename}
 */
import {
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const BUCKET = 'kyc-documents';
const SIGNED_URL_EXPIRY_SECONDS = 3600; // 1 ชั่วโมง

@Injectable()
export class SupabaseStorageService {
  private adminClient: SupabaseClient;

  constructor(private configService: ConfigService) {
    const url = this.configService.getOrThrow<string>('SUPABASE_URL');
    const serviceKey = this.configService.getOrThrow<string>(
      'SUPABASE_SERVICE_ROLE_KEY',
    );

    // service_role client — bypass RLS สำหรับ server-side operations
    this.adminClient = createClient(url, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /**
   * Upload ไฟล์ไปยัง Supabase Storage แล้วคืน signed URL (อายุ 1 ชั่วโมง)
   *
   * @param buffer      - ไฟล์ในรูปแบบ Buffer
   * @param storagePath - path ใน bucket เช่น "userId/1234_passport.jpg"
   * @param mimeType    - MIME type เช่น "image/jpeg"
   * @returns           - Signed URL สำหรับ read ไฟล์
   */
  async uploadFile(
    buffer: Buffer,
    storagePath: string,
    mimeType: string,
  ): Promise<string> {
    // ── Step 1: Upload ไฟล์ไปยัง bucket ─────────────────────────────
    const { error: uploadError } = await this.adminClient.storage
      .from(BUCKET)
      .upload(storagePath, buffer, {
        contentType: mimeType,
        upsert: false, // ไม่ทับไฟล์เดิม (timestamp ใน path ป้องกัน collision แล้ว)
      });

    if (uploadError) {
      throw new InternalServerErrorException(
        `อัปโหลดไฟล์ล้มเหลว: ${uploadError.message}`,
      );
    }

    // ── Step 2: สร้าง signed URL สำหรับ read ──────────────────────
    const { data, error: urlError } = await this.adminClient.storage
      .from(BUCKET)
      .createSignedUrl(storagePath, SIGNED_URL_EXPIRY_SECONDS);

    if (urlError || !data?.signedUrl) {
      throw new InternalServerErrorException('ไม่สามารถสร้าง URL สำหรับเข้าถึงไฟล์ได้');
    }

    return data.signedUrl;
  }
}
