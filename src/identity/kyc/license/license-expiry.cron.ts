/**
 * LicenseExpiryCron — งานรายวัน: ใบประกอบฯ ที่ถึงวันหมดอายุ → review_status = 'expired' + แจ้งผู้ดูแลให้อัปโหลดใหม่
 * (PYG-587 / S03-AC7)
 *
 * ทำไมรันซ้ำ/รันช้า/เซิร์ฟเวอร์ดับข้ามวันได้ปลอดภัย (E8):
 *   - เลือกแถวด้วย expires_at <= now() (ไม่ใช่ "= วันนี้") → วันที่ข้ามไปถูกเก็บตกในรอบถัดไปเอง
 *   - เปลี่ยนสถานะด้วย updateMany ที่มีเงื่อนไขสถานะ pending/approved เดิม → รันซ้ำ/รันซ้อนกันสองตัว
 *     มีตัวเดียวที่ได้ count = 1 และเป็นตัวเดียวที่ส่งแจ้งเตือน (ตัวกันส่งซ้ำ = ตัวเปลี่ยนสถานะเอง)
 *   - แจ้งเตือนส่งหลัง commit · ส่งล้มแค่ log ไม่ย้อนสถานะ (สถานะ expired คือความจริง ห้ามถอยเพราะแจ้งเตือนล้ม)
 *
 * ขอบเขต: เฉพาะใบที่ยังใช้อยู่ (pending/approved) ของผู้ดูแลที่วิชาชีพยังบังคับใบประกอบฯ
 * ใบที่ถูกปฏิเสธไปแล้ว หรือของ general_caregiver ไม่ถูกแตะ/ไม่แจ้งเตือน
 * ไม่ปิดประเภทงานเมื่อใบหมดอายุ (นอกขอบเขต: S04 · PYG-592)
 *
 * schedule: 00:05 เวลาไทย — expires_at เก็บเป็นสิ้นวัน 23:59:59.999+07 จึงหมดอายุจริงหลังเที่ยงคืนเล็กน้อย
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../common/prisma.service';
import { ClockService } from '../../../common/clock.service';
import { NotificationService } from '../../../notification/notification.service';
import { NotificationType } from '../../../notification/entities/notification-type.enum';
import {
  LICENSE_DOC_TYPE,
  LICENSE_LIVE_STATUSES,
  LICENSE_REQUIRED_PROFESSIONS,
  LICENSE_STATUS,
} from './license.constants';

const BATCH_SIZE = 100;
/** กันลูปไม่รู้จบถ้ามีอะไรผิดปกติ — 100 รอบ x 100 แถว */
const MAX_BATCHES = 100;

export interface LicenseExpiryResult {
  /** แถวที่เปลี่ยนเป็น expired ในรอบนี้ */
  expired: number;
  /** แถวที่แจ้งเตือนไม่สำเร็จ (สถานะเปลี่ยนแล้ว) */
  notifyFailed: number;
}

@Injectable()
export class LicenseExpiryCron {
  private readonly logger = new Logger(LicenseExpiryCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
    private readonly notificationService: NotificationService,
  ) {}

  @Cron(process.env['CRON_LICENSE_EXPIRY'] ?? '5 0 * * *', { timeZone: 'Asia/Bangkok' })
  async run(): Promise<LicenseExpiryResult> {
    const result: LicenseExpiryResult = { expired: 0, notifyFailed: 0 };
    const now = this.clock.now();

    try {
      for (let batch = 0; batch < MAX_BATCHES; batch++) {
        const due = await this.prisma.kycDocument.findMany({
          where: {
            documentType: LICENSE_DOC_TYPE,
            reviewStatus: { in: [...LICENSE_LIVE_STATUSES] },
            expiresAt: { lte: now },
            caregiver: { is: { profession: { in: [...LICENSE_REQUIRED_PROFESSIONS] } } },
          },
          select: { id: true, caregiver: { select: { id: true, userId: true } } },
          orderBy: { expiresAt: 'asc' },
          take: BATCH_SIZE,
        });
        if (due.length === 0) break;

        let progressed = 0;
        for (const doc of due) {
          if (!doc.caregiver) continue;
          try {
            const claimed = await this.prisma.kycDocument.updateMany({
              where: {
                id: doc.id,
                reviewStatus: { in: [...LICENSE_LIVE_STATUSES] },
                expiresAt: { lte: now },
              },
              data: { reviewStatus: LICENSE_STATUS.EXPIRED, reviewedAt: now },
            });
            // 0 = มีรอบอื่น/แอดมินตัดสินไปก่อน → ไม่แจ้งเตือนซ้ำ
            if (claimed.count === 0) continue;
            progressed++;
            result.expired++;

            const notified = await this.notify(doc.caregiver.userId, doc.id, doc.caregiver.id);
            if (!notified) result.notifyFailed++;
          } catch (err) {
            this.logger.error({
              event: 'license_expiry.row_failed',
              documentId: doc.id,
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }
        // ทั้งชุดไม่มีแถวไหนเปลี่ยน (ล้มหมด/ถูกตัดสินไปแล้ว) → หยุด ไม่วนซ้ำแถวเดิม
        if (progressed === 0) break;
      }
    } catch (err) {
      this.logger.error({
        event: 'license_expiry.run_failed',
        reason: err instanceof Error ? err.message : String(err),
      });
    }

    this.logger.log({ event: 'license_expiry.done', ...result });
    return result;
  }

  private async notify(userId: string, documentId: string, caregiverId: string): Promise<boolean> {
    try {
      await this.notificationService.create(
        userId,
        NotificationType.license_expired,
        'ใบประกอบวิชาชีพหมดอายุแล้ว',
        'กรุณาอัปโหลดใบประกอบวิชาชีพฉบับใหม่เพื่อให้ทีมงานตรวจสอบ',
        { documentId, caregiverId, linkPath: '/kyc' },
      );
      return true;
    } catch (err) {
      this.logger.error({
        event: 'license_expiry.notify_failed',
        documentId,
        userId,
        reason: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}
