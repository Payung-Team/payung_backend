import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { BookingService } from './booking.service';
import { PrismaService } from '../common/prisma.service';
import { BookingStatusEnum } from './dto/booking-summary.types';

// ── Helpers ────────────────────────────────────────────────────────────────

const PATIENT_ID   = 'user-111';
const BOOKING_ID   = 'booking-aaa';
const CAREGIVER_ID = 'cg-222';

function fakeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id:              BOOKING_ID,
    patientId:       PATIENT_ID,
    caregiverId:     CAREGIVER_ID,
    status:          'accepted',
    serviceType:     'general_care',
    timeSlot:        'morning',
    locationAddress: '123 Main St',
    bookingDate:     new Date('2026-07-01'),
    estimatedCost:   { toNumber: () => 500 },
    confirmedAt:     null,
    createdAt:       new Date('2026-06-01T08:00:00Z'),
    caregiver: {
      id:         CAREGIVER_ID,
      fullName:   'สมชาย ใจดี',
      hourlyRate: 350,
      user:       { avatarUrl: null },
    },
    careRecipient: null,
    ...overrides,
  };
}

// ── Setup ──────────────────────────────────────────────────────────────────

describe('BookingService', () => {
  let service: BookingService;
  let prisma: {
    booking: {
      findUnique: jest.Mock;
      update:     jest.Mock;
      findMany:   jest.Mock;
      count:      jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      booking: {
        findUnique: jest.fn(),
        update:     jest.fn(),
        findMany:   jest.fn(),
        count:      jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<BookingService>(BookingService);
  });

  // ── confirmBooking ──────────────────────────────────────────────────────

  describe('confirmBooking', () => {
    it('returns BookingSummary with status=confirmed on happy path', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking());
      const confirmed = fakeBooking({ status: 'confirmed', confirmedAt: new Date() });
      prisma.booking.update.mockResolvedValue(confirmed);

      const result = await service.confirmBooking(BOOKING_ID, PATIENT_ID);

      expect(prisma.booking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: BOOKING_ID },
          data: expect.objectContaining({ status: 'confirmed' }),
        }),
      );
      expect(result.id).toBe(BOOKING_ID);
      expect(result.status).toBe('confirmed');
      expect(result.confirmedAt).toBeDefined();
    });

    it('throws NotFoundException when booking does not exist', async () => {
      prisma.booking.findUnique.mockResolvedValue(null);

      await expect(service.confirmBooking(BOOKING_ID, PATIENT_ID))
        .rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when patient does not own the booking', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking({ patientId: 'other-user' }));

      await expect(service.confirmBooking(BOOKING_ID, PATIENT_ID))
        .rejects.toThrow(ForbiddenException);
    });

    it('throws UnprocessableEntityException when status is not accepted', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking({ status: 'pending' }));

      await expect(service.confirmBooking(BOOKING_ID, PATIENT_ID))
        .rejects.toThrow(UnprocessableEntityException);
    });

    it('maps estimatedCost from Decimal to number', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking());
      prisma.booking.update.mockResolvedValue(
        fakeBooking({ status: 'confirmed', estimatedCost: { toNumber: () => 350.5 } }),
      );

      const result = await service.confirmBooking(BOOKING_ID, PATIENT_ID);

      expect(result.estimatedCost).toBe(350.5);
    });

    it('maps careRecipientName when care_recipient exists', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        fakeBooking({ careRecipient: { name: 'คุณย่า' } }),
      );
      prisma.booking.update.mockResolvedValue(
        fakeBooking({ status: 'confirmed', careRecipient: { name: 'คุณย่า' } }),
      );

      const result = await service.confirmBooking(BOOKING_ID, PATIENT_ID);

      expect(result.careRecipientName).toBe('คุณย่า');
    });
  });

  // ── myBookingHistory ────────────────────────────────────────────────────

  describe('myBookingHistory', () => {
    it('queries all statuses when no status filter set', async () => {
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.count.mockResolvedValue(0);

      await service.myBookingHistory(PATIENT_ID, {});

      const call = prisma.booking.findMany.mock.calls[0][0];
      expect(call.where).toEqual({ patientId: PATIENT_ID });
    });

    it('filters by status when status is set', async () => {
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.count.mockResolvedValue(0);

      await service.myBookingHistory(PATIENT_ID, { status: BookingStatusEnum.COMPLETED });

      const call = prisma.booking.findMany.mock.calls[0][0];
      expect(call.where).toEqual({ patientId: PATIENT_ID, status: 'completed' });
    });

    it('orders by createdAt desc', async () => {
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.count.mockResolvedValue(0);

      await service.myBookingHistory(PATIENT_ID, {});

      expect(prisma.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: 'desc' } }),
      );
    });

    it('formats bookingDate as YYYY-MM-DD string', async () => {
      prisma.booking.findMany.mockResolvedValue([fakeBooking()]);
      prisma.booking.count.mockResolvedValue(1);

      const result = await service.myBookingHistory(PATIENT_ID, {});

      expect(result.data[0].bookingDate).toBe('2026-07-01');
    });

    it('returns null confirmedAt as undefined', async () => {
      prisma.booking.findMany.mockResolvedValue([fakeBooking({ confirmedAt: null })]);
      prisma.booking.count.mockResolvedValue(1);

      const result = await service.myBookingHistory(PATIENT_ID, {});

      expect(result.data[0].confirmedAt).toBeUndefined();
    });

    it('computes correct pagination for page 2', async () => {
      const rows = Array.from({ length: 3 }, (_, i) => fakeBooking({ id: `b-${i}` }));
      prisma.booking.findMany.mockResolvedValue(rows);
      prisma.booking.count.mockResolvedValue(13);

      const result = await service.myBookingHistory(PATIENT_ID, { page: 2, limit: 3 });

      expect(result.pagination).toMatchObject({ page: 2, limit: 3, total: 13, totalPages: 5 });
      expect(prisma.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 3, take: 3 }),
      );
    });
  });
});
