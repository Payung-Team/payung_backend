/**
 * CareActivityModule — กิจกรรมการดูแลกลาง (PYG-634 · S15)
 *
 * CareActivityService = แอดมินจัดการ + รายการหน้าจอง + ตรวจ/บันทึกกิจกรรมตอนสร้าง booking (BookingModule ใช้)
 */
import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CareActivityService } from './care-activity.service';
import {
  AdminCareActivityResolver,
  CareActivityResolver,
} from './care-activity.resolver';

@Module({
  imports: [CommonModule],
  providers: [
    CareActivityService,
    CareActivityResolver,
    AdminCareActivityResolver,
    SupabaseAuthGuard,
    RolesGuard,
  ],
  exports: [CareActivityService],
})
export class CareActivityModule {}
