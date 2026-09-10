import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CareRecipientsService } from './care-recipients.service';
import { PrismaService } from '../common/prisma.service';

// ── Helpers ──────────────────────────────────────────────────────────────────

const PATIENT_ID    = 'patient-111';
const OTHER_PATIENT = 'patient-999';
const RECIPIENT_ID  = 'r1111111-1111-1111-1111-111111111111';

/**
 * แถวเปล่าตามรูปทรงที่ RECIPIENT_SELECT ดึงมาจริง
 * PYG-460: ต้องมีคอลัมน์สุขภาพครบ ไม่งั้นเทสต์จะผ่านทั้งที่ mapper อ่านคอลัมน์ที่ไม่มี
 */
function fakeRecipient(overrides: Record<string, unknown> = {}) {
  return {
    id:        RECIPIENT_ID,
    name:      'คุณย่า',
    nickname:  'ย่า',
    patientId: PATIENT_ID,
    date_of_birth:       null,
    gender:              null,
    weight_kg:           null,
    height_cm:           null,
    mobility_level:      null,
    medical_conditions:  [],
    current_medications: null,
    allergies:           null,
    blood_type:          null,
    care_notes:          null,
    preferred_hospital:  null,
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
        expect.objectContaining({
          // PYG-460: โปรไฟล์ที่ soft delete แล้วต้องไม่โผล่ในลิสต์
          where: { patientId: PATIENT_ID, is_deleted: false },
        }),
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

  // ── PYG-460: ข้อมูลสุขภาพ ───────────────────────────────────────────────────

  describe('health profile (PYG-460)', () => {
    it('returns details mapped back to the labels the form uses', async () => {
      prisma.careRecipient.findMany.mockResolvedValue([
        fakeRecipient({
          date_of_birth:       new Date(Date.UTC(new Date().getUTCFullYear() - 72, 0, 1)),
          gender:              'female',
          mobility_level:      'assisted',
          medical_conditions:  ['เบาหวาน', 'ความดันสูง'],
          allergies:           'แพ้ยากลุ่มซัลฟา',
          care_notes:          'เดินต้องมีคนพยุงข้างซ้ายเสมอ',
          blood_type:          'O',
        }),
      ]);

      const [row] = await service.list(PATIENT_ID);

      expect(row.details).toBeDefined();
      expect(row.details!.age).toBe(72);
      expect(row.details!.gender).toBe('หญิง');
      expect(row.details!.supportLevel).toBe('ช่วยเหลือตัวเองได้เล็กน้อย / ต้องการการช่วยพยุงเดิน');
      expect(row.details!.conditions).toEqual(['เบาหวาน', 'ความดันสูง']);
      expect(row.details!.careInstructions).toBe('เดินต้องมีคนพยุงข้างซ้ายเสมอ');
    });

    it('omits details entirely when no health field was ever filled', async () => {
      prisma.careRecipient.findMany.mockResolvedValue([fakeRecipient()]);
      const [row] = await service.list(PATIENT_ID);
      // FE ประกาศ details เป็น optional — ส่ง object เปล่าไปจะทำให้ auto-fill
      // ล้างช่องที่ผู้ใช้กรอกค้างไว้ทิ้งโดยไม่จำเป็น
      expect(row.details).toBeUndefined();
    });

    it('writes health fields to their real columns on create', async () => {
      prisma.careRecipient.create.mockResolvedValue(fakeRecipient());

      await service.create(PATIENT_ID, {
        name:    'คุณย่า',
        details: {
          gender:           'หญิง',
          supportLevel:     'ช่วยเหลือตัวเองไม่ได้ / ติดเตียง',
          allergies:        'แพ้ยากลุ่มซัลฟา',
          careInstructions: 'พลิกตัวทุก 2 ชั่วโมง',
        },
      });

      const call = prisma.careRecipient.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(call.data.gender).toBe('female');
      expect(call.data.mobility_level).toBe('bedridden');
      expect(call.data.allergies).toBe('แพ้ยากลุ่มซัลฟา');
      expect(call.data.care_notes).toBe('พลิกตัวทุก 2 ชั่วโมง');
    });

    it('merges one health field without clearing the rest', async () => {
      prisma.careRecipient.findUnique.mockResolvedValue({ patientId: PATIENT_ID });
      prisma.careRecipient.update.mockResolvedValue(fakeRecipient());

      await service.update(PATIENT_ID, RECIPIENT_ID, { details: { age: 73 } });

      const call = prisma.careRecipient.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(call.data).toHaveProperty('date_of_birth');
      // ช่องที่ไม่ได้ส่งมาต้องไม่ถูกเขียนทับเป็น null
      expect(call.data).not.toHaveProperty('allergies');
      expect(call.data).not.toHaveProperty('mobility_level');
    });
  });

  // ── PYG-460: soft delete ───────────────────────────────────────────────────

  describe('remove', () => {
    it('soft-deletes instead of deleting the row', async () => {
      prisma.careRecipient.findUnique.mockResolvedValue({ patientId: PATIENT_ID, is_deleted: false });
      prisma.careRecipient.update.mockResolvedValue(fakeRecipient());

      await service.remove(PATIENT_ID, RECIPIENT_ID);

      const call = prisma.careRecipient.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(call.data.is_deleted).toBe(true);
      expect(call.data.deleted_at).toBeInstanceOf(Date);
    });

    it('treats an already-deleted profile as not found', async () => {
      prisma.careRecipient.findUnique.mockResolvedValue({ patientId: PATIENT_ID, is_deleted: true });
      await expect(service.remove(PATIENT_ID, RECIPIENT_ID)).rejects.toThrow(NotFoundException);
    });

    it('refuses to delete a profile owned by another patient', async () => {
      prisma.careRecipient.findUnique.mockResolvedValue({ patientId: OTHER_PATIENT, is_deleted: false });
      await expect(service.remove(PATIENT_ID, RECIPIENT_ID)).rejects.toThrow(ForbiddenException);
    });
  });
});
