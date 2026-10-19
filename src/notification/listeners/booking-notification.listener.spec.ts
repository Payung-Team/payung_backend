/**
 * BookingNotificationListener — PYG-526
 *
 * เน้นเฉพาะ "เวลาใบจอง" ในแจ้งเตือนในแอปและอีเมล:
 *   ผู้ใช้ไม่ได้เลือก slot เองแล้ว (PYG-523) → ต้องเห็น "เริ่ม – สิ้นสุด (N ชม.)" ไม่ใช่ "ช่วงเช้า"
 * ไม่ต่อดีบีจริง — mock Prisma / NotificationService / EmailService ทั้งหมด
 */
import { Prisma } from '@prisma/client';
import { BookingNotificationListener } from './booking-notification.listener';
import { BOOKING_EVENTS, type BookingEvent } from '../events/booking-event';
import type { EmailTemplate } from '../../email/templates/kyc.templates';

const BOOKING_ID = 'b1111111-1111-4111-8111-111111111111';
const PATIENT_ID = 'p2222222-2222-4222-8222-222222222222';
const CAREGIVER_USER_ID = 'u3333333-3333-4333-8333-333333333333';

/** แถว booking ที่ listener select มา — จอง 11:00 ยาว 4 ชม. (slot ที่อนุมานได้คือ morning) */
function bookingRow(overrides: Record<string, unknown> = {}) {
  return {
    patientId: PATIENT_ID,
    serviceType: 'general_care',
    bookingDate: new Date('2026-07-15'),
    startTime: new Date('1970-01-01T11:00:00Z'),
    durationHours: new Prisma.Decimal('4'),
    locationAddress: '123 ถ.สุขุมวิท',
    estimatedCost: new Prisma.Decimal('1200'),
    platformFee: null,
    caregiver: {
      userId: CAREGIVER_USER_ID,
      fullName: 'สมชาย ใจเย็น',
      phone: null,
      averageRating: null,
      reviewCount: 0,
    },
    patient: { displayName: 'มาลี' },
    payment: null,
    ...overrides,
  };
}

function event(eventType: BookingEvent['eventType']): BookingEvent {
  return { bookingId: BOOKING_ID, eventType, patientId: PATIENT_ID, caregiverId: 'cg-1' };
}

describe('BookingNotificationListener — เวลาใบจอง (PYG-526)', () => {
  let prisma: { booking: { findUnique: jest.Mock }; user: { findMany: jest.Mock } };
  let notificationService: { create: jest.Mock };
  let emailService: { sendBookingEmail: jest.Mock; sendBookingNotification: jest.Mock };
  let listener: BookingNotificationListener;

  beforeEach(() => {
    prisma = {
      booking: { findUnique: jest.fn().mockResolvedValue(bookingRow()) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    };
    notificationService = { create: jest.fn().mockResolvedValue(undefined) };
    emailService = {
      sendBookingEmail: jest.fn().mockResolvedValue(undefined),
      sendBookingNotification: jest.fn().mockResolvedValue(undefined),
    };
    listener = new BookingNotificationListener(
      prisma as never,
      notificationService as never,
      emailService as never,
    );
  });

  /** body ของแจ้งเตือนในแอปที่ส่งให้ผู้รับคนแรก */
  function firstBody(): string {
    return notificationService.create.mock.calls[0][3] as string;
  }

  /** เรียก closure ที่ listener ส่งให้ EmailService เพื่อได้อีเมลที่ render แล้ว */
  function renderedEmail(): EmailTemplate {
    const build = emailService.sendBookingEmail.mock.calls[0][1] as (p: {
      recipientName: string | null;
      frontendUrl: string;
    }) => EmailTemplate;
    return build({ recipientName: 'สมชาย', frontendUrl: 'http://fe.test' });
  }

  it('แจ้งเตือนในแอป: ต่อเวลาจริงท้ายวันที่ ไม่ใช่ชื่อ slot', async () => {
    await listener.handleBookingEvent(event(BOOKING_EVENTS.CREATED));

    expect(firstBody()).toContain('วันที่ 15 ก.ค. 2569 เวลา 11:00 – 15:00 (4 ชม.)');
    expect(firstBody()).not.toMatch(/ช่วงเช้า|morning/);
  });

  it('อีเมล: แถว "เวลา" ใช้รูปแบบเดียวกับหน้าเว็บ', async () => {
    await listener.handleBookingEvent(event(BOOKING_EVENTS.CREATED));

    const email = renderedEmail();
    expect(email.text).toContain('เวลา: 11:00 – 15:00 (4 ชม.)');
    expect(email.html).toContain('11:00 – 15:00 (4 ชม.)');
  });

  it('อีเมลแบบ generic (event ที่ไม่มี template ของตัวเอง) มีแถวเวลาด้วย', async () => {
    // job.checked_out ส่งอีเมลแต่ไม่มี per-event template → ใช้ sendBookingNotification
    await listener.handleBookingEvent(event(BOOKING_EVENTS.JOB_CHECKED_OUT));

    expect(emailService.sendBookingNotification).toHaveBeenCalledWith(
      PATIENT_ID,
      expect.objectContaining({ timeText: '11:00 – 15:00 (4 ชม.)' }),
    );
  });

  it('ใบจองไม่มีเวลาเริ่ม → แสดงแค่วันที่ ไม่มี "เวลา -"', async () => {
    prisma.booking.findUnique.mockResolvedValue(bookingRow({ startTime: null }));

    await listener.handleBookingEvent(event(BOOKING_EVENTS.CREATED));

    expect(firstBody()).toContain('วันที่ 15 ก.ค. 2569 —');
    expect(firstBody()).not.toContain('เวลา');
  });
});
