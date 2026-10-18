/**
 * JobTypeRemovalNotifier — แจ้งผู้ดูแลที่ประเภทงานเดิมถูกนำออก (PYG-592 AC6 · รายชื่อจาก PYG-591)
 *
 * อ่านจากตาราง caregiver_job_types_removed_pyg559 ที่ data migration (PYG-591) สร้าง
 *   - ตารางนี้ยังไม่อยู่ใน schema.prisma → อ่านด้วย SQL ตรง · ยังไม่มีตาราง (migration ยังไม่รัน) = ข้ามเงียบ ๆ
 *
 * ตัวกันส่งซ้ำ (รันกี่ครั้งก็ได้): ไม่มีคอลัมน์ "แจ้งแล้ว" ในตารางสำเนา (และไม่แตะ DB) จึงใช้ notifications เอง
 *   แจ้งเตือนทุกฉบับเก็บ data.removedIds = id ของแถวสำเนาที่ครอบคลุม → รอบถัดไปข้ามแถวที่มี id อยู่แล้ว
 *   ส่งไม่สำเร็จ = ไม่มีฉบับในตาราง → รอบถัดไปส่งซ้ำเฉพาะรายนั้น
 * ช่องทางเดียวกับ S03: in-app notification ผ่าน NotificationService
 * รวมเป็น 1 ฉบับต่อผู้ดูแล (ครอบทุกประเภทที่ถูกนำออกและยังไม่ได้แจ้ง)
 *
 * งานนี้เป็นงานครั้งเดียวในเชิงธุรกิจ แต่รันเป็น cron เพราะ BE ขึ้นก่อน migration — พอตารางมีแถว รอบถัดไปก็แจ้งเอง
 * หลัง story ปิดและตารางถูกลบ cron นี้เป็น no-op (ลบทิ้งได้)
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../common/prisma.service';
import { NotificationService } from '../../../notification/notification.service';
import { NotificationType } from '../../../notification/entities/notification-type.enum';

export const REMOVED_TABLE = 'caregiver_job_types_removed_pyg559';

const JOB_TYPE_LABEL_TH: Record<string, string> = {
  physiotherapy: 'กายภาพบำบัด',
  medication: 'จัดยาตามแพทย์สั่ง',
  general_care: 'ดูแลทั่วไป',
  bedridden_care: 'ดูแลผู้ป่วยติดเตียง',
  companion: 'เป็นเพื่อน/พูดคุย',
};

interface RemovedRow {
  id: string;
  caregiver_id: string;
  user_id: string;
  job_type: string;
}

export interface JobTypeRemovalResult {
  /** ผู้ดูแลที่ส่งสำเร็จรอบนี้ */
  notified: number;
  /** ผู้ดูแลที่ส่งไม่สำเร็จ (จะลองใหม่รอบหน้า) */
  failed: number;
  /** แถวที่แจ้งไปแล้วก่อนหน้า (ข้าม) */
  skipped: number;
}

@Injectable()
export class JobTypeRemovalNotifier {
  private readonly logger = new Logger(JobTypeRemovalNotifier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationService: NotificationService,
  ) {}

  @Cron(process.env['CRON_JOB_TYPE_REMOVAL_NOTIFY'] ?? '10 * * * *', { timeZone: 'Asia/Bangkok' })
  async run(): Promise<JobTypeRemovalResult> {
    const result: JobTypeRemovalResult = { notified: 0, failed: 0, skipped: 0 };

    let rows: RemovedRow[];
    try {
      rows = await this.loadRemoved();
    } catch (err) {
      this.logger.error({
        event: 'job_type_removal.load_failed',
        reason: err instanceof Error ? err.message : String(err),
      });
      return result;
    }
    if (rows.length === 0) return result;

    const alreadyNotified = await this.loadNotifiedIds(rows.map((r) => r.user_id));
    const byUser = new Map<string, RemovedRow[]>();
    for (const row of rows) {
      if (alreadyNotified.has(row.id)) {
        result.skipped++;
        continue;
      }
      byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), row]);
    }

    for (const [userId, pending] of byUser) {
      const jobTypes = [...new Set(pending.map((r) => r.job_type))];
      try {
        await this.notificationService.create(
          userId,
          NotificationType.job_type_removed,
          'ประเภทงานบางรายการถูกนำออกจากโปรไฟล์ของคุณ',
          `ประเภทงาน ${jobTypes.map((t) => JOB_TYPE_LABEL_TH[t] ?? t).join(', ')} ` +
            'ถูกนำออก เนื่องจากต้องเป็นนักกายภาพบำบัดที่มีใบประกอบวิชาชีพที่ได้รับอนุมัติ ' +
            '— แจ้งวิชาชีพและแนบใบประกอบวิชาชีพ แล้วเลือกประเภทงานใหม่ได้',
          {
            removedIds: pending.map((r) => r.id),
            jobTypes,
            caregiverId: pending[0].caregiver_id,
            linkPath: '/caregiver/edit-profile',
          },
        );
        result.notified++;
      } catch (err) {
        result.failed++;
        this.logger.error({
          event: 'job_type_removal.notify_failed',
          userId,
          jobTypes,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.logger.log({ event: 'job_type_removal.done', ...result });
    return result;
  }

  /** ตารางยังไม่ถูกสร้าง → [] (ไม่ใช่ error) */
  private async loadRemoved(): Promise<RemovedRow[]> {
    const exists = await this.prisma.$queryRaw<Array<{ t: string | null }>>`
      SELECT to_regclass(${`public.${REMOVED_TABLE}`})::text AS t
    `;
    if (!exists[0]?.t) return [];

    return this.prisma.$queryRawUnsafe<RemovedRow[]>(
      `SELECT r.id::text AS id, r.caregiver_id, c.user_id, r.job_type::text AS job_type
         FROM "${REMOVED_TABLE}" r
         JOIN caregivers c ON c.id = r.caregiver_id
        ORDER BY r.caregiver_id, r.job_type`,
    );
  }

  /** id ของแถวสำเนาที่มีแจ้งเตือนฉบับสำเร็จอยู่แล้ว (อ่านจาก notifications.data.removedIds) */
  private async loadNotifiedIds(userIds: string[]): Promise<Set<string>> {
    const found = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT jsonb_array_elements_text(n.data->'removedIds') AS id
        FROM notifications n
       WHERE n.type::text = ${NotificationType.job_type_removed}
         AND n.user_id = ANY(${[...new Set(userIds)]})
         AND jsonb_typeof(n.data->'removedIds') = 'array'
    `;
    return new Set(found.map((f) => f.id));
  }
}
