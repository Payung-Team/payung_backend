import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BookingService } from './booking.service';
import { PrismaService } from '../common/prisma.service';
import { CreateBookingDto } from './dto/create-booking.dto';
import { SearchMatchesDto } from './dto/search-matches.dto';

// ── Helpers ─────────────────────────────────────────────────────────────────

const PATIENT_ID   = 'patient-111';
const BOOKING_ID   = 'b1111111-1111-1111-1111-111111111111';
const CAREGIVER_ID = 'cg-222';

function fakeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id:               BOOKING_ID,
    patientId:        PATIENT_ID,
    caregiverId:      null,
    status:           'unmatched',
    serviceType:      'elderly_care',
    timeSlot:         'morning',
    tasks:            ['อาบน้ำ', 'ป้อนอาหาร'],
    serviceLocations: ['บ้าน'],
    locationAddress:  '123 Main St',
    bookingDate:      new Date('2026-07-01'),
    estimatedCost:    null,
    confirmedAt:      null,
    createdAt:        new Date('2026-06-01T08:00:00Z'),
    caregiver:        null, // unmatched has no caregiver
    careRecipient:    null,
    ...overrides,
  };
}

function fakeCaregiver(overrides: Record<string, unknown> = {}) {
  return {
    id:                  CAREGIVER_ID,
    fullName:            'สมชาย ใจดี',
    hourlyRate:          350,
    experienceYears:     5,
    skills:              ['elderly_care'],
    serviceAreaProvince: 'เชียงใหม่',
    serviceAreaDistrict: 'เมือง',
    patientReviews:      [{ rating: 5 }, { rating: 4 }],
    user:                { avatarUrl: null },
    ...overrides,
  };
}

// ── Setup ────────────────────────────────────────────────────────────────────

