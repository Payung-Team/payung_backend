import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CareRecipientsService } from './care-recipients.service';
import { PrismaService } from '../common/prisma.service';

// ── Helpers ──────────────────────────────────────────────────────────────────

const PATIENT_ID    = 'patient-111';
const OTHER_PATIENT = 'patient-999';
const RECIPIENT_ID  = 'r1111111-1111-1111-1111-111111111111';

function fakeRecipient(overrides: Record<string, unknown> = {}) {
  return {
    id:        RECIPIENT_ID,
    name:      'คุณย่า',
    nickname:  'ย่า',
    patientId: PATIENT_ID,
    ...overrides,
  };
}

// ── Setup ────────────────────────────────────────────────────────────────────

describe('CareRecipientsService', () => {
  let service: CareRecipientsService;
  let prisma: {
    careRecipient: {
      findMany:  jest.Mock;
      create:    jest.Mock;
      findUnique: jest.Mock;
      update:    jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      careRecipient: {
        findMany:   jest.fn(),
        create:     jest.fn(),
        findUnique: jest.fn(),
        update:     jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CareRecipientsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<CareRecipientsService>(CareRecipientsService);
  });

  // ── list ───────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns care recipients for the given patient', async () => {
      prisma.careRecipient.findMany.mockResolvedValue([fakeRecipient()]);

      const result = await service.list(PATIENT_ID);

      expect(prisma.careRecipient.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { patientId: PATIENT_ID } }),
      );
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('คุณย่า');
    });

    it('returns empty array when no recipients', async () => {
      prisma.careRecipient.findMany.mockResolvedValue([]);
      const result = await service.list(PATIENT_ID);
      expect(result).toEqual([]);
    });

    it('maps null nickname to undefined', async () => {
      prisma.careRecipient.findMany.mockResolvedValue([
        fakeRecipient({ nickname: null }),
      ]);
      const result = await service.list(PATIENT_ID);
      expect(result[0].nickname).toBeUndefined();
    });
  });

  // ── create ─────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates a care recipient', async () => {
      prisma.careRecipient.create.mockResolvedValue(fakeRecipient());

      const result = await service.create(PATIENT_ID, { name: 'คุณย่า', nickname: 'ย่า' });

      expect(prisma.careRecipient.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ patientId: PATIENT_ID, name: 'คุณย่า' }),
        }),
      );
      expect(result.id).toBe(RECIPIENT_ID);
    });

    it('creates without nickname', async () => {
      prisma.careRecipient.create.mockResolvedValue(fakeRecipient({ nickname: null }));
      const result = await service.create(PATIENT_ID, { name: 'คุณตา' });
      expect(result.nickname).toBeUndefined();
    });
  });

  // ── update ─────────────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates name successfully', async () => {
      prisma.careRecipient.findUnique.mockResolvedValue({ patientId: PATIENT_ID });
      prisma.careRecipient.update.mockResolvedValue(fakeRecipient({ name: 'คุณตา' }));

      const result = await service.update(PATIENT_ID, RECIPIENT_ID, { name: 'คุณตา' });
      expect(result.name).toBe('คุณตา');
    });

    it('updates only provided fields (partial update)', async () => {
      prisma.careRecipient.findUnique.mockResolvedValue({ patientId: PATIENT_ID });
      prisma.careRecipient.update.mockResolvedValue(fakeRecipient({ nickname: 'ย่าแก่' }));

      await service.update(PATIENT_ID, RECIPIENT_ID, { nickname: 'ย่าแก่' });

      // Should not include `name` in the update data (undefined → excluded)
      const call = prisma.careRecipient.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(call.data).not.toHaveProperty('name');
      expect(call.data).toHaveProperty('nickname', 'ย่าแก่');
    });

    it('throws NotFoundException when recipient does not exist', async () => {
      prisma.careRecipient.findUnique.mockResolvedValue(null);
      await expect(service.update(PATIENT_ID, RECIPIENT_ID, { name: 'X' }))
        .rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when recipient belongs to another patient', async () => {
      prisma.careRecipient.findUnique.mockResolvedValue({ patientId: OTHER_PATIENT });
      await expect(service.update(PATIENT_ID, RECIPIENT_ID, { name: 'X' }))
        .rejects.toThrow(ForbiddenException);
    });
  });
});
