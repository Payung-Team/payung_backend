import { Module } from '@nestjs/common';
import { BookingService } from './booking.service';
import { BookingResolver } from './booking.resolver';
import { BookingController, BookingTaskSuggestionsController } from './booking.controller';
import { CaregiverBookingService } from './caregiver-booking.service';
import { CaregiverBookingResolver } from './caregiver-booking.resolver';
import { CommonModule } from '../common/common.module';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [CommonModule, NotificationModule],
  // PYG-202: REST controllers (create/cancel booking + task suggestions)
  controllers: [BookingController, BookingTaskSuggestionsController],
  providers: [
    // ฝั่ง patient (PYG-210): ยืนยัน booking + ดูประวัติ
    BookingService,
    BookingResolver,
    // ฝั่ง caregiver (PYG-206): รับ/ปฏิเสธ + รายการงาน + ลูกค้าประจำ
    CaregiverBookingService,
    CaregiverBookingResolver,
  ],
})
export class BookingModule {}
