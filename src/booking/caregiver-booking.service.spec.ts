import { Test, TestingModule } from '@nestjs/testing';
import {
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CaregiverBookingService } from './caregiver-booking.service';
import { PrismaService } from '../common/prisma.service';
import { BookingStatusEnum } from './dto/booking-summary.types';

// ── Constants ───────────────────────────────────────────────────────────────

const USER_ID = 'cg-user-1'; // user.id ของ caregiver (จาก JWT)
const CAREGIVER_ID = 'cg-1'; // caregiver.id ที่ผูกกับ user คนนั้น
const BOOKING_ID = 'booking-aaa';
const PATIENT_ID = 'patient-1';

// ── Helpers ───────────────────────────────────────────────────────────────

/** booking 1 row (รูปทรงพร้อม relation patient + careRecipient) สำหรับ mock */
function fakeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    status: 'pending',
    serviceType: 'general_care',
    serviceLocations: ['home'],
    timeSlot: 'morning',
    bookingDate: new Date('2026-07-01'),
    startTime: new Date('1970-01-01T09:00:00.000Z'),
    durationHours: { toNumber: () => 3 },
    locationAddress: '123 Main St',
    estimatedCost: { toNumber: () => 1140 },
    acceptedAt: null,
    confirmedAt: null,
    rejectionReason: null,
    createdAt: new Date('2026-06-01T08:00:00Z'),
    patient: { id: PATIENT_ID, displayName: 'สมศรี วงค์ดี', avatarUrl: null },
    careRecipient: null,
    ...overrides,
  };
}

/** guard row ที่ loadOwnedBooking ดึงมา (findUnique + select) */
function guardRow(overrides: Record<string, unknown> = {}) {
  return { id: BOOKING_ID, caregiverId: CAREGIVER_ID, status: 'pending', ...overrides };
}

// ── Setup ───────────────────────────────────────────────────────────────────

