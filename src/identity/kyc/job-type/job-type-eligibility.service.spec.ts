/**
 * JobTypeEligibilityService — อ่านข้อมูลจริงจาก DB (mock) + ปฏิเสธทั้งคำขอ (PYG-592: E4, E6, E5)
 */
import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { JobTypeEligibilityService } from './job-type-eligibility.service';
import { PrismaService } from '../../../common/prisma.service';
import { ClockService } from '../../../common/clock.service';

const NOW = new Date('2026-10-18T03:00:00Z');
const FUTURE = new Date('2027-12-31T16:59:59.999Z');
const UPLOADED = new Date('2026-09-01T00:00:00Z');

describe('JobTypeEligibilityService', () => {
  let service: JobTypeEligibilityService;
  let caregiverFindUnique: jest.Mock;
  let docFindMany: jest.Mock;

  const setCaregiver = (profession: string) =>
    caregiverFindUnique.mockResolvedValue({ profession, userId: 'user-1' });
  const setLicense = (reviewStatus: string | null, expiresAt: Date | null = FUTURE) =>
    docFindMany.mockResolvedValue([{ reviewStatus, expiresAt, uploadedAt: UPLOADED }]);

  beforeEach(async () => {
    caregiverFindUnique = jest.fn();
    docFindMany = jest.fn().mockResolvedValue([]);
    const mod = await Test.createTestingModule({
      providers: [
        JobTypeEligibilityService,
        {
          provide: PrismaService,
          useValue: { caregiver: { findUnique: caregiverFindUnique }, kycDocument: { findMany: docFindMany } },
        },
        { provide: ClockService, useValue: { now: () => NOW } },
      ],
    }).compile();
    service = mod.get(JobTypeEligibilityService);
  });

  it('อ่านวิชาชีพจาก caregivers.profession และใบประกอบฯ ชนิด professional_license ทั้งทาง caregiver_id และ user_id', async () => {
    setCaregiver('physiotherapist');
    await service.evaluateAll('cg-1');
    expect(caregiverFindUnique).toHaveBeenCalledWith({
      where: { id: 'cg-1' },
      select: { profession: true, userId: true },
    });
    expect(docFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          documentType: 'professional_license',
          OR: [{ caregiverId: 'cg-1' }, { userId: 'user-1' }],
        },
      }),
    );
  });

  it('evaluateAll ส่งครบ 5 ประเภทเสมอ รวมที่เลือกไม่ได้', async () => {
    setCaregiver('general_caregiver');
    const all = await service.evaluateAll('cg-1');
    expect(all.map((a) => a.jobType)).toEqual([
      'general_care',
      'bedridden_care',
      'companion',
      'medication',
      'physiotherapy',
    ]);
    expect(all.find((a) => a.jobType === 'physiotherapy')).toMatchObject({
      selectable: false,
      blockedReason: 'PROFESSION_MISMATCH',
    });
    expect(all.filter((a) => a.selectable)).toHaveLength(4);
  });

  it('ผู้ดูแลไม่พบ -> 404', async () => {
    caregiverFindUnique.mockResolvedValue(null);
    await expect(service.evaluateAll('x')).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('assertAllowed', () => {
    it('ทุกรายการผ่าน -> ไม่ throw', async () => {
      setCaregiver('physiotherapist');
      setLicense('approved');
      await expect(
        service.assertAllowed('cg-1', ['physiotherapy', 'medication', 'general_care']),
      ).resolves.toBeUndefined();
    });

    it('E6: พยาบาลเลือก physiotherapy -> JOB_TYPE_NOT_ALLOWED 422 + PROFESSION_MISMATCH', async () => {
      setCaregiver('nurse');
      await expect(service.assertAllowed('cg-1', ['physiotherapy'])).rejects.toMatchObject({
        extensions: {
          code: 'JOB_TYPE_NOT_ALLOWED',
          statusCode: 422,
          blocked: [{ jobType: 'physiotherapy', blockedReason: 'PROFESSION_MISMATCH' }],
        },
      });
    });

    it('E6: ผู้ดูแลทั่วไปเลือก physiotherapy -> PROFESSION_MISMATCH', async () => {
      setCaregiver('general_caregiver');
      await expect(service.assertAllowed('cg-1', ['physiotherapy'])).rejects.toMatchObject({
        extensions: { blocked: [{ jobType: 'physiotherapy', blockedReason: 'PROFESSION_MISMATCH' }] },
      });
    });

    it.each([
      ['ไม่มีใบ', [], 'LICENSE_NOT_APPROVED'],
      ['ใบรอตรวจ', [{ reviewStatus: 'pending', expiresAt: FUTURE, uploadedAt: UPLOADED }], 'LICENSE_NOT_APPROVED'],
      ['ใบถูกปฏิเสธ', [{ reviewStatus: 'rejected', expiresAt: FUTURE, uploadedAt: UPLOADED }], 'LICENSE_NOT_APPROVED'],
      [
        'ใบ approved แต่ถึงวันหมดอายุแล้ว (งานรายวันยังไม่รัน)',
        [{ reviewStatus: 'approved', expiresAt: new Date('2026-10-01T00:00:00Z'), uploadedAt: UPLOADED }],
        'LICENSE_EXPIRED',
      ],
    ])('วิชาชีพตรง %s -> %s', async (_n, docs, reason) => {
      setCaregiver('physiotherapist');
      docFindMany.mockResolvedValue(docs);
      await expect(service.assertAllowed('cg-1', ['physiotherapy'])).rejects.toMatchObject({
        extensions: { blocked: [{ jobType: 'physiotherapy', blockedReason: reason }] },
      });
    });

    it('E4: มีทั้งรายการผ่านและไม่ผ่าน -> ปฏิเสธทั้งคำขอ และ blocked ระบุเฉพาะรายการที่ไม่ผ่าน', async () => {
      setCaregiver('nurse');
      const err = await service
        .assertAllowed('cg-1', ['general_care', 'medication', 'physiotherapy'])
        .catch((e) => e);
      expect(err.extensions.code).toBe('JOB_TYPE_NOT_ALLOWED');
      expect(err.extensions.blocked).toEqual([
        { jobType: 'physiotherapy', blockedReason: 'PROFESSION_MISMATCH' },
      ]);
      expect(err.message).toContain('physiotherapy');
    });

    it('medication ผ่านเสมอแม้เป็นผู้ดูแลทั่วไปที่ไม่มีใบประกอบฯ', async () => {
      setCaregiver('general_caregiver');
      await expect(service.assertAllowed('cg-1', ['medication'])).resolves.toBeUndefined();
    });

    it('รายการว่าง (ล้างทั้งหมด) ผ่าน และไม่ต้อง query ใบประกอบฯ', async () => {
      setCaregiver('general_caregiver');
      await expect(service.assertAllowed('cg-1', [])).resolves.toBeUndefined();
      expect(docFindMany).not.toHaveBeenCalled();
    });

    it('ใช้ client ที่ส่งมา (tx) แทน prisma ตัวหลัก', async () => {
      const tx = {
        caregiver: { findUnique: jest.fn().mockResolvedValue({ profession: 'nurse', userId: 'u' }) },
        kycDocument: { findMany: jest.fn().mockResolvedValue([]) },
      };
      await service.assertAllowed('cg-1', ['general_care'], tx as never);
      expect(tx.caregiver.findUnique).toHaveBeenCalled();
      expect(caregiverFindUnique).not.toHaveBeenCalled();
    });
  });
});
