/**
 * NotificationModule — Module สำหรับ in-app notifications (PYG-95)
 *
 * ทำไมต้อง export NotificationService?
 * - service อื่น (เช่น KycService) ต้องเรียก notificationService.create() ได้
 *   เพื่อแจ้งเตือน user ตอน KYC verified/rejected
 * - การ export ทำให้ module อื่นที่ import NotificationModule → inject NotificationService ได้
 *
 * ยังไม่มี NotificationResolver ในสเต็ปนี้
 * - task PYG-95 บอกแค่ schema + service (ไม่รวม GraphQL endpoints)
 * - resolver จะเพิ่มในงานต่อไป (task อื่น)
 */
import { Module } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { NotificationResolver } from './notification.resolver';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { EmailModule } from '../email/email.module';
import { BookingNotificationListener } from './listeners/booking-notification.listener';

@Module({
  // EmailModule → ให้ listener inject EmailService ได้ (ส่งอีเมล booking)
  imports: [EmailModule],
  providers: [
    NotificationService,
    NotificationResolver,         // PYG-97: GraphQL endpoints
    SupabaseAuthGuard,            // ใช้ใน @UseGuards บน NotificationResolver
    BookingNotificationListener,  // PYG-292: ฟัง booking/payment/dispute events
  ],
  exports: [NotificationService],  // ให้ module อื่น inject ได้
})
export class NotificationModule {}