describe('BookingService — new REST methods', () => {
  let service: BookingService;
  let prisma: {
    booking: {
      findUnique: jest.Mock;
      create:     jest.Mock;
      update:     jest.Mock;
      findMany:   jest.Mock;
      count:      jest.Mock;
    };
    careRecipient: { findUnique: jest.Mock };
    caregiver:     { findMany:   jest.Mock; findUnique: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      booking: {
        findUnique: jest.fn(),
        create:     jest.fn(),
        update:     jest.fn(),
        findMany:   jest.fn(),
        count:      jest.fn(),
      },
      careRecipient: { findUnique: jest.fn() },
      caregiver:     { findMany: jest.fn(), findUnique: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingService,
        { provide: PrismaService, useValue: prisma },
        // PYG-292: BookingService ยิง booking event — mock EventEmitter2
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service = module.get<BookingService>(BookingService);
  });

  // ── createBooking ──────────────────────────────────────────────────────────

  describe('createBooking', () => {
    const dto: CreateBookingDto = {
      tasks:            ['อาบน้ำ'],
      serviceLocations: ['บ้าน'],
      serviceType:      'elderly_care',
      timeSlot:         'morning',
      startTime:        '09:00:00',
      durationHours:    4,
      locationAddress:  '123 Main St',
      bookingDate:      '2026-07-01',
    };

    it('creates a booking with status=unmatched and no caregiver', async () => {
      prisma.booking.findMany.mockResolvedValue([]); // no time conflicts
      prisma.booking.create.mockResolvedValue(fakeBooking());

      const result = await service.createBooking(PATIENT_ID, dto);

      expect(prisma.booking.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            patientId:   PATIENT_ID,
            caregiverId: null,
            status:      'unmatched',
            tasks:       ['อาบน้ำ'],
          }),
        }),
      );
      expect(result.status).toBe('unmatched');
      expect(result.caregiver).toBeUndefined();
    });

    it('validates careRecipientId ownership', async () => {
      prisma.careRecipient.findUnique.mockResolvedValue({ patientId: 'other-patient' });

      const dtoWithRecipient = { ...dto, careRecipientId: 'r-uuid' };
      await expect(service.createBooking(PATIENT_ID, dtoWithRecipient))
        .rejects.toThrow(ForbiddenException);
    });

    it('throws NotFoundException when careRecipientId does not exist', async () => {
      prisma.careRecipient.findUnique.mockResolvedValue(null);

      const dtoWithRecipient = { ...dto, careRecipientId: 'r-uuid' };
      await expect(service.createBooking(PATIENT_ID, dtoWithRecipient))
        .rejects.toThrow(NotFoundException);
    });

    it('maps careRecipientName when careRecipient is present', async () => {
      prisma.booking.findMany.mockResolvedValue([]); // no time conflicts
      prisma.booking.create.mockResolvedValue(
        fakeBooking({ careRecipient: { name: 'คุณย่า' } }),
      );

      const result = await service.createBooking(PATIENT_ID, dto);
      expect(result.careRecipientName).toBe('คุณย่า');
    });
  });

  // ── cancelBooking ──────────────────────────────────────────────────────────

  describe('cancelBooking', () => {
    it('cancels an unmatched booking', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking({ status: 'unmatched' }));
      prisma.booking.update.mockResolvedValue(fakeBooking({ status: 'cancelled' }));

      const result = await service.cancelBooking(BOOKING_ID, PATIENT_ID);
      expect(result.status).toBe('cancelled');
      expect(prisma.booking.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'cancelled' } }),
      );
    });

    it('cancels a pending booking', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking({ status: 'pending' }));
      prisma.booking.update.mockResolvedValue(fakeBooking({ status: 'cancelled' }));

      const result = await service.cancelBooking(BOOKING_ID, PATIENT_ID);
      expect(result.status).toBe('cancelled');
    });

    it('cancels an accepted booking', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking({ status: 'accepted' }));
      prisma.booking.update.mockResolvedValue(fakeBooking({ status: 'cancelled' }));

      const result = await service.cancelBooking(BOOKING_ID, PATIENT_ID);
      expect(result.status).toBe('cancelled');
    });

    it('throws NotFoundException when booking not found', async () => {
      prisma.booking.findUnique.mockResolvedValue(null);
      await expect(service.cancelBooking(BOOKING_ID, PATIENT_ID))
        .rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when patient does not own the booking', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        fakeBooking({ patientId: 'other-patient' }),
      );
      await expect(service.cancelBooking(BOOKING_ID, PATIENT_ID))
        .rejects.toThrow(ForbiddenException);
    });

    it('throws UnprocessableEntityException for completed bookings', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking({ status: 'completed' }));
      await expect(service.cancelBooking(BOOKING_ID, PATIENT_ID))
        .rejects.toThrow(UnprocessableEntityException);
    });

    it('throws UnprocessableEntityException for already cancelled bookings', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking({ status: 'cancelled' }));
      await expect(service.cancelBooking(BOOKING_ID, PATIENT_ID))
        .rejects.toThrow(UnprocessableEntityException);
    });

    it('throws UnprocessableEntityException for rejected bookings', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking({ status: 'rejected' }));
      await expect(service.cancelBooking(BOOKING_ID, PATIENT_ID))
        .rejects.toThrow(UnprocessableEntityException);
    });
  });

  // ── searchMatchesBasic ─────────────────────────────────────────────────────

  describe('searchMatchesBasic', () => {
    it('returns matched caregivers with avgRating computed', async () => {
      prisma.caregiver.findMany.mockResolvedValue([fakeCaregiver()]);

      const dto: SearchMatchesDto = { serviceType: 'elderly_care', province: 'เชียงใหม่' };
      const result = await service.searchMatchesBasic(dto);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(CAREGIVER_ID);
      expect(result[0].avgRating).toBe(4.5);
      expect(result[0].reviewCount).toBe(2);
    });

    it('filters by province when provided', async () => {
      prisma.caregiver.findMany.mockResolvedValue([]);

      await service.searchMatchesBasic({ serviceType: 'elderly_care', province: 'กรุงเทพ' });

      expect(prisma.caregiver.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ serviceAreaProvince: 'กรุงเทพ' }),
        }),
      );
    });

    it('omits province filter when not provided', async () => {
      prisma.caregiver.findMany.mockResolvedValue([]);

      await service.searchMatchesBasic({ serviceType: 'elderly_care' });

      const call = prisma.caregiver.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(call.where).not.toHaveProperty('serviceAreaProvince');
    });

    it('returns avgRating=undefined when no reviews', async () => {
      prisma.caregiver.findMany.mockResolvedValue([fakeCaregiver({ patientReviews: [] })]);

      const result = await service.searchMatchesBasic({ serviceType: 'elderly_care' });
      expect(result[0].avgRating).toBeUndefined();
      expect(result[0].reviewCount).toBe(0);
    });

    it('caps results at 20', async () => {
      prisma.caregiver.findMany.mockResolvedValue([]);
      await service.searchMatchesBasic({ serviceType: 'elderly_care' });

      expect(prisma.caregiver.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 20 }),
      );
    });
  });

  // ── recoverBooking ─────────────────────────────────────────────────────────

  describe('recoverBooking', () => {
    it('resets a rejected booking to unmatched and returns matches', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        fakeBooking({ status: 'rejected', caregiverId: CAREGIVER_ID }),
      );
      prisma.booking.update.mockResolvedValue(
        fakeBooking({ status: 'unmatched', caregiverId: null }),
      );
      prisma.caregiver.findMany.mockResolvedValue([fakeCaregiver()]);

      const result = await service.recoverBooking(BOOKING_ID, PATIENT_ID);

      expect(prisma.booking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: 'unmatched', caregiverId: null },
        }),
      );
      expect(result.booking.status).toBe('unmatched');
      expect(result.booking.caregiver).toBeUndefined();
      expect(result.matches).toHaveLength(1);
    });

    it('throws NotFoundException when booking not found', async () => {
      prisma.booking.findUnique.mockResolvedValue(null);
      await expect(service.recoverBooking(BOOKING_ID, PATIENT_ID))
        .rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when patient does not own the booking', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        fakeBooking({ status: 'rejected', patientId: 'other-patient' }),
      );
      await expect(service.recoverBooking(BOOKING_ID, PATIENT_ID))
        .rejects.toThrow(ForbiddenException);
    });

    it('throws UnprocessableEntityException when booking is not rejected', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking({ status: 'pending' }));
      await expect(service.recoverBooking(BOOKING_ID, PATIENT_ID))
        .rejects.toThrow(UnprocessableEntityException);
    });
  });

  // ── getTaskSuggestions ─────────────────────────────────────────────────────

  describe('getTaskSuggestions', () => {
    it('returns task suggestions for elderly_care', () => {
      const result = service.getTaskSuggestions('elderly_care');
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toHaveProperty('label');
      expect(typeof result[0].label).toBe('string');
    });

    it('returns task suggestions for child_care', () => {
      const result = service.getTaskSuggestions('child_care');
      expect(result.length).toBeGreaterThan(0);
    });

    it('returns empty array for unknown service type', () => {
      const result = service.getTaskSuggestions('unknown_type');
      expect(result).toEqual([]);
    });

    it('returns empty array for empty string', () => {
      const result = service.getTaskSuggestions('');
      expect(result).toEqual([]);
    });
  });
});
