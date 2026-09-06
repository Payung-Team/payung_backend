/**
 * KycStorageAuditCron — ตรวจ invariant ของ kyc_documents.file_url ทุกวัน
 *
 * ── ทำไมต้องเป็น cron ไม่ใช่ CI ──────────────────────────────────────────────
 * repo นี้ยังไม่มี CI เลย (ไม่มี .github/workflows) — เทสต์ทั้งหมดรันแค่เครื่อง dev
 * ถ้าวาง invariant check ไว้เป็นสคริปต์ที่ "ให้ CI รัน" มันจะไม่มีใครรันจริง
 * แอปนี้มี @Cron ที่ทำงานอยู่แล้ว (reconciliation, payout worker) จึงใช้เส้นนั้น
 * ซึ่งยิงใส่ DB จริงทุกวันโดยไม่ต้องพึ่ง infra ใหม่
 *
 * ── ตรวจอะไร ────────────────────────────────────────────────────────────────
 * CHECK constraint ในตารางตรวจ "รูปแบบ" ของค่าได้ แต่ตรวจ "ความเป็นเจ้าของ"
 * ไม่ได้ เพราะต้อง join users ซึ่ง Postgres ไม่อนุญาตใน CHECK
 * cron นี้จึงรับหน้าที่ข้อที่ CHECK ทำไม่ได้ + ทวนข้อที่ทำได้อีกรอบ
 * (เผื่อมีคน ALTER ... DROP CONSTRAINT หรือแถวหลุดเข้ามาทางอื่น)
 *
 * อ่านอย่างเดียว ไม่แก้ข้อมูล — เจอปัญหาแล้ว log ERROR ให้คนมาดู
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma.service';
import { NotificationService } from '../../notification/notification.service';
import { NotificationType } from '../../notification/entities/notification-type.enum';
import { ROLE_ID } from '../../common/constants/roles.constant';

/**
 * แถว fixture ที่จงใจเก็บไว้เป็นหลักฐานของช่องโหว่เดิม (URL ภายนอก)
 * ยกเว้นจากการนับ ไม่งั้น cron จะเตือนทุกวันเรื่องที่เรารู้อยู่แล้ว
 */
const FIXTURE_DOCUMENT_ID = '87d7fa1c-caf2-4de5-ac0c-e4315a5c76b8';

type InvariantRow = {
  full_urls: bigint;
  traversal: bigint;
  leading_slash: bigint;
  no_folder: bigint;
  cross_user: bigint;
};

