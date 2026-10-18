/**
 * ข้อมูลโรคติดเชื้อในคำขอรับงาน + การรับทราบก่อนรับงาน (PYG-619: E2, E4, E5, E7, E9, E10, R5–R8)
 *
 * ⚠ ค่าโรคติดเชื้อเป็นข้อมูลสุขภาพ: เทสนี้ยืนยันด้วยว่าไม่หลุดลง log / error / event
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CaregiverBookingService } from './caregiver-booking.service';
import { CaregiverBookingResolver } from './caregiver-booking.resolver';
import { PrismaService } from '../common/prisma.service';
import { ClockService } from '../common/clock.service';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { ROLE_ID } from '../common/constants/roles.constant';

const USER_ID = 'cg-user-1';
const CAREGIVER_ID = 'cg-1';
const OTHER_CAREGIVER_ID = 'cg-2';
const BOOKING_ID = 'booking-aaa';
const RECIPIENT_ID = 'cr-1';
const NOW = new Date('2026-06-30T00:00:00.000Z');

function bookingRow(over: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    status: 'pending',
    caregiverId: CAREGIVER_ID,
    serviceType: 'general_care',
    serviceLocations: ['home'],
    tasks: [],
    timeSlot: 'morning',
    bookingDate: new Date('2026-07-01'),
    startTime: new Date('1970-01-01T09:00:00.000Z'),
    durationHours: { toNumber: () => 3 },
    locationAddress: '123 Main St',
    locationLat: null,
    locationLng: null,
    notes: null,
    dayOfContactName: null,
    dayOfContactPhone: null,
    dayOfContactRelationship: null,
    estimatedCost: null,
    acceptedAt: null,
    confirmedAt: null,
    rejectionReason: null,
    createdAt: new Date('2026-06-01T08:00:00Z'),
    familyGroupId: null,
    bookedBy: null,
    patient: { id: 'patient-1', displayName: 'สมศรี', avatarUrl: null },
    careRecipient: {
      name: 'คุณยาย',
      patientId: 'patient-1',
      is_self: false,
      patient: { avatarUrl: null },
      has_infectious_disease: true,
      infectious_disease_updated_at: new Date('2026-06-10T00:00:00Z'),
    },
    payout: null,
    memberDetails: null,
    infectionAckAt: null,
    infectionAckBy: null,
    ...over,
  };
}

describe('CaregiverBookingService — ข้อมูลโรคติดเชื้อ (PYG-619)', () => {
  let service: CaregiverBookingService;
  let prisma: any;
  let tx: any;
  let emit: jest.Mock;
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  let recipientValue: boolean | null;
  let bookingStatus: string;
  let careRecipientId: string | null;

  beforeEach(async () => {
    recipientValue = true;
    bookingStatus = 'pending';
    careRecipientId = RECIPIENT_ID;
    emit = jest.fn();

    tx = {
      careRecipient: {
        findUnique: jest.fn(async () => ({ has_infectious_disease: recipientValue })),
      },
      booking: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]), // เช็คเวลาชน: ไม่มีงานซ้อน
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    prisma = {
      caregiver: { findUnique: jest.fn().mockResolvedValue({ id: CAREGIVER_ID }) },
      booking: {
        findUnique: jest.fn(async ({ select, include }: any) => {
          if (include) return bookingRow({ status: 'accepted', infectionAckAt: NOW, infectionAckBy: CAREGIVER_ID });
          if (select?.caregiverId) return { id: BOOKING_ID, caregiverId: CAREGIVER_ID, status: bookingStatus };
          return {
            bookingDate: new Date('2026-07-01'),
            startTime: new Date('1970-01-01T09:00:00.000Z'),
            durationHours: { toNumber: () => 3 },
            careRecipientId,
          };
        }),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
    };

    const mod = await Test.createTestingModule({
      providers: [
        CaregiverBookingService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: { emit } },
        { provide: ClockService, useValue: { now: () => NOW } },
      ],
    }).compile();
    service = mod.get(CaregiverBookingService);
    logSpy = jest.spyOn(service['logger'], 'log').mockImplementation();
    errSpy = jest.spyOn(service['logger'], 'error').mockImplementation();
  });

  // ── รับงาน ────────────────────────────────────────────────────────────────

  describe('acceptBooking', () => {
    it('R5/E4: งานที่ต้องรับทราบ แต่ไม่ส่ง infectionAcknowledged -> INFECTION_ACK_REQUIRED (422) สถานะงานไม่เปลี่ยน', async () => {
      await expect(service.acceptBooking(USER_ID, BOOKING_ID)).rejects.toMatchObject({
        message: expect.stringContaining('รับทราบ'),
        extensions: { code: 'INFECTION_ACK_REQUIRED', statusCode: 422 },
      });
      expect(tx.booking.updateMany).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it.each([[false], [undefined]])(
      'E10: client เก่า/ส่ง infectionAcknowledged = %s -> INFECTION_ACK_REQUIRED พร้อมข้อความบอกเหตุผล',
      async (ack) => {
        const err = await service.acceptBooking(USER_ID, BOOKING_ID, ack).catch((e) => e);
        expect(err.extensions.code).toBe('INFECTION_ACK_REQUIRED');
        expect(err.message.length).toBeGreaterThan(10);
        expect(tx.booking.updateMany).not.toHaveBeenCalled();
      },
    );

    it('R6: รับทราบ + รับงาน -> บันทึก infection_ack_at/by ใน statement เดียวกับการเปลี่ยนสถานะ (transaction เดียว)', async () => {
      await service.acceptBooking(USER_ID, BOOKING_ID, true);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.booking.updateMany).toHaveBeenCalledTimes(1);
      expect(tx.booking.updateMany).toHaveBeenCalledWith({
        where: { id: BOOKING_ID, status: 'pending' },
        data: {
          status: 'accepted',
          acceptedAt: NOW,
          infectionAckAt: NOW,
          infectionAckBy: CAREGIVER_ID,
        },
      });
    });

    it('อ่านค่าโรคติดเชื้อล่าสุด "ใน transaction" (tx) ไม่ใช่นอก — กันญาติแก้ค่าระหว่างกดรับ', async () => {
      await service.acceptBooking(USER_ID, BOOKING_ID, true);
      expect(tx.careRecipient.findUnique).toHaveBeenCalledWith({
        where: { id: RECIPIENT_ID },
        select: { has_infectious_disease: true },
      });
      expect(prisma.careRecipient).toBeUndefined();
    });

    it('ค่าเปลี่ยนเป็น "มี" ก่อนกดรับ (E2): ใช้ค่าล่าสุดใน tx -> ไม่ส่งการรับทราบ = ถูกปฏิเสธ', async () => {
      recipientValue = false;
      await expect(service.acceptBooking(USER_ID, BOOKING_ID)).resolves.toBeDefined(); // ค่าเดิม "ไม่มี" ไม่บังคับ
      tx.booking.updateMany.mockClear();
      recipientValue = true; // ญาติแก้ระหว่างทาง
      await expect(service.acceptBooking(USER_ID, BOOKING_ID)).rejects.toMatchObject({
        extensions: { code: 'INFECTION_ACK_REQUIRED' },
      });
      expect(tx.booking.updateMany).not.toHaveBeenCalled();
    });

    it('งานที่ไม่ต้องรับทราบ (ตามนโยบายปัจจุบัน): รับได้โดยไม่ส่ง และไม่เขียน infection_ack', async () => {
      recipientValue = false;
      await service.acceptBooking(USER_ID, BOOKING_ID);
      const data = tx.booking.updateMany.mock.calls[0][0].data;
      expect(data).toEqual({ status: 'accepted', acceptedAt: NOW });
    });

    it('จองให้ตัวเอง (ไม่มีโปรไฟล์ผู้รับการดูแล) -> ไม่ query care_recipients และไม่บังคับ', async () => {
      careRecipientId = null;
      await expect(service.acceptBooking(USER_ID, BOOKING_ID)).resolves.toBeDefined();
      expect(tx.careRecipient.findUnique).not.toHaveBeenCalled();
    });

    it('กดรับซ้ำ/สองคำขอพร้อมกัน: ผู้แพ้ได้ Conflict และไม่เขียนเวลารับทราบทับ', async () => {
      tx.booking.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.acceptBooking(USER_ID, BOOKING_ID, true)).rejects.toMatchObject({
        status: 409,
      });
      // เงื่อนไข WHERE status='pending' คือตัวกัน — ผู้ชนะเขียนครั้งเดียว
      expect(tx.booking.updateMany.mock.calls[0][0].where).toEqual({ id: BOOKING_ID, status: 'pending' });
    });

    it('กดรับซ้ำหลังรับแล้ว (สถานะไม่ใช่ pending) -> 422 ก่อนถึง tx ไม่แตะเวลารับทราบ', async () => {
      bookingStatus = 'accepted';
      await expect(service.acceptBooking(USER_ID, BOOKING_ID, true)).rejects.toMatchObject({ status: 422 });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('E8: ค่าโรคติดเชื้อไม่หลุดลง log / event หลังรับงาน', async () => {
      await service.acceptBooking(USER_ID, BOOKING_ID, true);
      const dump = JSON.stringify([logSpy.mock.calls, errSpy.mock.calls, emit.mock.calls]);
      expect(dump).not.toMatch(/infect|has_infectious|hasInfectious/i);
    });

    it('E8: ข้อความ error ไม่มีค่าโรคติดเชื้อ', async () => {
      const err = await service.acceptBooking(USER_ID, BOOKING_ID).catch((e) => e);
      expect(JSON.stringify([err.message, err.extensions])).not.toMatch(/"?(true|false)"?.*infect|hasInfectious/i);
    });

    it('E7: ผู้ดูแลอื่นเรียกรับงานของคนอื่น -> ปฏิเสธ (สิทธิ์จาก session) ก่อนอ่านข้อมูลสุขภาพ', async () => {
      prisma.caregiver.findUnique.mockResolvedValue({ id: OTHER_CAREGIVER_ID });
      prisma.booking.findUnique.mockImplementationOnce(async () => ({
        id: BOOKING_ID,
        caregiverId: CAREGIVER_ID,
        status: 'pending',
      }));
      await expect(service.acceptBooking('other-user', BOOKING_ID, true)).rejects.toBeInstanceOf(ForbiddenException);
      expect(tx.careRecipient.findUnique).not.toHaveBeenCalled();
    });
  });

  // ── อ่านคำขอ ──────────────────────────────────────────────────────────────

  describe('infectionDisclosure ใน CaregiverBookingSummary', () => {
    const read = async (over: Record<string, unknown>) => {
      prisma.booking.findFirst.mockResolvedValue(bookingRow(over));
      return service.caregiverBooking(USER_ID, BOOKING_ID);
    };

    it('R4: คำขอ pending ของผู้ดูแลเจ้าของ -> เห็นค่า (ยังไม่รับทราบ)', async () => {
      const s = await read({});
      expect(s?.infectionDisclosure).toEqual({ hasInfectiousDisease: true, acknowledgedAt: null });
      expect(s?.infectionDisclosureViewerUserId).toBe(USER_ID);
    });

    it.each(['accepted', 'confirmed'])('สถานะ %s ยังเห็นอยู่', async (status) => {
      expect((await read({ status }))?.infectionDisclosure).not.toBeNull();
    });

    it.each(['rejected', 'expired', 'cancelled', 'unmatched', 'completed'])(
      'E5/E6: สถานะ %s -> infectionDisclosure = null (ไม่ส่งให้อีก)',
      async (status) => {
        const s = await read({ status });
        expect(s?.infectionDisclosure).toBeNull();
        expect(s?.infectionDisclosureViewerUserId).toBeUndefined();
      },
    );

    it('E1: ยังไม่ได้ระบุ -> hasInfectiousDisease = null (ไม่แปลงเป็น false)', async () => {
      const s = await read({
        careRecipient: { ...bookingRow().careRecipient, has_infectious_disease: null, infectious_disease_updated_at: null },
      });
      expect(s?.infectionDisclosure?.hasInfectiousDisease).toBeNull();
    });

    it('จองให้ตัวเอง (ไม่มีโปรไฟล์) -> hasInfectiousDisease = null', async () => {
      const s = await read({ careRecipient: null });
      expect(s?.infectionDisclosure).toEqual({ hasInfectiousDisease: null, acknowledgedAt: null });
    });

    it('E2: รับทราบก่อนญาติแก้ค่า -> acknowledgedAt = null (ไม่นับ) · รับทราบหลังแก้ -> เห็นเวลา', async () => {
      const ackBefore = new Date('2026-06-05T00:00:00Z'); // ก่อน updated_at 2026-06-10
      const ackAfter = new Date('2026-06-20T00:00:00Z');
      expect((await read({ status: 'accepted', infectionAckAt: ackBefore, infectionAckBy: CAREGIVER_ID }))
        ?.infectionDisclosure?.acknowledgedAt).toBeNull();
      expect((await read({ status: 'accepted', infectionAckAt: ackAfter, infectionAckBy: CAREGIVER_ID }))
        ?.infectionDisclosure?.acknowledgedAt).toEqual(ackAfter);
    });

    it('การรับทราบของผู้ดูแลคนก่อน (booking ถูกกู้ไปให้คนอื่น) ไม่นับ', async () => {
      const s = await read({ status: 'accepted', infectionAckAt: NOW, infectionAckBy: OTHER_CAREGIVER_ID });
      expect(s?.infectionDisclosure?.acknowledgedAt).toBeNull();
    });

    it('E7: booking ที่ผูกกับผู้ดูแลคนอื่น -> ไม่ได้ข้อมูล (query กรอง caregiverId ของผู้ใช้ที่ล็อกอิน + ชั้น summary ตรวจซ้ำ)', async () => {
      await read({});
      expect(prisma.booking.findFirst.mock.calls[0][0].where).toEqual({ id: BOOKING_ID, caregiverId: CAREGIVER_ID });
      const s = await read({ caregiverId: OTHER_CAREGIVER_ID });
      expect(s?.infectionDisclosure).toBeNull();
    });

    it('เลือกเฉพาะคอลัมน์โรคติดเชื้อ 2 ตัวจาก care_recipients (ไม่ดึงทั้งแถว)', async () => {
      await read({});
      const include = prisma.booking.findFirst.mock.calls.at(-1)[0].include;
      expect(Object.keys(include.careRecipient.select).sort()).toEqual(
        ['has_infectious_disease', 'infectious_disease_updated_at', 'is_self', 'name', 'patient', 'patientId'].sort(),
      );
    });

    it('รายการ (list) ใช้กติกาเดียวกัน: เห็นเฉพาะของผู้ดูแลที่ล็อกอิน', async () => {
      prisma.booking.findMany.mockResolvedValue([bookingRow(), bookingRow({ id: 'b2', status: 'rejected' })]);
      prisma.booking.count.mockResolvedValue(2);
      const res = await service.caregiverBookings(USER_ID, { status: 'pending' } as never);
      expect(res.data.map((d) => d.infectionDisclosure !== null)).toEqual([true, false]);
      expect(prisma.booking.findMany.mock.calls[0][0].where.caregiverId).toBe(CAREGIVER_ID);
    });
  });

  // ── ชั้น resolver ──────────────────────────────────────────────────────────

  describe('CaregiverBookingResolver.infectionDisclosure (field-level)', () => {
    const resolver = new CaregiverBookingResolver({} as never, {} as never, {} as never);
    const summary = (viewer: string | undefined) =>
      ({
        infectionDisclosure: { hasInfectiousDisease: true, acknowledgedAt: null },
        infectionDisclosureViewerUserId: viewer,
      }) as never;

    it('ส่งต่อเมื่อผู้ขอ = ผู้ที่ service ประกอบค่าให้', () => {
      expect(resolver.infectionDisclosure(summary(USER_ID), { id: USER_ID } as never)).toEqual({
        hasInfectiousDisease: true,
        acknowledgedAt: null,
      });
    });

    it('E7: ผู้ขอเป็นคนอื่น หรือไม่มี viewer -> null', () => {
      expect(resolver.infectionDisclosure(summary(USER_ID), { id: 'someone-else' } as never)).toBeNull();
      expect(resolver.infectionDisclosure(summary(undefined), { id: USER_ID } as never)).toBeNull();
    });

    it('เฉพาะ role ผู้ดูแลเรียก resolver ได้ (ไม่ใช่ patient/admin/public)', () => {
      expect(Reflect.getMetadata(ROLES_KEY, CaregiverBookingResolver)).toEqual([ROLE_ID.CAREGIVER]);
    });
  });
});
