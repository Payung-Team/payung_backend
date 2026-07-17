/**
 * PayoutCreationListener — PYG-330 (ก้อน B)
 *
 * ฟัง booking.completed → เรียก PayoutService.createFromCompletedBooking()
 *
 * ทำไมต้องแยกเป็น listener class?
 * - เหมือน pattern ของ BookingNotificationListener (PYG-292) — ที่เดียวที่ผูก
 *   event bus กับ business logic
 * - ทำให้ PayoutService test ง่าย (mock ไม่ต้อง mock @nestjs/event-emitter)
 *
 * ทำไม try/catch ไม่ throw กลับ?
 * - หลาย listener ฟัง event เดียวกัน (BookingNotificationListener ก็ฟัง COMPLETED)
 *   ถ้าเราขว้าง error กลับ event bus จะทำ listener อื่นล่มตาม
 * - PayoutService.createFromCompletedBooking() ก็ swallow เอง ชั้นนี้ป้องกันซ้ำ
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  BOOKING_EVENTS,
  type BookingEvent,
} from '../../notification/events/booking-event';
import { PayoutService } from '../payout.service';

@Injectable()
export class PayoutCreationListener {
  private readonly logger = new Logger(PayoutCreationListener.name);

  constructor(private readonly payoutService: PayoutService) {}

  @OnEvent(BOOKING_EVENTS.COMPLETED)
  async handleBookingCompleted(event: BookingEvent): Promise<void> {
    try {
      await this.payoutService.createFromCompletedBooking(event.bookingId);
    } catch (err) {
      // ห้าม throw กลับ event bus — listener อื่นจะพังตาม (BookingNotificationListener)
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[PayoutCreationListener] uncaught error for booking=${event.bookingId}: ${msg}`,
      );
    }
  }
}