@Injectable()
export class KycStorageAuditCron {
  private readonly logger = new Logger(KycStorageAuditCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  @Cron(process.env['CRON_KYC_STORAGE_AUDIT'] ?? '30 4 * * *')
  async run(): Promise<void> {
    try {
      const result = await this.check();
      const total =
        result.full_urls +
        result.traversal +
        result.leading_slash +
        result.no_folder +
        result.cross_user;

      if (total > 0n) {
        // ★ cross_user > 0 = มีคนใช้ช่องโหว่ IDOR ไปแล้ว ต้องรีบดูที่สุด
        this.logger.error(
          `[KycStorageAudit] พบแถวที่ผิด invariant — ` +
            `full_urls=${result.full_urls} traversal=${result.traversal} ` +
            `leading_slash=${result.leading_slash} no_folder=${result.no_folder} ` +
            `cross_user=${result.cross_user}` +
            (result.cross_user > 0n
              ? ' ← มีเอกสารชี้ไปโฟลเดอร์ของผู้ใช้รายอื่น ตรวจสอบด่วน'
              : ''),
        );

        // ★ log ERROR ที่ไม่มีใครเปิดอ่านตอนตีสี่ครึ่ง = สคริปต์ที่ไม่มีใครรัน
        //   ต้องมีเส้นที่คนเห็นจริง → notification เข้าระบบให้ super admin
        await this.alertSuperAdmins(result);
        return;
      }

      this.logger.log('[KycStorageAudit] invariant ครบถ้วน ไม่พบแถวผิดปกติ');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // ตรวจไม่ได้ ≠ ไม่มีปัญหา — ต้องดังพอให้มีคนมาดูว่าทำไม cron อ่านไม่ได้
      this.logger.error(`[KycStorageAudit] ตรวจ invariant ไม่สำเร็จ: ${msg}`);
    }
  }

  /**
   * alertSuperAdmins — ส่ง notification เข้าระบบให้ super admin (role 4) ทุกคน
   *
   * ใช้ของที่มีอยู่แล้วทั้งคู่ (NotificationService + notifications table)
   * ไม่ต้องต่อ infra ใหม่ ไม่ต้องพึ่งใครเปิดอ่าน log
   *
   * ส่งไม่สำเร็จรายคน → log แล้วไปต่อ ไม่ให้คนเดียวทำให้ทั้งรอบล้ม
   */
  private async alertSuperAdmins(result: InvariantRow): Promise<void> {
    const superAdmins = await this.prisma.user.findMany({
      where: { role: ROLE_ID.SUPER_ADMIN, isActive: true, is_deleted: false },
      select: { id: true },
    });

    if (superAdmins.length === 0) {
      this.logger.error(
        '[KycStorageAudit] ไม่พบ super admin ที่ active — ไม่มีใครได้รับแจ้งเตือน',
      );
      return;
    }

    const urgent = result.cross_user > 0n;
    const title = urgent
      ? 'พบเอกสาร KYC ชี้ไปบัญชีผู้ใช้รายอื่น'
      : 'พบความผิดปกติของเส้นทางไฟล์เอกสาร KYC';
    const body = urgent
      ? `พบ ${result.cross_user} เอกสารที่ชี้ไปโฟลเดอร์ของผู้ใช้รายอื่น ` +
        'ซึ่งอาจแปลว่ามีการใช้ช่องโหว่เข้าถึงเอกสารข้ามบัญชี กรุณาตรวจสอบทันที'
      : `พบเอกสารที่เส้นทางไฟล์ผิดรูปแบบ ` +
        `(url เต็ม ${result.full_urls}, traversal ${result.traversal}, ` +
        `ขึ้นต้นด้วย / ${result.leading_slash}, ไม่มีโฟลเดอร์ ${result.no_folder})`;

    // ตัวเลขเป็น bigint — แปลงเป็น number ก่อนลง JSON ไม่งั้น serialize ไม่ได้
    const data = {
      source: 'KycStorageAuditCron',
      fullUrls: Number(result.full_urls),
      traversal: Number(result.traversal),
      leadingSlash: Number(result.leading_slash),
      noFolder: Number(result.no_folder),
      crossUser: Number(result.cross_user),
    };

    for (const admin of superAdmins) {
      try {
        await this.notifications.create(
          admin.id,
          NotificationType.security_alert,
          title,
          body,
          data,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `[KycStorageAudit] ส่งแจ้งเตือนให้ super admin ${admin.id} ไม่สำเร็จ: ${msg}`,
        );
      }
    }

    this.logger.log(
      `[KycStorageAudit] แจ้งเตือน super admin แล้ว ${superAdmins.length} คน`,
    );
  }

  /** แยกออกมาให้เทสต์ยิงตรงได้ */
  async check(): Promise<InvariantRow> {
    const rows = await this.prisma.$queryRaw<InvariantRow[]>`
      SELECT
        count(*) FILTER (WHERE d.file_url LIKE '%://%')                       AS full_urls,
        count(*) FILTER (WHERE d.file_url LIKE '%..%')                        AS traversal,
        count(*) FILTER (WHERE d.file_url LIKE '/%')                          AS leading_slash,
        count(*) FILTER (WHERE d.file_url NOT LIKE '%/%')                     AS no_folder,
        count(*) FILTER (WHERE split_part(d.file_url, '/', 1) <> u.supabase_uid) AS cross_user
      FROM kyc_documents d
      JOIN users u ON u.id = d.user_id
      WHERE d.id <> ${FIXTURE_DOCUMENT_ID}
    `;

    return (
      rows[0] ?? {
        full_urls: 0n,
        traversal: 0n,
        leading_slash: 0n,
        no_folder: 0n,
        cross_user: 0n,
      }
    );
  }
}
