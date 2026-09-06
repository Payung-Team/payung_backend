import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../common/supabase.service';
import { JOB_EVIDENCE_BUCKET, SIGNED_URL_TTL_SEC } from './monitoring.constants';

/**
 * JobEvidenceService — ตรวจสอบ path/URL ของไฟล์แนบใน bucket 'job-evidence' + ออก signed URL
 *
 * เดิมตรรกะนี้อยู่ใน MonitoringService (PYG-358 STEP 2) แยกออกมาที่นี่เพราะ PYG-361
 * (บันทึกจากผู้ดูแล) ต้องใช้กฎเดียวกันเป๊ะ ๆ — การ์ดสั่งตรง ๆ ว่าห้ามคัดลอกไปเขียนซ้ำ
 * ทั้ง MonitoringService.checkOutBooking และ CareLogService.addCareLog เรียกที่นี่ที่เดียว
 */
@Injectable()
export class JobEvidenceService {
  private readonly logger = new Logger(JobEvidenceService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly supabaseService: SupabaseService,
  ) {}

  /**
   * ตรวจไฟล์แนบให้ปลอดภัย แล้วคืนค่าเป็น "path" ที่จะเก็บลงฐานข้อมูล (ไม่ใช่ URL)
   *
   * ทำไมต้องตรวจเข้มขนาดนี้: ถ้ารับ URL อะไรก็ได้ ใครก็ตามที่ยิง API เป็นจะแปะลิงก์จากเว็บไหนก็ได้
   * ลงในบันทึกหลักฐาน/บันทึกดูแล — หลักฐานก็หมดความหมายทันที
   *
   * เงื่อนไขที่ต้องผ่าน "ครบทั้งสามข้อ" ถ้าส่งมาเป็น URL เต็ม:
   *   a) host ตรงกับโปรเจกต์ Supabase ของเรา
   *   b) bucket ใน path คือ 'job-evidence'
   *   c) path ขึ้นต้นด้วย '{bookingId}/'  ← กัน booking หนึ่งไปอ้างรูปของอีก booking
   *
   * ถ้าส่งมาเป็น path เปล่า ๆ ('{bookingId}/xxx.jpg') ก็รับได้ เพราะ path เปล่าชี้ออกนอกโดเมน
   * เราไม่ได้อยู่แล้ว แต่ยังต้องผ่านข้อ (c)
   *
   * @returns path ที่จะเก็บ หรือ null ถ้าไม่ได้แนบรูปมา (ไม่บังคับ)
   */
  validatePath(photoUrl: string | undefined, bookingId: string): string | null {
    if (!photoUrl) return null;

    const rejected = new BadRequestException('ไฟล์แนบไม่ถูกต้อง');

    let objectPath: string;

    if (photoUrl.includes('://')) {
      // ── ส่งมาเป็น URL เต็ม → ตรวจครบสามข้อ ──
      let parsed: URL;
      try {
        parsed = new URL(photoUrl);
      } catch {
        throw rejected; // แปลงเป็น URL ไม่ได้เลย
      }

      // (a) host ต้องเป็นของโปรเจกต์เรา
      const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
      if (!supabaseUrl) {
        // ไม่มี config = ตรวจไม่ได้ = ไม่รับ (ปลอดภัยไว้ก่อน)
        this.logger.error('SUPABASE_URL ไม่ได้ตั้งค่า — ปฏิเสธไฟล์แนบทั้งหมด');
        throw rejected;
      }
      if (parsed.host !== new URL(supabaseUrl).host) throw rejected;

      // (b) bucket ใน path ต้องเป็น job-evidence
      const marker = `/${JOB_EVIDENCE_BUCKET}/`;
      const markerAt = parsed.pathname.indexOf(marker);
      if (markerAt === -1) throw rejected;

      objectPath = decodeURIComponent(
        parsed.pathname.slice(markerAt + marker.length),
      );
    } else {
      // ── ส่งมาเป็น path เปล่า ── เผื่อ FE ส่งมาแบบมีชื่อ bucket นำหน้า ก็ตัดออกให้
      objectPath = photoUrl.startsWith(`${JOB_EVIDENCE_BUCKET}/`)
        ? photoUrl.slice(JOB_EVIDENCE_BUCKET.length + 1)
        : photoUrl;
    }

    // (c) ต้องอยู่ใต้โฟลเดอร์ของ booking นี้เท่านั้น
    if (!objectPath.startsWith(`${bookingId}/`)) throw rejected;

    // กัน path traversal (../) ที่อาจพาออกนอกโฟลเดอร์ตัวเอง
    if (objectPath.includes('..')) throw rejected;

    return objectPath;
  }

  /**
   * สร้าง signed URL ให้ไฟล์ใน bucket job-evidence (bucket เป็น private)
   * ⚠ ห้ามเก็บ public URL ลงฐานข้อมูลเด็ดขาด — เก็บเป็น path เปล่า ๆ แล้วค่อย sign ตอนอ่านทุกครั้ง
   */
  async sign(path: string): Promise<string | null> {
    const supabase = this.supabaseService.getClient();
    const { data, error } = await supabase.storage
      .from(JOB_EVIDENCE_BUCKET)
      .createSignedUrl(path, SIGNED_URL_TTL_SEC);

    if (error || !data?.signedUrl) {
      this.logger.warn({ event: 'job_evidence.sign_url_failed', path });
      return null;
    }
    return data.signedUrl;
  }
}
