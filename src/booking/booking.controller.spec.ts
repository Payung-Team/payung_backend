import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BookingService } from './booking.service';
import { PrismaService } from '../common/prisma.service';
import { BookingSettlementService } from '../payment/settlement/booking-settlement.service';
import {
  SettlementBlockedError,
  SettlementReason,
} from '../payment/settlement/booking-settlement.types';
import { JobQrService } from '../monitoring/qr/job-qr.service';
import { ConsentService } from '../consent/consent.service';
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
      findUnique:        jest.Mock;
      findUniqueOrThrow: jest.Mock;
      create:            jest.Mock;
      update:            jest.Mock;
      findMany:          jest.Mock;
      count:             jest.Mock;
    };
    careRecipient: { findUnique: jest.Mock; create: jest.Mock };
    caregiver:     { findMany:   jest.Mock; findUnique: jest.Mock };
    // PYG-499: ด่าน Onboarding อ่าน role + ชื่อ-นามสกุลของผู้จอง
    user:          { findUnique: jest.Mock };
    caregiverAvailability: { findMany: jest.Mock };
    servicePriceCatalog: { findUnique: jest.Mock };
    $transaction:  jest.Mock;
  };
  // PYG-461 เฟส 3a: cancelBooking มอบเรื่องเงิน+สถานะให้ settle() — ที่นี่แค่ mock ให้สำเร็จ
  let settlement: { settle: jest.Mock };

  beforeEach(async () => {
    // PYG-286: cancelBooking ใช้ $transaction → ใส่ tx mock ที่ส่ง booking.update ของ prisma ให้ callback
    //
    // PYG-434: createBooking ก็ใช้ $transaction แล้วเช่นกัน (booking + ใบ QR ต้องเกิดพร้อมกัน)
    //   → ต่อ tx.booking.create ให้วิ่งกลับไปที่ prisma.booking.create ตัวเดิม
    //     เทสด้านล่างทั้งหมดจึงยัง assert ผ่าน prisma.booking.create ได้เหมือนเดิม ไม่ต้องแก้
    const tx = {
      booking: {
        update: jest.fn((args) => prisma.booking.update(args)),
        create: jest.fn((args) => prisma.booking.create(args)),
      },
      // PYG-460: ติ๊ก "บันทึกผู้รับบริการรายนี้ไว้" → สร้างโปรไฟล์ใน tx เดียวกัน
      careRecipient: {
        create: jest.fn((args) => prisma.careRecipient.create(args)),
      },
      // PYG-361: booking_tasks ถูกเขียนในทรานแซคชันเดียวกับ booking.create
      booking_tasks: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    prisma = {
      booking: {
        findUnique:        jest.fn(),
        findUniqueOrThrow: jest.fn(),
        create:            jest.fn(),
        update:            jest.fn(),
        findMany:          jest.fn(),
        count:             jest.fn(),
      },
      careRecipient: { findUnique: jest.fn(), create: jest.fn() },
      caregiver:     { findMany: jest.fn(), findUnique: jest.fn() },
      // PYG-499: ค่าเริ่มต้น = ผู้สูงอายุที่ผ่าน Onboarding แล้ว (เทสด่านอยู่ที่ booking-onboarding-gate.service.spec.ts)
      user: {
        findUnique: jest.fn().mockResolvedValue({ role: 1, firstName: 'สมศรี', lastName: 'ใจดี' }),
      },
      // PYG-524: findMany ต่อ prisma.caregiver.findUnique — ค่า default ในแต่ละ it() ตั้งเอง
      caregiverAvailability: { findMany: jest.fn() },
      // ราคาจาก catalog (ฟีดแบ็กอาจารย์ Sprint 9 ข้อ 2) — 300 บาท/ชม. ทุกเทส เว้นแต่ override
      servicePriceCatalog: {
        findUnique: jest.fn().mockResolvedValue({ pricePerHour: new Prisma.Decimal(300), isActive: true }),
      },
      $transaction:  jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    settlement = {
      settle: jest.fn().mockResolvedValue({
        bookingId: BOOKING_ID,
        reason: SettlementReason.PATIENT_CANCEL,
        alreadySettled: false,
        bookingStatusBefore: 'accepted',
        bookingStatusAfter: 'cancelled',
        moneyAction: 'none',
        paymentStatusBefore: null,
        paymentStatusAfter: null,
        refundAmount: null,
        refundPercentage: null,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingService,
        { provide: PrismaService, useValue: prisma },
        // PYG-292: BookingService ยิง booking event — mock EventEmitter2
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        // PYG-461 เฟส 3a: cancelBooking เรียก settle() — แทน OmiseService + PaymentStateMachine ของ PYG-286
        { provide: BookingSettlementService, useValue: settlement },
        // PYG-434: สร้างใบ QR พร้อม booking — mock ไว้ ตรรกะจริงเทสที่ job-qr.service.spec.ts
        { provide: JobQrService, useValue: { createForBooking: jest.fn() } },
        // PYG-540: ด่านความยินยอมก่อนจอง — ค่าเริ่มต้น = ไม่มีใครถอน (เทสด่านอยู่ที่ booking-consent-gate.service.spec.ts)
        {
          provide: ConsentService,
          useValue: {
            findWithdrawnType: jest.fn().mockResolvedValue(null),
            withdrawnUserIds: jest.fn().mockResolvedValue(new Set()),
          },
        },
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

    // PYG-526: REST เดิมคืนแค่ timeSlot → client แสดงได้แค่ "ช่วงเช้า" ตอนนี้คืนเวลาจริงด้วย
    it('response มี startTime / endTime / durationHours (endTime = start + ชั่วโมง)', async () => {
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.create.mockResolvedValue(
        fakeBooking({
          startTime: new Date('1970-01-01T11:00:00Z'),
          // Decimal จริงของ Prisma — ต้องออกเป็น number 4 ไม่ใช่ string "4" ใน JSON
          durationHours: new Prisma.Decimal('4'),
        }),
      );

      const result = await service.createBooking(PATIENT_ID, dto);

      expect(result.startTime).toBe('11:00');
      expect(result.endTime).toBe('15:00');
      expect(result.durationHours).toBe(4);
    });

    // ── PYG-523: startTime + endTime → BE คำนวณ durationHours / timeSlot เอง ───

    describe('PYG-523 เวลาเริ่ม–สิ้นสุด', () => {
      const newDto: CreateBookingDto = {
        tasks:            ['อาบน้ำ'],
        serviceLocations: ['บ้าน'],
        serviceType:      'elderly_care',
        startTime:        '13:00',
        endTime:          '16:30',
        locationAddress:  '123 Main St',
        bookingDate:      '2026-07-01',
      };

      it('บันทึก durationHours / timeSlot / startTime ที่คำนวณเอง', async () => {
        prisma.booking.findMany.mockResolvedValue([]);
        prisma.booking.create.mockResolvedValue(fakeBooking());

        await service.createBooking(PATIENT_ID, newDto);

        const call = prisma.booking.create.mock.calls[0][0] as {
          data: Record<string, unknown>;
        };
        expect(call.data.durationHours).toBe(3.5);
        expect(call.data.timeSlot).toBe('afternoon');
        expect(call.data.startTime).toEqual(new Date('1970-01-01T13:00:00Z'));
      });

      it('ราคาประเมิน = ราคา catalog ของ serviceType × ชั่วโมงที่คำนวณ (end − start)', async () => {
        prisma.caregiver.findUnique.mockResolvedValue({
          id: CAREGIVER_ID,
          kycStatus: 'verified',
          isSearchable: true,
        });
        // 13:00–16:30 อยู่ใน afternoon ล้วน (12:00–17:00) — PYG-524 ต้องเจอ slot นี้ active
        prisma.caregiverAvailability.findMany.mockResolvedValue([
          { timeSlot: 'afternoon' },
        ]);
        prisma.booking.findMany.mockResolvedValue([]);
        prisma.booking.create.mockResolvedValue(fakeBooking());

        await service.createBooking(PATIENT_ID, {
          ...newDto,
          caregiverId: 'c2222222-2222-4222-8222-222222222222',
        });

        expect(prisma.servicePriceCatalog.findUnique).toHaveBeenCalledWith(
          expect.objectContaining({ where: { serviceType: newDto.serviceType } }),
        );
        // ไม่อ่าน hourlyRate ของผู้ดูแลอีกแล้ว
        expect(prisma.caregiver.findUnique.mock.calls[0][0].select).not.toHaveProperty('hourlyRate');
        const call = prisma.booking.create.mock.calls[0][0] as {
          data: { estimatedCost: Prisma.Decimal };
        };
        expect(call.data.estimatedCost.toFixed(2)).toBe('1050.00'); // 300 × 3.5
      });

      it('ปัดเป็นสตางค์ HALF_UP — 333.33 × 1.5 = 499.995 → 500.00', async () => {
        prisma.servicePriceCatalog.findUnique.mockResolvedValue({
          pricePerHour: new Prisma.Decimal('333.33'),
          isActive: true,
        });
        prisma.booking.findMany.mockResolvedValue([]);
        prisma.booking.create.mockResolvedValue(fakeBooking());

        await service.createBooking(PATIENT_ID, {
          ...newDto,
          startTime: '13:00',
          endTime: '14:30',
        });

        const call = prisma.booking.create.mock.calls[0][0] as {
          data: { estimatedCost: Prisma.Decimal };
        };
        expect(call.data.estimatedCost.toFixed(2)).toBe('500.00');
      });

      it('จองแบบ unmatched (ไม่มีผู้ดูแล) ก็มีราคาแล้ว — ไม่ขึ้นกับผู้ดูแล', async () => {
        prisma.booking.findMany.mockResolvedValue([]);
        prisma.booking.create.mockResolvedValue(fakeBooking());

        await service.createBooking(PATIENT_ID, newDto);

        const call = prisma.booking.create.mock.calls[0][0] as {
          data: { estimatedCost: Prisma.Decimal; status: string };
        };
        expect(call.data.status).toBe('unmatched');
        expect(call.data.estimatedCost.toFixed(2)).toBe('1050.00');
      });

      it.each([
        ['ไม่มีแถวใน catalog', null],
        ['is_active = false', { pricePerHour: new Prisma.Decimal(300), isActive: false }],
      ])('serviceType ที่ยังไม่เปิดขาย (%s) → 422 ไม่สร้างใบจอง', async (_label, row) => {
        prisma.servicePriceCatalog.findUnique.mockResolvedValue(row);

        await expect(service.createBooking(PATIENT_ID, newDto)).rejects.toBeInstanceOf(
          UnprocessableEntityException,
        );
        expect(prisma.booking.create).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('เช็คเวลาชนด้วยช่วงที่คำนวณ — นัดเดิม 15:00–17:00 ชนกับ 13:00–16:30', async () => {
        prisma.booking.findMany.mockResolvedValue([
          { startTime: new Date('1970-01-01T15:00:00Z'), durationHours: 2 },
        ]);

        await expect(service.createBooking(PATIENT_ID, newDto)).rejects.toThrow(
          ConflictException,
        );
        expect(prisma.booking.create).not.toHaveBeenCalled();
      });

      it('นัดเดิมเริ่มตอนงานใหม่จบพอดี (16:30) → ไม่ชน', async () => {
        prisma.booking.findMany.mockResolvedValue([
          { startTime: new Date('1970-01-01T16:30:00Z'), durationHours: 2 },
        ]);
        prisma.booking.create.mockResolvedValue(fakeBooking());

        await service.createBooking(PATIENT_ID, newDto);

        expect(prisma.booking.create).toHaveBeenCalledTimes(1);
      });

      it('เวลาไม่ผ่านกฎ → 400 ก่อนแตะ DB ใด ๆ', async () => {
        await expect(
          service.createBooking(PATIENT_ID, { ...newDto, endTime: '12:00' }),
        ).rejects.toThrow('เวลาสิ้นสุดต้องหลังเวลาเริ่ม และอยู่ในวันเดียวกัน');

        expect(prisma.booking.findMany).not.toHaveBeenCalled();
        expect(prisma.booking.create).not.toHaveBeenCalled();
      });

      it('แบบเดิม (timeSlot + durationHours) ยังจองได้ และเก็บค่าตามที่ส่งมา', async () => {
        prisma.booking.findMany.mockResolvedValue([]);
        prisma.booking.create.mockResolvedValue(fakeBooking());

        await service.createBooking(PATIENT_ID, dto);

        const call = prisma.booking.create.mock.calls[0][0] as {
          data: Record<string, unknown>;
        };
        expect(call.data.durationHours).toBe(4);
        expect(call.data.timeSlot).toBe('morning');
        expect(call.data.startTime).toEqual(new Date('1970-01-01T09:00:00Z'));
      });
    });

    // ── PYG-524: ต้องเช็ค caregiver_availability จริง ไม่ใช่แค่เชื่อ timeSlot ─────

    describe('PYG-524 เช็ค caregiver_availability ตอนจอง', () => {
      // 2026-07-01 = วันพุธ (dayOfWeek = 3)
      const availDto: CreateBookingDto = {
        tasks:            ['อาบน้ำ'],
        serviceLocations: ['บ้าน'],
        serviceType:      'elderly_care',
        caregiverId:      CAREGIVER_ID,
        startTime:        '09:00',
        endTime:          '11:00', // อยู่ใน morning (06:00–12:00) ล้วน
        locationAddress:  '123 Main St',
        bookingDate:      '2026-07-01',
      };

      beforeEach(() => {
        prisma.caregiver.findUnique.mockResolvedValue({
          id: CAREGIVER_ID,
          kycStatus: 'verified',
          isSearchable: true,
          hourlyRate: 300,
        });
        prisma.booking.findMany.mockResolvedValue([]); // ไม่มีนัดชนอื่น
        prisma.booking.create.mockResolvedValue(fakeBooking());
      });

      it('จองช่วงที่ผู้ดูแลไม่ได้เปิดรับ (ไม่มี slot active เลย) → ถูกปฏิเสธ', async () => {
        prisma.caregiverAvailability.findMany.mockResolvedValue([]);

        await expect(service.createBooking(PATIENT_ID, availDto)).rejects.toThrow(
          'ผู้ดูแลไม่ได้เปิดรับงานในช่วงเวลานี้',
        );
        expect(prisma.booking.create).not.toHaveBeenCalled();
      });

      it('คร่อม 2 slot (11:00–14:00 = morning+afternoon) ที่ว่างทั้งคู่ → ผ่าน', async () => {
        prisma.caregiverAvailability.findMany.mockResolvedValue([
          { timeSlot: 'morning' },
          { timeSlot: 'afternoon' },
        ]);

        await service.createBooking(PATIENT_ID, {
          ...availDto,
          startTime: '11:00',
          endTime:   '14:00',
        });

        expect(prisma.booking.create).toHaveBeenCalledTimes(1);
      });

      it('คร่อม 2 slot แต่ว่างแค่ slot เดียว (morning ว่าง, afternoon ไม่ว่าง) → ไม่ผ่าน', async () => {
        prisma.caregiverAvailability.findMany.mockResolvedValue([
          { timeSlot: 'morning' },
        ]);

        await expect(
          service.createBooking(PATIENT_ID, {
            ...availDto,
            startTime: '11:00',
            endTime:   '14:00',
          }),
        ).rejects.toThrow('ผู้ดูแลไม่ได้เปิดรับงานในช่วงเวลานี้');
        expect(prisma.booking.create).not.toHaveBeenCalled();
      });

      it('ไม่ส่ง caregiverId มา (จองแบบ unmatched) → ไม่เช็ค availability เลย', async () => {
        prisma.booking.create.mockResolvedValue(
          fakeBooking({ caregiverId: null, status: 'unmatched' }),
        );

        await service.createBooking(PATIENT_ID, {
          ...availDto,
          caregiverId: undefined,
        });

        expect(prisma.caregiverAvailability.findMany).not.toHaveBeenCalled();
        expect(prisma.booking.create).toHaveBeenCalledTimes(1);
      });
    });

    // ── บั๊ก: เช็คเวลาชนของผู้จองเดิมไม่นับสถานะ accepted ────────────────────────

    it('นัดเดิมของผู้จอง (เจ้าตัว) สถานะ accepted ในเวลาเดียวกัน → ถือว่าชน (409)', async () => {
      prisma.booking.findMany.mockResolvedValue([
        { startTime: new Date('1970-01-01T10:00:00Z'), durationHours: 2 },
      ]);

      await expect(service.createBooking(PATIENT_ID, dto)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: { in: ['pending', 'accepted', 'confirmed'] },
          }),
        }),
      );
      expect(prisma.booking.create).not.toHaveBeenCalled();
    });

    // ── PYG-460: ข้อมูลสุขภาพผู้รับบริการ ─────────────────────────────────────

    it('เก็บ patientProfile เป็น snapshot ลง member_details', async () => {
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.create.mockResolvedValue(fakeBooking());

      await service.createBooking(PATIENT_ID, {
        ...dto,
        patientProfile: { age: 72, gender: 'หญิง', allergies: 'แพ้ยากลุ่มซัลฟา' },
      });

      const call = prisma.booking.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      // เก็บรูปทรงเดิมที่ FE ส่งมา ไม่แปลงเป็น enum — เพราะเป็นสำเนาไว้อ่าน ไม่ใช่ไว้ query
      expect(call.data.memberDetails).toEqual({
        age: 72, gender: 'หญิง', allergies: 'แพ้ยากลุ่มซัลฟา',
      });
    });

    it('ไม่ส่ง patientProfile มา → ไม่แตะ member_details', async () => {
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.create.mockResolvedValue(fakeBooking());

      await service.createBooking(PATIENT_ID, dto);

      const call = prisma.booking.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(call.data.memberDetails).toBeUndefined();
    });

    it('saveAsProfile → สร้าง care_recipient แล้วผูกกับ booking ใบเดียวกัน', async () => {
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.create.mockResolvedValue(fakeBooking());
      prisma.careRecipient.create.mockResolvedValue({ id: 'new-recipient-id' });

      await service.createBooking(PATIENT_ID, {
        ...dto,
        patientName:    'คุณย่า',
        saveAsProfile:  true,
        patientProfile: { supportLevel: 'ช่วยเหลือตัวเองไม่ได้ / ติดเตียง' },
      });

      // โปรไฟล์เขียนลงคอลัมน์จริง (แปลงเป็น enum) ไม่ใช่เก็บเป็นข้อความไทย
      const profileCall = prisma.careRecipient.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(profileCall.data.name).toBe('คุณย่า');
      expect(profileCall.data.mobility_level).toBe('bedridden');

      // ★ หัวใจของเรื่อง: booking ที่เพิ่งสร้างต้องผูกกับโปรไฟล์ที่เพิ่งสร้าง
      //   ก่อน PYG-460 คอลัมน์นี้ว่างทั้งตาราง (dry-run: 0 จาก 101 ใบ)
      const bookingCall = prisma.booking.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(bookingCall.data.careRecipientId).toBe('new-recipient-id');

      // ทั้งคู่ต้องอยู่ใน transaction เดียว ไม่งั้น booking พังแล้วเหลือโปรไฟล์ค้าง
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('saveAsProfile ไม่สร้างซ้ำเมื่อเลือกโปรไฟล์เดิมอยู่แล้ว', async () => {
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.create.mockResolvedValue(fakeBooking());
      prisma.careRecipient.findUnique.mockResolvedValue({ patientId: PATIENT_ID });

      await service.createBooking(PATIENT_ID, {
        ...dto,
        careRecipientId: 'r-uuid',
        patientName:     'คุณย่า',
        saveAsProfile:   true,
      });

      expect(prisma.careRecipient.create).not.toHaveBeenCalled();
    });

    it('saveAsProfile ไม่สร้างโปรไฟล์ไร้ชื่อ', async () => {
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.create.mockResolvedValue(fakeBooking());

      // name เป็นคอลัมน์ NOT NULL — ไม่มีชื่อก็ไม่มีอะไรจะบันทึก
      await service.createBooking(PATIENT_ID, { ...dto, saveAsProfile: true });

      expect(prisma.careRecipient.create).not.toHaveBeenCalled();
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

  /**
   * PYG-461 เฟส 3a — สถานะไหนยกเลิกได้/ไม่ได้ ย้ายไปเป็นของ settle() แล้ว
   * (SETTLEABLE_FROM[PATIENT_CANCEL] = unmatched/pending/accepted/confirmed)
   * ที่นี่จึงเทสแค่ว่า endpoint ต่อสายถูกและส่ง error ของ settle กลับไปให้ผู้ใช้เห็น
   */
  describe('cancelBooking', () => {
    beforeEach(() => {
      prisma.booking.findUniqueOrThrow.mockResolvedValue(
        fakeBooking({ status: 'cancelled' }),
      );
    });

    it.each(['unmatched', 'pending', 'accepted', 'confirmed'])(
      'ยกเลิก booking สถานะ %s ได้ — ส่งต่อให้ settle ตัดสินเรื่องเงิน',
      async (status) => {
        prisma.booking.findUnique.mockResolvedValue(fakeBooking({ status }));

        const result = await service.cancelBooking(BOOKING_ID, PATIENT_ID);

        expect(result.status).toBe('cancelled');
        expect(settlement.settle).toHaveBeenCalledWith(
          BOOKING_ID,
          SettlementReason.PATIENT_CANCEL,
          { id: PATIENT_ID, role: 'patient' },
        );
      },
    );

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
      expect(settlement.settle).not.toHaveBeenCalled();
    });

    it('booking ที่จบงานแล้ว → settle ตอบ 422 แล้ว endpoint ส่งต่อให้ผู้ใช้', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking({ status: 'completed' }));
      settlement.settle.mockRejectedValue(
        new SettlementBlockedError(
          'booking_not_settleable',
          'งานนี้จบแล้ว ยกเลิกไม่ได้',
        ),
      );

      await expect(service.cancelBooking(BOOKING_ID, PATIENT_ID))
        .rejects.toThrow(UnprocessableEntityException);
    });

    /**
     * ★ พฤติกรรมเปลี่ยนโดยตั้งใจ: เดิมยกเลิกใบที่ 'cancelled' อยู่แล้ว = 422
     *   ตอนนี้ settle คืน alreadySettled แล้ว endpoint ตอบสำเร็จ (idempotent)
     *   เพราะเคสจริงคือผู้ใช้กดซ้ำ/เน็ตหลุดแล้วกดใหม่ — ตอบ error ทั้งที่ใบถูกยกเลิกไปแล้ว
     *   ทำให้ FE ต้องเดาว่าตกลงยกเลิกสำเร็จหรือไม่ ส่วนการไม่แจ้งเตือนซ้ำคุมไว้ที่ booking.service.spec
     */
    it('ยกเลิกใบที่ยกเลิกไปแล้ว → สำเร็จแบบ idempotent ไม่ใช่ 422', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking({ status: 'cancelled' }));
      settlement.settle.mockResolvedValue({
        bookingId: BOOKING_ID,
        reason: SettlementReason.PATIENT_CANCEL,
        alreadySettled: true,
        bookingStatusBefore: 'cancelled',
        bookingStatusAfter: 'cancelled',
        moneyAction: 'none',
        paymentStatusBefore: null,
        paymentStatusAfter: null,
        refundAmount: null,
        refundPercentage: null,
      });

      const result = await service.cancelBooking(BOOKING_ID, PATIENT_ID);
      expect(result.status).toBe('cancelled');
    });

    it('booking ที่ผู้ดูแลปฏิเสธไปแล้ว → settle ตอบ 422', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking({ status: 'rejected' }));
      settlement.settle.mockRejectedValue(
        new SettlementBlockedError(
          'booking_not_settleable',
          'การจองนี้ถูกปฏิเสธไปแล้ว',
        ),
      );

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
