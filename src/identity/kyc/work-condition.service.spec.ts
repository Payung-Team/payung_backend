import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { JobTypeEligibilityService } from './job-type/job-type-eligibility.service';
import { WorkConditionService } from './work-condition.service';
import { PrismaService } from '../../common/prisma.service';

// ── Helpers ────────────────────────────────────────────────────────────────

const USER_ID = 'user-123';
const CAREGIVER_ID = 'cg-456';

/** caregiver + relation ตามรูปที่ findUnique({ include }) คืน */
function fakeCaregiver(overrides: Record<string, unknown> = {}) {
  return {
    id: CAREGIVER_ID,
    userId: USER_ID,
    kycStatus: 'verified',
    serviceAreaProvince: 'กรุงเทพมหานคร',
    serviceAreaDistrict: 'บางรัก',
    availability: [
      { dayOfWeek: 1, timeSlot: 'morning', isActive: true },
      { dayOfWeek: 1, timeSlot: 'afternoon', isActive: false },
    ],
    serviceLocations: [
      { serviceLocation: 'at_home' },
      { serviceLocation: 'accompany_outside' },
    ],
    jobTypes: [{ jobType: 'general_care' }, { jobType: 'physiotherapy' }],
    ...overrides,
  };
}

// ── Setup ──────────────────────────────────────────────────────────────────

