import { Module } from '@nestjs/common';
import { MonitoringService } from './monitoring.service';
import { MonitoringResolver } from './monitoring.resolver';
import { JobQrService } from './qr/job-qr.service';
import { JobQrResolver } from './qr/job-qr.resolver';
import { JobScanService } from './qr/job-scan.service';
import { JobScanResolver } from './qr/job-scan.resolver';
import { CommonModule } from '../common/common.module';

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
 *
 * PYG-434: เพิ่มระบบ QR (โฟลเดอร์ qr/) เข้ามาใน module เดียวกัน
 *   เพราะ QR คือ "ประตูหน้า" ของการเช็คอิน/เช็คเอาท์ ซึ่งเป็นเรื่องเดียวกับ proof-of-work
 *   และ PYG-435 จะให้ scanJobQr เรียก MonitoringService ต่อ — อยู่ module เดียวกันแล้วไม่ต้อง import ข้าม
 *
 *   exports JobQrService เพราะ BookingModule ต้องเรียกตอนสร้าง booking
 *   ⚠ ทิศทางเดียว: BookingModule → MonitoringModule
 *     ห้ามให้ MonitoringModule import BookingModule กลับ ไม่งั้นเกิด circular dependency
 *
 * PYG-435: เพิ่ม JobScanService/JobScanResolver (สแกน QR แล้วเริ่ม/จบงาน)
 *   JobScanService เรียก MonitoringService ต่อ — อยู่ module เดียวกันจึงไม่ต้อง import ข้าม
 *   ★ ไม่ได้ export ออกไปโดยตั้งใจ: ไม่มีโมดูลอื่นควรสแกนแทนผู้ดูแลได้
 *     (ต่างจาก JobQrService ที่ BookingModule ต้องใช้จริง ๆ ตอนสร้าง booking)
 */
@Module({
  imports: [CommonModule],
  providers: [
    MonitoringResolver,
    MonitoringService,
    // PYG-434: สร้าง/อ่านใบ QR ของงาน
    JobQrResolver,
    JobQrService,
    // PYG-435: สแกน QR → เช็คอิน/เช็คเอาท์
    JobScanResolver,
    JobScanService,
  ],
  exports: [MonitoringService, JobQrService],
})
export class MonitoringModule {}
