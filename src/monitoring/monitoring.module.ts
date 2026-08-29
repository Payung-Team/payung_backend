import { Module } from '@nestjs/common';
import { MonitoringService } from './monitoring.service';
import { MonitoringResolver } from './monitoring.resolver';
import { NoCheckoutSweeperService } from './no-checkout-sweeper.service';
import { CommonModule } from '../common/common.module';
import { NotificationModule } from '../notification/notification.module';

/**
 * MonitoringModule — proof-of-work: เช็คอิน / เช็คเอาท์ / หลักฐานการทำงาน (PYG-352)
 *
 * ⚠ ไฟล์นี้เคยเป็นไฟล์ว่าง 0 ไบต์ และไม่เคยถูก import ที่ไหนเลย
 *   ถ้าลืมใส่ MonitoringModule ใน imports ของ app.module.ts อีกครั้ง
 *   ผลคือ mutation จะหายไปจาก schema เงียบ ๆ — ไม่มี error ให้เห็น
 *   เพราะ Nest ไม่รู้ด้วยซ้ำว่ามี module นี้อยู่ ระวังเป็นพิเศษตอน merge conflict
 *
 * exports MonitoringService เพราะ PYG-366 / PYG-367 (escrow gate + cron ปล่อยเงิน)
 * ต้องอ่านหลักฐานไปตัดสินว่าจะโอนเงินให้ผู้ดูแลหรือยัง
 */
@Module({
  imports: [CommonModule, NotificationModule],
  providers: [MonitoringResolver, MonitoringService, NoCheckoutSweeperService],
  exports: [MonitoringService],
})
export class MonitoringModule {}