describe('WorkConditionService', () => {
  let service: WorkConditionService;
  let prisma: {
    caregiver: { findUnique: jest.Mock; update: jest.Mock };
    caregiverAvailability: { deleteMany: jest.Mock; createMany: jest.Mock };
    caregiverServiceLocation: { deleteMany: jest.Mock; createMany: jest.Mock };
    caregiverJobType: { deleteMany: jest.Mock; createMany: jest.Mock };
    $transaction: jest.Mock;
  };

  let eligibility: { assertAllowed: jest.Mock; evaluateAll: jest.Mock };

  beforeEach(async () => {
    eligibility = { assertAllowed: jest.fn().mockResolvedValue(undefined), evaluateAll: jest.fn() };
    prisma = {
      caregiver: { findUnique: jest.fn(), update: jest.fn() },
      caregiverAvailability: { deleteMany: jest.fn(), createMany: jest.fn() },
      caregiverServiceLocation: { deleteMany: jest.fn(), createMany: jest.fn() },
      caregiverJobType: { deleteMany: jest.fn(), createMany: jest.fn() },
      // $transaction(cb) → เรียก cb โดยส่ง prisma ตัวเดิมเป็น tx
      // ทำให้ tx.caregiverAvailability.* เป็น mock เดียวกับ prisma.* → assert ได้
      $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(prisma)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkConditionService,
        { provide: PrismaService, useValue: prisma },
        // ตัวตรวจประเภทงาน (PYG-592) ทดสอบแยกใน job-type-eligibility.service.spec.ts และด้านล่าง
        { provide: JobTypeEligibilityService, useValue: eligibility },
      ],
    }).compile();

    service = module.get<WorkConditionService>(WorkConditionService);
  });

  // ── getByUserId ───────────────────────────────────────────────────────────

  describe('getByUserId', () => {
    it('returns mapped WorkCondition on happy path', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(fakeCaregiver());

      const result = await service.getByUserId(USER_ID);

      expect(prisma.caregiver.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: USER_ID },
          include: {
            availability: true,
            serviceLocations: true,
            jobTypes: true,
          },
        }),
      );
      expect(result.availability).toHaveLength(2);
      // serviceLocations + jobTypes คืนแยกกัน + เรียงด้วย sort()
      expect(result.serviceLocations).toEqual(['accompany_outside', 'at_home']);
      expect(result.jobTypes).toEqual(['general_care', 'physiotherapy']);
      expect(result.serviceArea).toEqual({
        province: 'กรุงเทพมหานคร',
        district: 'บางรัก',
      });
    });

    it('sorts availability by dayOfWeek then timeSlot', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(
        fakeCaregiver({
          availability: [
            { dayOfWeek: 2, timeSlot: 'morning', isActive: true },
            { dayOfWeek: 1, timeSlot: 'morning', isActive: true },
            { dayOfWeek: 1, timeSlot: 'afternoon', isActive: true },
          ],
        }),
      );

      const result = await service.getByUserId(USER_ID);

      expect(result.availability.map((s) => [s.dayOfWeek, s.timeSlot])).toEqual([
        [1, 'afternoon'],
        [1, 'morning'],
        [2, 'morning'],
      ]);
    });

    it('maps null service area fields to undefined', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(
        fakeCaregiver({ serviceAreaProvince: null, serviceAreaDistrict: null }),
      );

      const result = await service.getByUserId(USER_ID);

      expect(result.serviceArea.province).toBeUndefined();
      expect(result.serviceArea.district).toBeUndefined();
    });

    it('throws NotFoundException when caregiver does not exist', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(null);

      await expect(service.getByUserId(USER_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ForbiddenException when kycStatus is not verified', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(
        fakeCaregiver({ kycStatus: 'pending' }),
      );

      await expect(service.getByUserId(USER_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // ── updateByUserId ──────────────────────────────────────────────────────────

  describe('updateByUserId', () => {
    it('replaces all four sections on happy path', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(fakeCaregiver());

      await service.updateByUserId(USER_ID, {
        availability: [{ dayOfWeek: 1, timeSlot: 'morning', isActive: true }],
        serviceLocations: ['at_home'],
        jobTypes: ['general_care'],
        serviceArea: { province: 'เชียงใหม่', district: 'เมือง' },
      });

      // availability: ลบเก่า + ใส่ใหม่
      expect(prisma.caregiverAvailability.deleteMany).toHaveBeenCalledWith({
        where: { caregiverId: CAREGIVER_ID },
      });
      expect(prisma.caregiverAvailability.createMany).toHaveBeenCalledWith({
        data: [
          {
            caregiverId: CAREGIVER_ID,
            dayOfWeek: 1,
            timeSlot: 'morning',
            isActive: true,
          },
        ],
      });
      // serviceLocations: ลบเก่า + ใส่ใหม่ (คนละตารางกับ jobTypes)
      expect(prisma.caregiverServiceLocation.deleteMany).toHaveBeenCalledWith({
        where: { caregiverId: CAREGIVER_ID },
      });
      expect(prisma.caregiverServiceLocation.createMany).toHaveBeenCalledWith({
        data: [{ caregiverId: CAREGIVER_ID, serviceLocation: 'at_home' }],
      });
      // jobTypes: ลบเก่า + ใส่ใหม่
      expect(prisma.caregiverJobType.deleteMany).toHaveBeenCalledWith({
        where: { caregiverId: CAREGIVER_ID },
      });
      expect(prisma.caregiverJobType.createMany).toHaveBeenCalledWith({
        data: [{ caregiverId: CAREGIVER_ID, jobType: 'general_care' }],
      });
      // serviceArea: update คอลัมน์บน caregivers
      expect(prisma.caregiver.update).toHaveBeenCalledWith({
        where: { id: CAREGIVER_ID },
        data: {
          serviceAreaProvince: 'เชียงใหม่',
          serviceAreaDistrict: 'เมือง',
        },
      });
    });

    it('throws NotFoundException when caregiver does not exist', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(null);

      await expect(service.updateByUserId(USER_ID, {})).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when kycStatus is not verified', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(
        fakeCaregiver({ kycStatus: 'rejected' }),
      );

      await expect(service.updateByUserId(USER_ID, {})).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('only touches the sections that are provided (partial update)', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(fakeCaregiver());

      await service.updateByUserId(USER_ID, {
        availability: [{ dayOfWeek: 0, timeSlot: 'evening', isActive: true }],
        // serviceLocations + jobTypes + serviceArea omitted → must not be touched
      });

      expect(prisma.caregiverAvailability.deleteMany).toHaveBeenCalled();
      expect(prisma.caregiverServiceLocation.deleteMany).not.toHaveBeenCalled();
      expect(prisma.caregiverJobType.deleteMany).not.toHaveBeenCalled();
      expect(prisma.caregiver.update).not.toHaveBeenCalled();
    });

    it('updates serviceLocations without touching jobTypes (sections independent)', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(fakeCaregiver());

      await service.updateByUserId(USER_ID, {
        serviceLocations: ['at_home', 'accompany_outside'],
        // jobTypes omitted → must not be touched (the PYG-259 bug: they were coupled)
      });

      expect(prisma.caregiverServiceLocation.deleteMany).toHaveBeenCalledWith({
        where: { caregiverId: CAREGIVER_ID },
      });
      expect(prisma.caregiverServiceLocation.createMany).toHaveBeenCalledWith({
        data: [
          { caregiverId: CAREGIVER_ID, serviceLocation: 'at_home' },
          { caregiverId: CAREGIVER_ID, serviceLocation: 'accompany_outside' },
        ],
      });
      expect(prisma.caregiverJobType.deleteMany).not.toHaveBeenCalled();
    });

    it('clears serviceLocations when an empty array is sent', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(fakeCaregiver());

      await service.updateByUserId(USER_ID, { serviceLocations: [] });

      // ลบของเก่า แต่ไม่ insert ใหม่ (array ว่าง)
      expect(prisma.caregiverServiceLocation.deleteMany).toHaveBeenCalledWith({
        where: { caregiverId: CAREGIVER_ID },
      });
      expect(prisma.caregiverServiceLocation.createMany).not.toHaveBeenCalled();
    });

    it('dedupes serviceLocations (last duplicate dropped)', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(fakeCaregiver());

      await service.updateByUserId(USER_ID, {
        serviceLocations: ['at_home', 'at_home', 'accompany_outside'],
      });

      expect(prisma.caregiverServiceLocation.createMany).toHaveBeenCalledWith({
        data: [
          { caregiverId: CAREGIVER_ID, serviceLocation: 'at_home' },
          { caregiverId: CAREGIVER_ID, serviceLocation: 'accompany_outside' },
        ],
      });
    });

    it('clears a section when an empty array is sent', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(fakeCaregiver());

      await service.updateByUserId(USER_ID, { jobTypes: [] });

      // ลบของเก่า แต่ไม่ insert ใหม่ (array ว่าง)
      expect(prisma.caregiverJobType.deleteMany).toHaveBeenCalledWith({
        where: { caregiverId: CAREGIVER_ID },
      });
      expect(prisma.caregiverJobType.createMany).not.toHaveBeenCalled();
    });

    it('dedupes availability by (dayOfWeek,timeSlot), last one wins', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(fakeCaregiver());

      await service.updateByUserId(USER_ID, {
        availability: [
          { dayOfWeek: 1, timeSlot: 'morning', isActive: true },
          { dayOfWeek: 1, timeSlot: 'morning', isActive: false }, // duplicate → wins
        ],
      });

      expect(prisma.caregiverAvailability.createMany).toHaveBeenCalledWith({
        data: [
          {
            caregiverId: CAREGIVER_ID,
            dayOfWeek: 1,
            timeSlot: 'morning',
            isActive: false,
          },
        ],
      });
    });

    it('defaults isActive to true when omitted', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(fakeCaregiver());

      await service.updateByUserId(USER_ID, {
        availability: [{ dayOfWeek: 3, timeSlot: 'morning' }],
      });

      expect(prisma.caregiverAvailability.createMany).toHaveBeenCalledWith({
        data: [
          {
            caregiverId: CAREGIVER_ID,
            dayOfWeek: 3,
            timeSlot: 'morning',
            isActive: true,
          },
        ],
      });
    });

    it('dedupes, trims, and drops empty job types', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(fakeCaregiver());

      await service.updateByUserId(USER_ID, {
        jobTypes: ['general_care', ' general_care ', '', '  ', 'overnight'],
      });

      expect(prisma.caregiverJobType.createMany).toHaveBeenCalledWith({
        data: [
          { caregiverId: CAREGIVER_ID, jobType: 'general_care' },
          { caregiverId: CAREGIVER_ID, jobType: 'overnight' },
        ],
      });
    });

    it('updates only the service-area sub-field that is provided', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(fakeCaregiver());

      await service.updateByUserId(USER_ID, {
        serviceArea: { province: 'ภูเก็ต' }, // district omitted → not touched
      });

      expect(prisma.caregiver.update).toHaveBeenCalledWith({
        where: { id: CAREGIVER_ID },
        data: { serviceAreaProvince: 'ภูเก็ต' },
      });
    });

    it('returns the refreshed work condition after saving', async () => {
      // call แรก (select) + call สอง (getByUserId include) คืน fake เดียวกัน
      prisma.caregiver.findUnique.mockResolvedValue(fakeCaregiver());

      const result = await service.updateByUserId(USER_ID, { jobTypes: ['general_care'] });

      expect(result.jobTypes).toEqual(['general_care', 'physiotherapy']);
      expect(result.serviceArea.province).toBe('กรุงเทพมหานคร');
    });
  });

  // ── PYG-592: ตรวจประเภทงานทุกครั้งที่บันทึก ──────────────────────────────

  describe('job type restriction (PYG-592)', () => {
    const { JobTypeNotAllowedError } = jest.requireActual('./job-type/job-type.errors');

    it('เรียกตัวตรวจด้วย tx เดียวกับการเขียน และก่อนเขียนอะไรทั้งสิ้น', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(fakeCaregiver());
      const order: string[] = [];
      eligibility.assertAllowed.mockImplementation(async () => { order.push('assert'); });
      prisma.caregiverAvailability.deleteMany.mockImplementation(async () => { order.push('write'); });

      await service.updateByUserId(USER_ID, {
        availability: [{ dayOfWeek: 1, timeSlot: 'morning' }],
        jobTypes: ['general_care', 'medication'],
      });

      expect(eligibility.assertAllowed).toHaveBeenCalledWith(
        CAREGIVER_ID,
        ['general_care', 'medication'],
        prisma, // tx (mock: prisma ตัวเดิมถูกส่งเป็น tx)
      );
      expect(order).toEqual(['assert', 'write']);
    });

    it('E4: มีรายการไม่ผ่าน -> โยน JOB_TYPE_NOT_ALLOWED และไม่เขียนอะไรเลย (ทุก section)', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(fakeCaregiver());
      eligibility.assertAllowed.mockRejectedValue(
        new JobTypeNotAllowedError([
          { jobType: 'physiotherapy', selectable: false, blockedReason: 'PROFESSION_MISMATCH' },
        ]),
      );

      await expect(
        service.updateByUserId(USER_ID, {
          availability: [{ dayOfWeek: 1, timeSlot: 'morning' }],
          serviceLocations: ['at_home'],
          jobTypes: ['general_care', 'physiotherapy'],
          serviceArea: { province: 'ภูเก็ต' },
        }),
      ).rejects.toMatchObject({ extensions: { code: 'JOB_TYPE_NOT_ALLOWED', statusCode: 422 } });

      expect(prisma.caregiverJobType.deleteMany).not.toHaveBeenCalled();
      expect(prisma.caregiverJobType.createMany).not.toHaveBeenCalled();
      expect(prisma.caregiverAvailability.deleteMany).not.toHaveBeenCalled();
      expect(prisma.caregiverServiceLocation.deleteMany).not.toHaveBeenCalled();
      expect(prisma.caregiver.update).not.toHaveBeenCalled();
    });

    it('ไม่ส่ง jobTypes (แก้ section อื่น) -> ไม่ตรวจประเภทงาน ไม่แตะ caregiver_job_types', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(fakeCaregiver());
      await service.updateByUserId(USER_ID, { serviceArea: { province: 'ภูเก็ต' } });
      expect(eligibility.assertAllowed).not.toHaveBeenCalled();
      expect(prisma.caregiverJobType.deleteMany).not.toHaveBeenCalled();
    });

    it('ตรวจรายการหลัง trim/dedupe เท่านั้น', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(fakeCaregiver());
      await service.updateByUserId(USER_ID, { jobTypes: [' medication ', 'medication', ''] });
      expect(eligibility.assertAllowed).toHaveBeenCalledWith(CAREGIVER_ID, ['medication'], prisma);
    });

    it('สิทธิ์: ผู้ดูแลที่ผ่านตัวตรวจคือคนจาก session (userId) ไม่มีช่องรับ id คนอื่น', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(fakeCaregiver());
      await service.updateByUserId(USER_ID, { jobTypes: ['general_care'] });
      expect(prisma.caregiver.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: USER_ID } }),
      );
      expect(eligibility.assertAllowed.mock.calls[0][0]).toBe(CAREGIVER_ID);
    });

    it('ผู้ดูแลที่ยังไม่ verified ยังถูกปฏิเสธก่อนถึงตัวตรวจ', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(fakeCaregiver({ kycStatus: 'pending' }));
      await expect(service.updateByUserId(USER_ID, { jobTypes: ['general_care'] })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(eligibility.assertAllowed).not.toHaveBeenCalled();
    });
  });

  describe('getJobTypeOptions (myJobTypeOptions)', () => {
    it('คืนตามผู้ใช้ที่ล็อกอิน (userId -> caregiver) และ map เหตุผล', async () => {
      prisma.caregiver.findUnique.mockResolvedValue({ id: CAREGIVER_ID });
      eligibility.evaluateAll.mockResolvedValue([
        { jobType: 'general_care', selectable: true, blockedReason: null },
        { jobType: 'physiotherapy', selectable: false, blockedReason: 'LICENSE_EXPIRED' },
      ]);

      const result = await service.getJobTypeOptions(USER_ID);

      expect(prisma.caregiver.findUnique).toHaveBeenCalledWith({
        where: { userId: USER_ID },
        select: { id: true },
      });
      expect(eligibility.evaluateAll).toHaveBeenCalledWith(CAREGIVER_ID);
      expect(result).toEqual([
        { jobType: 'general_care', selectable: true, blockedReason: null },
        { jobType: 'physiotherapy', selectable: false, blockedReason: 'LICENSE_EXPIRED' },
      ]);
    });

    it('ไม่พบผู้ดูแล -> NotFound', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(null);
      await expect(service.getJobTypeOptions(USER_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
