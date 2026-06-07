import {
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { SavedCaregiversService } from './saved-caregivers.service';
import { PrismaService } from '../common/prisma.service';

// ── Helpers ──────────────────────────────────────────────────────────────────

const PATIENT_ID   = 'patient-111';
const CAREGIVER_ID = 'cg-aaa-1111-1111-1111-111111111111';
const SAVED_ID     = 's1111111-1111-1111-1111-111111111111';
const SAVED_AT     = new Date('2026-06-01T10:00:00Z');

function fakeCaregiverRow(overrides: Record<string, unknown> = {}) {
  return {
    id:                  CAREGIVER_ID,
    fullName:            'สมชาย ใจดี',
    hourlyRate:          350,
    skills:              ['elderly_care'],
    serviceAreaProvince: 'เชียงใหม่',
    serviceAreaDistrict: 'เมือง',
    user:                { avatarUrl: null },
    ...overrides,
  };
}

function fakeSavedRow(overrides: Record<string, unknown> = {}) {
  return {
    id:          SAVED_ID,
    caregiverId: CAREGIVER_ID,
    savedAt:     SAVED_AT,
    caregiver:   fakeCaregiverRow(),
    ...overrides,
  };
}

// ── Setup ────────────────────────────────────────────────────────────────────

describe('SavedCaregiversService', () => {
  let service: SavedCaregiversService;
  let prisma: {
    savedCaregiver: {
      findMany:   jest.Mock;
      findUnique: jest.Mock;
      create:     jest.Mock;
      delete:     jest.Mock;
    };
    caregiver: { findUnique: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      savedCaregiver: {
        findMany:   jest.fn(),
        findUnique: jest.fn(),
        create:     jest.fn(),
        delete:     jest.fn(),
      },
      caregiver: { findUnique: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SavedCaregiversService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<SavedCaregiversService>(SavedCaregiversService);
  });

  // ── list ───────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns saved caregivers for the given patient', async () => {
      prisma.savedCaregiver.findMany.mockResolvedValue([fakeSavedRow()]);

      const result = await service.list(PATIENT_ID);

      expect(prisma.savedCaregiver.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { patientId: PATIENT_ID } }),
      );
      expect(result).toHaveLength(1);
      expect(result[0].caregiverId).toBe(CAREGIVER_ID);
    });

    it('returns empty array when none saved', async () => {
      prisma.savedCaregiver.findMany.mockResolvedValue([]);
      const result = await service.list(PATIENT_ID);
      expect(result).toEqual([]);
    });

    it('maps null hourlyRate to undefined', async () => {
      prisma.savedCaregiver.findMany.mockResolvedValue([
        fakeSavedRow({ caregiver: fakeCaregiverRow({ hourlyRate: null }) }),
      ]);
      const result = await service.list(PATIENT_ID);
      expect(result[0].caregiver.hourlyRate).toBeUndefined();
    });
  });

  // ── save ───────────────────────────────────────────────────────────────────

  describe('save', () => {
    it('saves a caregiver successfully', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(fakeCaregiverRow());
      prisma.savedCaregiver.create.mockResolvedValue({
        id:          SAVED_ID,
        caregiverId: CAREGIVER_ID,
        savedAt:     SAVED_AT,
      });

      const result = await service.save(PATIENT_ID, CAREGIVER_ID);

      expect(prisma.savedCaregiver.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { patientId: PATIENT_ID, caregiverId: CAREGIVER_ID },
        }),
      );
      expect(result.caregiverId).toBe(CAREGIVER_ID);
      expect(result.savedAt).toBe(SAVED_AT);
    });

    it('throws NotFoundException when caregiver does not exist', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(null);
      await expect(service.save(PATIENT_ID, CAREGIVER_ID))
        .rejects.toThrow(NotFoundException);
    });

    it('throws ConflictException on duplicate save (P2002)', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(fakeCaregiverRow());
      prisma.savedCaregiver.create.mockRejectedValue({ code: 'P2002' });

      await expect(service.save(PATIENT_ID, CAREGIVER_ID))
        .rejects.toThrow(ConflictException);
    });

    it('re-throws unknown errors', async () => {
      prisma.caregiver.findUnique.mockResolvedValue(fakeCaregiverRow());
      const unknownErr = new Error('DB connection lost');
      prisma.savedCaregiver.create.mockRejectedValue(unknownErr);

      await expect(service.save(PATIENT_ID, CAREGIVER_ID))
        .rejects.toThrow('DB connection lost');
    });
  });

  // ── unsave ─────────────────────────────────────────────────────────────────

  describe('unsave', () => {
    it('deletes a saved caregiver successfully', async () => {
      prisma.savedCaregiver.findUnique.mockResolvedValue({ id: SAVED_ID });
      prisma.savedCaregiver.delete.mockResolvedValue({});

      await service.unsave(PATIENT_ID, CAREGIVER_ID);

      expect(prisma.savedCaregiver.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { patientId_caregiverId: { patientId: PATIENT_ID, caregiverId: CAREGIVER_ID } },
        }),
      );
    });

    it('throws NotFoundException when saved record does not exist', async () => {
      prisma.savedCaregiver.findUnique.mockResolvedValue(null);
      await expect(service.unsave(PATIENT_ID, CAREGIVER_ID))
        .rejects.toThrow(NotFoundException);
    });
  });
});
