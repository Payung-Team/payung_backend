/**
 * BookingNotificationListener tests (PYG-292/PYG-293)
 *
 * Focus: 1 event → 1 email per recipient (ไม่ซ้ำ ไม่ bypass) + per-event template selection
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BookingNotificationListener } from './booking-notification.listener';
import { PrismaService } from '../../common/prisma.service';
import { NotificationService } from '../notification.service';
import { EmailService } from '../../email/email.service';
import { BOOKING_EVENTS } from '../events/booking-event';

const PATIENT_ID = 'user-patient';
const CAREGIVER_USER_ID = 'user-caregiver';
const BOOKING_ID = 'booking-1';

function fakeBooking(overrides: Record<string, unknown> = {}) {
  return {
    patientId: PATIENT_ID,
    serviceType: 'general_care',
    bookingDate: new Date(Date.UTC(2026, 6, 15)),
    startTime: new Date(Date.UTC(1970, 0, 1, 9, 0, 0)),
    durationHours: { toNumber: () => 4 },
    locationAddress: '123 ถ.สุขุมวิท',
    estimatedCost: { toNumber: () => 1000 },
    platformFee: { toNumber: () => 100 },
    caregiver: {
      userId: CAREGIVER_USER_ID,
      fullName: 'สมชาย ใจเย็น',
      phone: '0812345678',
      averageRating: 4.8,
      reviewCount: 12,
    },
    patient: { displayName: 'มาลี ใจดี' },
    payment: { amount: { toNumber: () => 1100 }, omiseChargeId: 'chrg_test_123' },
    ...overrides,
  };
}

describe('BookingNotificationListener', () => {
  let listener: BookingNotificationListener;
  let prisma: { booking: { findUnique: jest.Mock }; user: { findMany: jest.Mock } };
  let notificationService: { create: jest.Mock };
  let emailService: {
    sendBookingEmail: jest.Mock;
    sendBookingNotification: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      booking: { findUnique: jest.fn() },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    };
    notificationService = { create: jest.fn().mockResolvedValue(undefined) };
    emailService = {
      sendBookingEmail: jest.fn().mockResolvedValue(undefined),
      sendBookingNotification: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingNotificationListener,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationService, useValue: notificationService },
        { provide: EmailService, useValue: emailService },
      ],
    }).compile();

    listener = module.get(BookingNotificationListener);
  });

  describe('Wave 1 — per-event template', () => {
    it('booking.accepted → patient ได้ 1 in-app + 1 email (ผ่าน sendBookingEmail)', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking());

      await listener.handleBookingEvent({
        bookingId: BOOKING_ID,
        eventType: BOOKING_EVENTS.ACCEPTED,
        patientId: PATIENT_ID,
        caregiverId: CAREGIVER_USER_ID,
      });

      expect(notificationService.create).toHaveBeenCalledTimes(1);
      expect(notificationService.create).toHaveBeenCalledWith(
        PATIENT_ID,
        expect.anything(),
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ bookingId: BOOKING_ID }),
      );
      // Wave 1 path → sendBookingEmail (ไม่ใช่ sendBookingNotification fallback)
      expect(emailService.sendBookingEmail).toHaveBeenCalledTimes(1);
      expect(emailService.sendBookingEmail).toHaveBeenCalledWith(
        PATIENT_ID,
        expect.any(Function),
      );
      expect(emailService.sendBookingNotification).not.toHaveBeenCalled();
    });

    it('booking.confirmed (recipient=both) → 2 in-app + 2 emails (1 per ผู้รับ ไม่ซ้ำ)', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking());

      await listener.handleBookingEvent({
        bookingId: BOOKING_ID,
        eventType: BOOKING_EVENTS.CONFIRMED,
        patientId: PATIENT_ID,
        caregiverId: CAREGIVER_USER_ID,
      });

      expect(notificationService.create).toHaveBeenCalledTimes(2);
      expect(emailService.sendBookingEmail).toHaveBeenCalledTimes(2);
      const recipientArgs = emailService.sendBookingEmail.mock.calls.map(
        (c) => c[0] as string,
      );
      expect(recipientArgs.sort()).toEqual([CAREGIVER_USER_ID, PATIENT_ID].sort());
    });

    it('Wave 1 template render = ดึง chargeId/rating/timeText จาก booking ที่โหลด', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking());

      await listener.handleBookingEvent({
        bookingId: BOOKING_ID,
        eventType: BOOKING_EVENTS.PAYMENT_HELD,
        patientId: PATIENT_ID,
        caregiverId: CAREGIVER_USER_ID,
      });

      // เรียก build callback เพื่อตรวจสอบ template output
      const [, builder] = emailService.sendBookingEmail.mock.calls[0];
      const tpl = builder({ recipientName: 'มาลี ใจดี', frontendUrl: 'https://payung.app' });
      expect(tpl.subject).toBe('[Payung] ชำระเงินเรียบร้อย');
      expect(tpl.html).toContain('chrg_test_123');
      expect(tpl.html).toContain('09:00 - 13:00');
      expect(tpl.html).toContain('฿1,000'); // service cost
      expect(tpl.html).toContain('฿100'); // platform fee
    });

    it('booking.created (recipient=caregiver) → caregiver ได้ email เดียว', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking());

      await listener.handleBookingEvent({
        bookingId: BOOKING_ID,
        eventType: BOOKING_EVENTS.CREATED,
        patientId: PATIENT_ID,
        caregiverId: CAREGIVER_USER_ID,
      });

      expect(emailService.sendBookingEmail).toHaveBeenCalledTimes(1);
      expect(emailService.sendBookingEmail.mock.calls[0][0]).toBe(CAREGIVER_USER_ID);
    });

    it('decline reason จาก metadata ถูก pipe ลง template', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking());

      await listener.handleBookingEvent({
        bookingId: BOOKING_ID,
        eventType: BOOKING_EVENTS.DECLINED,
        patientId: PATIENT_ID,
        caregiverId: CAREGIVER_USER_ID,
        metadata: { reason: 'ติดธุระด่วน' },
      });

      const [, builder] = emailService.sendBookingEmail.mock.calls[0];
      const tpl = builder({ recipientName: 'มาลี', frontendUrl: 'https://payung.app' });
      expect(tpl.html).toContain('ติดธุระด่วน');
    });
  });

  describe('Wave 2 fallback', () => {
    it('booking.cancelled → ใช้ sendBookingNotification (generic template)', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking());

      await listener.handleBookingEvent({
        bookingId: BOOKING_ID,
        eventType: BOOKING_EVENTS.CANCELLED,
        patientId: PATIENT_ID,
        caregiverId: CAREGIVER_USER_ID,
      });

      expect(emailService.sendBookingEmail).not.toHaveBeenCalled();
      expect(emailService.sendBookingNotification).toHaveBeenCalledTimes(1);
    });
  });

  describe('robustness', () => {
    it('booking ไม่พบ → ไม่ throw + ไม่ส่ง email/in-app', async () => {
      prisma.booking.findUnique.mockResolvedValue(null);

      await expect(
        listener.handleBookingEvent({
          bookingId: 'missing',
          eventType: BOOKING_EVENTS.ACCEPTED,
          patientId: PATIENT_ID,
          caregiverId: null,
        }),
      ).resolves.not.toThrow();
      expect(notificationService.create).not.toHaveBeenCalled();
      expect(emailService.sendBookingEmail).not.toHaveBeenCalled();
    });

    it('EmailService throw → ไม่ทำให้ flow ล่ม (try/catch)', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking());
      emailService.sendBookingEmail.mockRejectedValue(new Error('SMTP down'));

      await expect(
        listener.handleBookingEvent({
          bookingId: BOOKING_ID,
          eventType: BOOKING_EVENTS.ACCEPTED,
          patientId: PATIENT_ID,
          caregiverId: CAREGIVER_USER_ID,
        }),
      ).resolves.not.toThrow();
    });

    it('payment.voided (config.email=false) → in-app only ไม่ส่ง email', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking());

      await listener.handleBookingEvent({
        bookingId: BOOKING_ID,
        eventType: BOOKING_EVENTS.PAYMENT_VOIDED,
        patientId: PATIENT_ID,
        caregiverId: CAREGIVER_USER_ID,
      });

      // PYG-286 config.email=false → in-app เท่านั้น (patient only)
      expect(notificationService.create).toHaveBeenCalledTimes(1);
      expect(emailService.sendBookingEmail).not.toHaveBeenCalled();
      expect(emailService.sendBookingNotification).not.toHaveBeenCalled();
    });
  });
});