describe('CaregiverBookingService', () => {
  let service: CaregiverBookingService;
  let prisma: {
    caregiver: { findUnique: jest.Mock };
    booking: {
      findUnique: jest.Mock;
      update: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      groupBy: jest.Mock;
    };
    user: { findMany: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      caregiver: { findUnique: jest.fn() },
      booking: {
        findUnique: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        groupBy: jest.fn(),
      },
      user: { findMany: jest.fn() },
    };

    // โดย default: หา caregiver เจอเสมอ (เทสต์ที่อยากให้ไม่เจอจะ override เอง)
    prisma.caregiver.findUnique.mockResolvedValue({ id: CAREGIVER_ID });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CaregiverBookingService,
        { provide: PrismaService, useValue: prisma },
        // PYG-292: service ยิง booking event — mock EventEmitter2
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service = module.get<CaregiverBookingService>(CaregiverBookingService);
  });

  // ── resolveCaregiverId (ผ่าน public method) ─────────────────────────────

  it('throws ForbiddenException when the user has no caregiver profile', async () => {
    prisma.caregiver.findUnique.mockResolvedValue(null);

    await expect(
      service.caregiverBookings(USER_ID, { status: BookingStatusEnum.PENDING }),
    ).rejects.toThrow(ForbiddenException);
  });

  // ── acceptBooking (#3) ──────────────────────────────────────────────────

  describe('acceptBooking', () => {
    it('moves pending → accepted and stamps acceptedAt', async () => {
      // First findUnique: loadOwnedBooking guard check
      prisma.booking.findUnique.mockResolvedValueOnce(guardRow({ status: 'pending' }));
      // Second findUnique: time-conflict detail check
      prisma.booking.findUnique.mockResolvedValueOnce({
        bookingDate: new Date('2026-07-01'),
        startTime: new Date('1970-01-01T09:00:00.000Z'),
        durationHours: { toNumber: () => 3 },
      });
      // findMany for conflict check: no conflicts
      prisma.booking.findMany.mockResolvedValueOnce([]);
      prisma.booking.update.mockResolvedValue(
        fakeBooking({ status: 'accepted', acceptedAt: new Date() }),
      );

      const result = await service.acceptBooking(USER_ID, BOOKING_ID);

      expect(prisma.booking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: BOOKING_ID },
          data: expect.objectContaining({ status: 'accepted' }),
        }),
      );
      // ตรวจว่ามีการ set acceptedAt เป็น Date
      expect(prisma.booking.update.mock.calls[0][0].data.acceptedAt).toBeInstanceOf(Date);
      expect(result.status).toBe('accepted'); // mock returns fakeBooking with status='accepted'
      expect(result.acceptedAt).toBeDefined();
    });

    it('throws NotFoundException when booking does not exist', async () => {
      prisma.booking.findUnique.mockResolvedValue(null);

      await expect(service.acceptBooking(USER_ID, BOOKING_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ForbiddenException when booking belongs to another caregiver', async () => {
      prisma.booking.findUnique.mockResolvedValue(guardRow({ caregiverId: 'other-cg' }));

      await expect(service.acceptBooking(USER_ID, BOOKING_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws UnprocessableEntityException when status is not pending', async () => {
      prisma.booking.findUnique.mockResolvedValue(guardRow({ status: 'accepted' }));

      await expect(service.acceptBooking(USER_ID, BOOKING_ID)).rejects.toThrow(
        UnprocessableEntityException,
      );
    });
  });

  // ── declineBooking (#4) ─────────────────────────────────────────────────

  describe('declineBooking', () => {
    it('moves pending → rejected and stores trimmed reason', async () => {
      prisma.booking.findUnique.mockResolvedValue(guardRow({ status: 'pending' }));
      prisma.booking.update.mockResolvedValue(
        fakeBooking({ status: 'rejected', rejectionReason: 'busy that day' }),
      );

      const result = await service.declineBooking(USER_ID, {
        bookingId: BOOKING_ID,
        reason: '  busy that day  ',
      });

      expect(prisma.booking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'rejected',
            rejectionReason: 'busy that day', // ถูก trim แล้ว
          }),
        }),
      );
      expect(result.status).toBe('rejected');
      expect(result.rejectionReason).toBe('busy that day');
    });

    it('throws UnprocessableEntityException when status is not pending', async () => {
      prisma.booking.findUnique.mockResolvedValue(guardRow({ status: 'confirmed' }));

      await expect(
        service.declineBooking(USER_ID, { bookingId: BOOKING_ID, reason: 'x' }),
      ).rejects.toThrow(UnprocessableEntityException);
    });
  });

  // ── cancelAcceptance (undoc #10) ────────────────────────────────────────

  describe('cancelAcceptance', () => {
    it('moves accepted → rejected with reason', async () => {
      prisma.booking.findUnique.mockResolvedValue(guardRow({ status: 'accepted' }));
      prisma.booking.update.mockResolvedValue(
        fakeBooking({ status: 'rejected', rejectionReason: 'emergency' }),
      );

      const result = await service.cancelAcceptance(USER_ID, {
        bookingId: BOOKING_ID,
        reason: 'emergency',
      });

      expect(prisma.booking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'rejected', rejectionReason: 'emergency' }),
        }),
      );
      expect(result.status).toBe('rejected');
    });

    it('throws UnprocessableEntityException when status is not accepted', async () => {
      prisma.booking.findUnique.mockResolvedValue(guardRow({ status: 'pending' }));

      await expect(
        service.cancelAcceptance(USER_ID, { bookingId: BOOKING_ID, reason: 'x' }),
      ).rejects.toThrow(UnprocessableEntityException);
    });
  });

  // ── caregiverBookings (#1, #2, #5) ──────────────────────────────────────

  describe('caregiverBookings', () => {
    it('filters by caregiverId + status and orders new requests newest first', async () => {
      prisma.booking.findMany.mockResolvedValue([fakeBooking()]);
      prisma.booking.count.mockResolvedValue(1);

      const result = await service.caregiverBookings(USER_ID, {
        status: BookingStatusEnum.PENDING,
      });

      const call = prisma.booking.findMany.mock.calls[0][0];
      expect(call.where).toEqual({ caregiverId: CAREGIVER_ID, status: 'pending' });
      expect(call.orderBy).toEqual({ createdAt: 'desc' });
      expect(result.data).toHaveLength(1);
      expect(result.pagination).toMatchObject({ page: 1, limit: 10, total: 1, totalPages: 1 });
    });

    it('adds an upcoming date filter and orders active jobs by booking date asc', async () => {
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.count.mockResolvedValue(0);

      await service.caregiverBookings(USER_ID, {
        status: BookingStatusEnum.CONFIRMED,
        upcoming: true,
      });

      const call = prisma.booking.findMany.mock.calls[0][0];
      expect(call.where.bookingDate).toHaveProperty('gte');
      expect(call.where.bookingDate.gte).toBeInstanceOf(Date);
      expect(call.orderBy).toEqual({ bookingDate: 'asc' });
    });

    it('orders accepted (awaiting patient) by booking date asc', async () => {
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.count.mockResolvedValue(0);

      await service.caregiverBookings(USER_ID, { status: BookingStatusEnum.ACCEPTED });

      expect(prisma.booking.findMany.mock.calls[0][0].orderBy).toEqual({
        bookingDate: 'asc',
      });
    });

    it('clamps limit to a maximum of 50', async () => {
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.count.mockResolvedValue(0);

      await service.caregiverBookings(USER_ID, {
        status: BookingStatusEnum.PENDING,
        limit: 999,
      });

      expect(prisma.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 50 }),
      );
    });

    it('exposes locationAddress for all statuses', async () => {
      prisma.booking.findMany.mockResolvedValue([fakeBooking({ status: 'pending' })]);
      prisma.booking.count.mockResolvedValue(1);

      const pending = await service.caregiverBookings(USER_ID, {
        status: BookingStatusEnum.PENDING,
      });
      expect(pending.data[0].locationAddress).toBe('123 Main St');

      prisma.booking.findMany.mockResolvedValue([fakeBooking({ status: 'confirmed' })]);
      const confirmed = await service.caregiverBookings(USER_ID, {
        status: BookingStatusEnum.CONFIRMED,
      });
      expect(confirmed.data[0].locationAddress).toBe('123 Main St');
    });

    it('maps patient brief, Decimal cost, and self care-recipient', async () => {
      prisma.booking.findMany.mockResolvedValue([fakeBooking()]);
      prisma.booking.count.mockResolvedValue(1);

      const result = await service.caregiverBookings(USER_ID, {
        status: BookingStatusEnum.PENDING,
      });
      const row = result.data[0];

      expect(row.patient).toEqual({
        id: PATIENT_ID,
        displayName: 'สมศรี วงค์ดี',
        avatarUrl: undefined,
      });
      expect(row.estimatedCost).toBe(1140); // Decimal → number
      expect(row.durationHours).toBe(3);
      expect(row.startTime).toBe('09:00');
      expect(row.bookingDate).toBe('2026-07-01');
      expect(row.careRecipientName).toBeUndefined(); // careRecipient=null → "สำหรับตัวเอง"
    });
  });

  // ── caregiverBookingHistory (#7) ────────────────────────────────────────

  describe('caregiverBookingHistory', () => {
    it('defaults to terminal statuses when no filter is set', async () => {
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.count.mockResolvedValue(0);

      await service.caregiverBookingHistory(USER_ID, {});

      const call = prisma.booking.findMany.mock.calls[0][0];
      expect(call.where).toEqual({
        caregiverId: CAREGIVER_ID,
        status: { in: ['completed', 'cancelled', 'rejected'] },
      });
      expect(call.orderBy).toEqual({ createdAt: 'desc' });
    });

    it('filters by status when provided', async () => {
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.count.mockResolvedValue(0);

      await service.caregiverBookingHistory(USER_ID, {
        status: BookingStatusEnum.COMPLETED,
      });

      expect(prisma.booking.findMany.mock.calls[0][0].where).toEqual({
        caregiverId: CAREGIVER_ID,
        status: 'completed',
      });
    });

    it('builds a bookingDate range from dateFrom/dateTo', async () => {
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.count.mockResolvedValue(0);

      await service.caregiverBookingHistory(USER_ID, {
        dateFrom: '2026-06-01',
        dateTo: '2026-06-30',
      });

      const where = prisma.booking.findMany.mock.calls[0][0].where;
      expect(where.bookingDate.gte).toBeInstanceOf(Date);
      expect(where.bookingDate.lte).toBeInstanceOf(Date);
    });
  });

});
