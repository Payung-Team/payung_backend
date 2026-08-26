import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { FamilyGroupService } from './family-group.service';
import { FamilyGroupResolver } from './family-group.resolver';
import { FamilyGroupGuard } from './guards/family-group.guard';

/**
 * FamilyGroupModule (PYG-412) — Epic PYG-381 "กลุ่มครอบครัว & จองแทน"
 *
 * ⚠ ต้องเพิ่มใน imports ของ app.module.ts ด้วย ไม่งั้น mutation/query
 *   จะหายไปจาก schema แบบเงียบ ๆ ไม่มี error ให้เห็น (เคยเกิดกับ MonitoringModule มาแล้ว)
 *
 * ★ FamilyGroupGuard ต้องอยู่ใน providers ตรงนี้ ถึงจะ inject PrismaService/Reflector ได้
 *   (ตาม convention ทีม เหมือน FieldLockGuard ของ PYG-146)
 *   PrismaService มาจาก CommonModule ที่เป็น @Global() — import ไว้ให้ชัดเจน
 *
 * exports ทั้งสองตัว เพราะการ์ดถัด ๆ ไปต้องใช้ต่อ:
 *   PYG-416/417 (เชิญ/รับคำเชิญ) และ PYG-424 (จองแทน) ใช้ guard ตัวเดียวกันนี้
 *   คุมสิทธิ์ในกลุ่ม และเรียก service เพื่ออ่านสมาชิกภาพ
 */
@Module({
  imports: [CommonModule],
  providers: [FamilyGroupResolver, FamilyGroupService, FamilyGroupGuard],
  exports: [FamilyGroupService, FamilyGroupGuard],
})
export class FamilyGroupModule {}
