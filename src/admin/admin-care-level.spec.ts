/**
 * PYG-581 — แอดมินกำหนด/แก้ระดับผู้ดูแล + บังคับมีระดับก่อนอนุมัติ KYC (story PYG-557 · contract PYG-579)
 *
 * ครอบคลุม Definition of Done ของการ์ด: E1, E2, E4, E9 + เคสสิทธิ์ (ที่ระดับ service)
 * และเพิ่ม: E3 (ยืนยันค่าเริ่มต้นจาก migration), E6 (สองแอดมินแก้ต่อกัน — ประวัติครบ ค่าเดิมถูก),
 * การ rollback เมื่อ throw ในทรานแซคชัน, ประวัติใหม่ไปเก่า + source ของแต่ละแถว
 *
 * ── ฐานข้อมูลปลอม (FakeDb) ────────────────────────────────────────────────
 *   จำลองเฉพาะแถว caregivers หนึ่งแถว + ตารางประวัติ + kyc_reviews ในหน่วยความจำ
 *   $transaction ถ่ายสำเนาก่อนเริ่ม แล้วคืนค่าเดิมเมื่อ throw = จำลอง ROLLBACK
 *   → เทสต์ตรวจ "ผลที่ค้างอยู่ใน DB" ได้จริง (เช่น E1: kyc_status ต้องยังเป็น pending)
 *   ⚠ ไม่ได้จำลองการรอล็อกของ Postgres — E6 ทดสอบแบบ "ต่อกัน" ซึ่งคือผลที่ FOR UPDATE รับประกัน
 *     (ยังไม่ได้รันกับ Postgres จริง — ดูรายงานใน contract PYG-579 §8)
 *
 * แยกไฟล์จาก admin.service.spec.ts เพื่อให้ผลของการ์ดนี้อ่านแยกได้ชัด
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminCareLevelService } from './admin-care-level.service';
import {
  CARE_LEVEL_LOG_REASON,
  toCareLevelChange,
  toCareLevelInfo,
} from './admin-care-level.helpers';
import { CareLevelChangeSource } from './dto/care-level.dto';
import { PrismaService } from '../common/prisma.service';
import { SupabaseService } from '../common/supabase.service';
import { EmailService } from '../email/email.service';
import { CaregiverService } from '../identity/kyc/caregiver.service';
import { NotificationService } from '../notification/notification.service';
import { PayoutAccountService } from '../payment/payout-account.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { ROLE_ID } from '../common/constants/roles.constant';
import { CareLevel } from '../common/care-level/care-level';
import { DrivingLicenseService } from '../identity/kyc/driving-license/driving-license.service';
import {
  CARE_LEVEL_ERROR,
  CareLevelError,
} from '../common/care-level/care-level.errors';

const CAREGIVER_ID = '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607';

const adminA: AuthUser = {
  id: 'admin-a',
  supabaseUid: 'sb-admin-a',
  email: 'a@payung.app',
  role: ROLE_ID.ADMIN,
  isSuspended: false,
};
const adminB: AuthUser = {
  ...adminA,
  id: 'admin-b',
  supabaseUid: 'sb-admin-b',
  email: 'b@payung.app',
};

const DISPLAY_NAMES: Record<string, string> = {
  'admin-a': 'แอดมิน A',
  'admin-b': 'แอดมิน B',
};

// ─── Fake DB ──────────────────────────────────────────────────────────────

interface CaregiverState {
  kyc_status: string;
  care_level: string | null;
  care_level_set_by: string | null;
  care_level_set_at: Date | null;
  kyc_verified_at: Date | null;
}

interface LogRow {
  id: string;
  caregiver_id: string;
  old_level: string | null;
  new_level: string;
  changed_by: string | null;
  reason: string | null;
  created_at: Date;
}

class FakeDb {
  row: CaregiverState | null;
  logs: LogRow[] = [];
  reviews: Array<{ action: string; reviewerId: string }> = [];
  /** นาฬิกาของ DB — เดินหน้าทีละวินาทีทุกครั้งที่ถาม clock_timestamp() */
  private clock = Date.parse('2026-10-18T03:00:00.000Z');

  constructor(initial: Partial<CaregiverState> | null) {
    this.row = initial
      ? {
          kyc_status: 'verified',
          care_level: null,
          care_level_set_by: null,
          care_level_set_at: null,
          kyc_verified_at: null,
          ...initial,
        }
      : null;
  }

  /** รูปแถวแบบที่ Prisma คืน (ชื่อ field แบบ camelCase) — มี field ครบพอให้ mapToCaregiver ใช้ได้ */
  prismaRow() {
    const r = this.row!;
    return {
      id: CAREGIVER_ID,
      userId: 'user-cg-1',
      caregiverNumber: 'CG-0001',
      fullName: 'สมศรี ใจดี',
      idCardNumber: '1234567890123',
      gender: null,
      dateOfBirth: null,
      address: null,
      phone: '0812345678',
      skills: [],
      experienceYears: 2,
      hourlyRate: 150,
      bio: null,
      kycStatus: r.kyc_status,
      kycSubmittedAt: new Date('2026-10-01'),
      kycVerifiedAt: r.kyc_verified_at,
      isSearchable: false,
      languages: [],
      resubmitCount: 0,
      createdAt: new Date('2026-09-01'),
      updatedAt: new Date('2026-10-01'),
      rejection_reasons: null,
      profession: 'general_caregiver', // PYG-575: แถวจริงมีค่านี้เสมอ (DEFAULT ใน DB)
      careLevel: r.care_level,
      careLevelSetBy: r.care_level_set_by,
      careLevelSetAt: r.care_level_set_at,
      careLevelSetByUser: r.care_level_set_by
        ? { displayName: DISPLAY_NAMES[r.care_level_set_by] ?? null }
        : null,
      user: { email: 'cg@payung.app' },
    };
  }

  /** เขียน data แบบ Prisma ลงแถว — รองรับเฉพาะคอลัมน์ที่โค้ดของการ์ดนี้เขียน */
  private applyUpdate(data: Record<string, unknown>) {
    const r = this.row!;
    if ('careLevel' in data) r.care_level = data.careLevel as string;
    if ('careLevelSetBy' in data)
      r.care_level_set_by = data.careLevelSetBy as string;
    if ('careLevelSetAt' in data)
      r.care_level_set_at = data.careLevelSetAt as Date;
    if ('kycStatus' in data) r.kyc_status = data.kycStatus as string;
    if ('kycVerifiedAt' in data)
      r.kyc_verified_at = data.kycVerifiedAt as Date | null;
  }

  readonly $queryRaw = jest.fn((strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    if (sql.includes('FOR UPDATE')) {
      return Promise.resolve(
        this.row
          ? [
              {
                id: CAREGIVER_ID,
                kyc_status: this.row.kyc_status,
                care_level: this.row.care_level,
                care_level_set_by: this.row.care_level_set_by,
              },
            ]
          : [],
      );
    }
    if (sql.includes('clock_timestamp')) {
      this.clock += 1000;
      return Promise.resolve([{ now: new Date(this.clock) }]);
    }
    return Promise.reject(new Error(`FakeDb: SQL ที่ไม่ได้จำลองไว้: ${sql}`));
  });

  /** client ที่ส่งเข้า callback ของ $transaction */
  readonly tx = {
    $queryRaw: this.$queryRaw,
    caregiver: {
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        this.applyUpdate(data);
        return Promise.resolve(this.prismaRow());
      }),
    },
    caregiver_care_level_logs: {
      create: jest.fn(({ data }: { data: Omit<LogRow, 'id'> }) => {
        this.logs.push({ id: `log-${this.logs.length + 1}`, ...data });
        return Promise.resolve({});
      }),
    },
    kycReview: {
      create: jest.fn(
        ({ data }: { data: { action: string; reviewerId: string } }) => {
          this.reviews.push({
            action: data.action,
            reviewerId: data.reviewerId,
          });
          return Promise.resolve({});
        },
      ),
    },
  };

  /** PrismaService ปลอม */
  readonly prisma = {
    $queryRaw: this.$queryRaw,
    $transaction: jest.fn(
      async (fn: (tx: FakeDb['tx']) => Promise<unknown>) => {
        // ถ่ายสำเนาก่อนเริ่ม → throw เมื่อไร คืนค่าเดิมทั้งหมด (= ROLLBACK)
        const snapshot = {
          row: this.row ? { ...this.row } : null,
          logs: [...this.logs],
          reviews: [...this.reviews],
        };
        try {
          return await fn(this.tx);
        } catch (err) {
          this.row = snapshot.row;
          this.logs = snapshot.logs;
          this.reviews = snapshot.reviews;
          throw err;
        }
      },
    ),
    caregiver: {
      findUnique: jest.fn(() =>
        Promise.resolve(this.row ? this.prismaRow() : null),
      ),
      update: this.tx.caregiver.update,
    },
    caregiver_care_level_logs: {
      findMany: jest.fn(() =>
        Promise.resolve(
          // จำลอง ORDER BY created_at DESC
          [...this.logs]
            .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
            .map((l) => ({
              ...l,
              users: l.changed_by
                ? { displayName: DISPLAY_NAMES[l.changed_by] ?? null }
                : null,
            })),
        ),
      ),
    },
  };
}

/** รอ promise ที่ควร reject แล้วคืน error ออกมาให้ตรวจ extensions ต่อ */
async function rejectionOf(promise: Promise<unknown>): Promise<CareLevelError> {
  try {
    await promise;
  } catch (err) {
    return err as CareLevelError;
  }
  throw new Error('expected promise to reject');
}

// ═════════════════════════════════════════════════════════════════════════
// setCaregiverCareLevel — แก้ระดับหลังอนุมัติ
// ═════════════════════════════════════════════════════════════════════════

describe('AdminCareLevelService.setCaregiverCareLevel (PYG-581 · S02-AC4)', () => {
  let db: FakeDb;
  let service: AdminCareLevelService;

  const setup = async (initial: Partial<CaregiverState> | null) => {
    db = new FakeDb(initial);
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        AdminCareLevelService,
        { provide: PrismaService, useValue: db.prisma },
      ],
    }).compile();
    service = mod.get(AdminCareLevelService);
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  };

  it('เปลี่ยนระดับ → เขียนระดับ + ผู้กำหนด (จากผู้ล็อกอิน) + เวลา + แถวประวัติ ในทรานแซคชันเดียว (AC3, AC4)', async () => {
    await setup({
      care_level: 'basic',
      care_level_set_by: 'admin-b',
      care_level_set_at: new Date('2026-10-10'),
    });

    const result = await service.setCaregiverCareLevel(
      {
        caregiverId: CAREGIVER_ID,
        level: 'ADVANCED',
        reason: '  ผ่านอบรมพยาบาลแล้ว  ',
      },
      adminA,
    );

    expect(result.changed).toBe(true);
    expect(result.careLevel).toEqual({
      caregiverId: CAREGIVER_ID,
      level: CareLevel.ADVANCED,
      setBy: 'admin-a',
      setByName: 'แอดมิน A',
      setAt: new Date('2026-10-18T03:00:01.000Z'),
      needsReview: false,
    });
    expect(db.logs).toEqual([
      {
        id: 'log-1',
        caregiver_id: CAREGIVER_ID,
        old_level: 'basic',
        new_level: 'advanced',
        changed_by: 'admin-a',
        reason: 'ผ่านอบรมพยาบาลแล้ว', // trim แล้ว
        created_at: new Date('2026-10-18T03:00:01.000Z'), // เวลาเดียวกับ care_level_set_at
      },
    ]);
    // ล็อกแถวก่อนอ่านค่าเดิม (E6)
    expect(db.$queryRaw.mock.calls[0][0].join('?')).toContain('FOR UPDATE');
    expect(db.prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('E4: ส่งค่าเดิมที่แอดมินกำหนดไว้แล้ว → changed=false ไม่เพิ่มประวัติ ไม่เปลี่ยนผู้กำหนด/เวลา ไม่ต้องมีเหตุผล', async () => {
    const setAt = new Date('2026-10-10T00:00:00.000Z');
    await setup({
      care_level: 'intermediate',
      care_level_set_by: 'admin-b',
      care_level_set_at: setAt,
    });

    const result = await service.setCaregiverCareLevel(
      { caregiverId: CAREGIVER_ID, level: 'INTERMEDIATE' }, // ไม่มี reason
      adminA,
    );

    expect(result.changed).toBe(false);
    expect(result.careLevel).toMatchObject({
      setBy: 'admin-b',
      setByName: 'แอดมิน B',
      setAt,
    });
    expect(db.logs).toEqual([]);
    expect(db.tx.caregiver.update).not.toHaveBeenCalled();
  });

  it('E3/AC6: ยืนยันค่าเริ่มต้นจาก migration (ค่าเดิม แต่ยังไม่มีผู้กำหนด) → นับเป็นการทบทวน: บันทึกผู้กำหนด + ประวัติ old = new', async () => {
    await setup({
      care_level: 'basic',
      care_level_set_by: null,
      care_level_set_at: new Date('2026-10-07'),
    });

    const result = await service.setCaregiverCareLevel(
      {
        caregiverId: CAREGIVER_ID,
        level: 'BASIC',
        reason: 'ทบทวนแล้ว ระดับต้นถูกต้อง',
      },
      adminA,
    );

    expect(result.changed).toBe(true);
    expect(result.careLevel.needsReview).toBe(false);
    expect(result.careLevel.setBy).toBe('admin-a');
    expect(db.logs).toHaveLength(1);
    expect(db.logs[0]).toMatchObject({
      old_level: 'basic',
      new_level: 'basic',
      changed_by: 'admin-a',
    });
  });

  it('E3/AC6: ยืนยันค่าเริ่มต้นก็ต้องมีเหตุผล', async () => {
    await setup({ care_level: 'basic', care_level_set_by: null });

    const err = await rejectionOf(
      service.setCaregiverCareLevel(
        { caregiverId: CAREGIVER_ID, level: 'BASIC' },
        adminA,
      ),
    );

    expect(err.extensions.code).toBe(CARE_LEVEL_ERROR.REASON_REQUIRED);
    expect(db.row!.care_level_set_by).toBeNull();
  });

  it('ผู้ดูแลที่อนุมัติแล้วแต่ยังไม่มีระดับ (อนุมัติก่อน PYG-581 ขึ้น) → กำหนดระดับแรกได้ old_level = null', async () => {
    await setup({ care_level: null });

    await service.setCaregiverCareLevel(
      {
        caregiverId: CAREGIVER_ID,
        level: 'INTERMEDIATE',
        reason: 'กำหนดย้อนหลัง',
      },
      adminA,
    );

    expect(db.row!.care_level).toBe('intermediate');
    expect(db.logs[0]).toMatchObject({
      old_level: null,
      new_level: 'intermediate',
    });
  });

  it.each([undefined, '', '   '])(
    'เปลี่ยนระดับโดยเหตุผล = %p → CARE_LEVEL_REASON_REQUIRED และไม่มีอะไรถูกเขียน',
    async (reason) => {
      await setup({ care_level: 'basic', care_level_set_by: 'admin-b' });

      const err = await rejectionOf(
        service.setCaregiverCareLevel(
          { caregiverId: CAREGIVER_ID, level: 'ADVANCED', reason },
          adminA,
        ),
      );

      expect(err.extensions.code).toBe(CARE_LEVEL_ERROR.REASON_REQUIRED);
      expect(db.row!.care_level).toBe('basic');
      expect(db.logs).toEqual([]);
    },
  );

  it('E9: ค่านอกรายการ → CARE_LEVEL_INVALID ก่อนแตะ DB (ไม่เปิดทรานแซคชันเลย)', async () => {
    await setup({ care_level: 'basic', care_level_set_by: 'admin-b' });

    const err = await rejectionOf(
      service.setCaregiverCareLevel(
        { caregiverId: CAREGIVER_ID, level: 'EXPERT', reason: 'x' },
        adminA,
      ),
    );

    expect(err.extensions).toMatchObject({
      code: CARE_LEVEL_ERROR.INVALID,
      received: 'EXPERT',
    });
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ไม่ส่งระดับ → CARE_LEVEL_REQUIRED ก่อนแตะ DB', async () => {
    await setup({ care_level: 'basic', care_level_set_by: 'admin-b' });

    const err = await rejectionOf(
      service.setCaregiverCareLevel(
        { caregiverId: CAREGIVER_ID, level: null, reason: 'x' },
        adminA,
      ),
    );

    expect(err.extensions.code).toBe(CARE_LEVEL_ERROR.REQUIRED);
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(['pending', 'rejected', 'none', 'reject'])(
    'R7: KYC = %s → CARE_LEVEL_KYC_NOT_VERIFIED (ระดับแรกต้องเลือกตอนอนุมัติ)',
    async (kycStatus) => {
      await setup({ kyc_status: kycStatus });

      const err = await rejectionOf(
        service.setCaregiverCareLevel(
          { caregiverId: CAREGIVER_ID, level: 'BASIC', reason: 'x' },
          adminA,
        ),
      );

      expect(err.extensions).toEqual({
        code: CARE_LEVEL_ERROR.KYC_NOT_VERIFIED,
        kycStatus,
      });
      expect(db.row!.care_level).toBeNull();
    },
  );

  it('ไม่พบผู้ดูแล → NotFoundException', async () => {
    await setup(null);

    await expect(
      service.setCaregiverCareLevel(
        { caregiverId: CAREGIVER_ID, level: 'BASIC', reason: 'x' },
        adminA,
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('E6: แอดมินสองคนแก้ต่อกัน → ค่าล่าสุดชนะ ประวัติครบ 2 แถว และ old_level ของแต่ละแถวถูกต้อง', async () => {
    await setup({ care_level: 'basic', care_level_set_by: 'admin-a' });

    await service.setCaregiverCareLevel(
      {
        caregiverId: CAREGIVER_ID,
        level: 'INTERMEDIATE',
        reason: 'A: ประเมินใหม่',
      },
      adminA,
    );
    await service.setCaregiverCareLevel(
      {
        caregiverId: CAREGIVER_ID,
        level: 'ADVANCED',
        reason: 'B: มีใบประกอบฯ',
      },
      adminB,
    );

    expect(db.row).toMatchObject({
      care_level: 'advanced',
      care_level_set_by: 'admin-b',
    });
    expect(
      db.logs.map((l) => [l.old_level, l.new_level, l.changed_by]),
    ).toEqual([
      ['basic', 'intermediate', 'admin-a'],
      ['intermediate', 'advanced', 'admin-b'], // ค่าเดิม = ค่าที่ A เพิ่งเขียน ไม่ใช่ 'basic'
    ]);
    // เวลาของแถวหลังต้องมาทีหลังเสมอ (clock_timestamp หลังได้ล็อก)
    expect(db.logs[1].created_at.getTime()).toBeGreaterThan(
      db.logs[0].created_at.getTime(),
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════
// ประวัติ + ข้อมูลระดับปัจจุบัน
// ═════════════════════════════════════════════════════════════════════════

describe('AdminCareLevelService — ประวัติและข้อมูลระดับ (S02-AC3, AC4)', () => {
  let db: FakeDb;
  let service: AdminCareLevelService;

  beforeEach(async () => {
    db = new FakeDb({
      care_level: 'basic',
      care_level_set_by: null,
      care_level_set_at: new Date('2026-10-07'),
    });
    const mod = await Test.createTestingModule({
      providers: [
        AdminCareLevelService,
        { provide: PrismaService, useValue: db.prisma },
      ],
    }).compile();
    service = mod.get(AdminCareLevelService);
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  });

  it('ประวัติเรียงใหม่ไปเก่า พร้อม source / ชื่อผู้เปลี่ยน — แถวของระบบไม่ส่ง reason ภายในออกไป', async () => {
    db.logs.push(
      {
        id: 'log-m',
        caregiver_id: CAREGIVER_ID,
        old_level: null,
        new_level: 'basic',
        changed_by: null,
        reason: CARE_LEVEL_LOG_REASON.MIGRATION_DEFAULT,
        created_at: new Date('2026-10-07T03:57:48Z'),
      },
      {
        id: 'log-u',
        caregiver_id: CAREGIVER_ID,
        old_level: 'basic',
        new_level: 'advanced',
        changed_by: 'admin-b',
        reason: 'มีใบประกอบฯ',
        created_at: new Date('2026-10-12T00:00:00Z'),
      },
    );

    const history = await service.careLevelHistory(CAREGIVER_ID);

    expect(history).toEqual([
      {
        id: 'log-u',
        oldLevel: CareLevel.BASIC,
        newLevel: CareLevel.ADVANCED,
        changedBy: 'admin-b',
        changedByName: 'แอดมิน B',
        reason: 'มีใบประกอบฯ',
        source: CareLevelChangeSource.ADMIN_UPDATE,
        createdAt: new Date('2026-10-12T00:00:00Z'),
      },
      {
        id: 'log-m',
        oldLevel: null,
        newLevel: CareLevel.BASIC,
        changedBy: null, // backfill ไม่มีผู้กำหนด — ส่ง null ไม่แทนด้วยผู้ใช้สมมติ
        changedByName: null,
        reason: null,
        source: CareLevelChangeSource.MIGRATION_DEFAULT,
        createdAt: new Date('2026-10-07T03:57:48Z'),
      },
    ]);
  });

  it('ผู้ดูแลที่ยังไม่มีประวัติ → [] · ไม่พบผู้ดูแล → NotFoundException', async () => {
    await expect(service.careLevelHistory(CAREGIVER_ID)).resolves.toEqual([]);

    db.row = null;
    await expect(service.careLevelHistory(CAREGIVER_ID)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('getCareLevelInfo: ค่าเริ่มต้นจาก migration → needsReview = true, setBy = null (E3)', async () => {
    await expect(service.getCareLevelInfo(CAREGIVER_ID)).resolves.toEqual({
      caregiverId: CAREGIVER_ID,
      level: CareLevel.BASIC,
      setBy: null,
      setByName: null,
      setAt: new Date('2026-10-07'),
      needsReview: true,
    });
  });
});

describe('toCareLevelInfo / toCareLevelChange', () => {
  it('ยังไม่มีระดับ → level null และ needsReview = false (E5 — ไม่ใช่ "รอทบทวน")', () => {
    expect(
      toCareLevelInfo({
        id: 'x',
        careLevel: null,
        careLevelSetBy: null,
        careLevelSetAt: null,
      }),
    ).toEqual({
      caregiverId: 'x',
      level: null,
      setBy: null,
      setByName: null,
      setAt: null,
      needsReview: false,
    });
  });

  it('แถวที่เขียนตอนอนุมัติ KYC → source KYC_APPROVAL และ reason = null', () => {
    const change = toCareLevelChange({
      id: 'l1',
      old_level: null,
      new_level: 'intermediate',
      changed_by: 'admin-a',
      reason: CARE_LEVEL_LOG_REASON.KYC_APPROVAL,
      created_at: new Date('2026-10-18'),
      users: { displayName: 'แอดมิน A' },
    });

    expect(change).toMatchObject({
      source: CareLevelChangeSource.KYC_APPROVAL,
      reason: null,
      changedByName: 'แอดมิน A',
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// approveKyc / rejectKyc — บังคับมีระดับก่อนอนุมัติ
// ═════════════════════════════════════════════════════════════════════════

describe('AdminService.approveKyc — ต้องมีระดับก่อนอนุมัติ (PYG-581 · S02-AC1, AC2)', () => {
  let db: FakeDb;
  let service: AdminService;
  const notificationService = {
    create: jest.fn().mockResolvedValue(undefined),
  };
  const emailService = {
    sendKycVerified: jest.fn().mockResolvedValue(undefined),
    sendKycRejected: jest.fn().mockResolvedValue(undefined),
  };
  const payoutAccountService = {
    createRecipientForCaregiver: jest.fn().mockResolvedValue(undefined),
  };

  const setup = async (initial: Partial<CaregiverState> | null) => {
    jest.clearAllMocks();
    db = new FakeDb(initial);
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: PrismaService, useValue: db.prisma },
        { provide: SupabaseService, useValue: {} },
        { provide: CaregiverService, useValue: {} },
        { provide: NotificationService, useValue: notificationService },
        { provide: EmailService, useValue: emailService },
        { provide: PayoutAccountService, useValue: payoutAccountService },
        // PYG-597 (#132): AdminService ต้องใช้ DrivingLicenseService — approveKyc ไม่ได้เรียก
        { provide: DrivingLicenseService, useValue: {} },
      ],
    }).compile();
    service = mod.get(AdminService);
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  };

  it('AC1: เลือกระดับมาพร้อมอนุมัติ → ระดับ + ผู้กำหนด + ประวัติ + verified ในทรานแซคชันเดียว', async () => {
    await setup({ kyc_status: 'pending' });

    const result = await service.approveKyc(
      CAREGIVER_ID,
      adminA,
      'INTERMEDIATE',
    );

    expect(result.kycStatus).toBe('verified');
    expect(result.careLevel).toBe(CareLevel.INTERMEDIATE); // ค่าที่คืนออกไปมีระดับใหม่แล้ว
    expect(db.row).toMatchObject({
      kyc_status: 'verified',
      care_level: 'intermediate',
      care_level_set_by: 'admin-a', // ผู้กำหนด = แอดมินที่ล็อกอิน
    });
    expect(db.row!.care_level_set_at).toEqual(
      new Date('2026-10-18T03:00:01.000Z'),
    );
    expect(db.logs).toEqual([
      expect.objectContaining({
        old_level: null,
        new_level: 'intermediate',
        changed_by: 'admin-a',
        reason: CARE_LEVEL_LOG_REASON.KYC_APPROVAL,
      }),
    ]);
    expect(db.reviews).toEqual([{ action: 'approved', reviewerId: 'admin-a' }]);
    expect(db.prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, ''])(
    'E1: ไม่ได้เลือกระดับ (%p) และผู้ดูแลยังไม่มีระดับ → CARE_LEVEL_REQUIRED และ kyc_status ยังเป็น pending',
    async (careLevel) => {
      await setup({ kyc_status: 'pending' });

      const err = await rejectionOf(
        service.approveKyc(CAREGIVER_ID, adminA, careLevel),
      );

      expect(err).toBeInstanceOf(CareLevelError);
      expect(err.extensions.code).toBe(CARE_LEVEL_ERROR.REQUIRED);
      expect(db.row).toMatchObject({ kyc_status: 'pending', care_level: null });
      expect(db.reviews).toEqual([]);
      expect(db.logs).toEqual([]);
      expect(notificationService.create).not.toHaveBeenCalled();
    },
  );

  it('E1 (ทางเข้า race): ระหว่างรอล็อก ระดับหายไป → throw ในทรานแซคชัน → rollback ทั้งก้อน', async () => {
    // จำลอง: ตอนอ่านครั้งแรกมีระดับ แต่แถวที่ล็อกได้ไม่มีระดับแล้ว
    await setup({
      kyc_status: 'pending',
      care_level: 'basic',
      care_level_set_by: 'admin-b',
    });
    db.prisma.caregiver.findUnique.mockImplementationOnce(() =>
      Promise.resolve(db.prismaRow()),
    );
    db.$queryRaw.mockImplementationOnce(() =>
      Promise.resolve([
        {
          id: CAREGIVER_ID,
          kyc_status: 'pending',
          care_level: null,
          care_level_set_by: null,
        },
      ]),
    );

    const err = await rejectionOf(
      service.approveKyc(CAREGIVER_ID, adminA, undefined),
    );

    expect(err.extensions.code).toBe(CARE_LEVEL_ERROR.REQUIRED);
    expect(db.row!.kyc_status).toBe('pending');
    expect(db.reviews).toEqual([]);
  });

  it('E9: ค่านอกรายการ → CARE_LEVEL_INVALID ก่อนแตะ DB', async () => {
    await setup({ kyc_status: 'pending' });

    const err = await rejectionOf(
      service.approveKyc(CAREGIVER_ID, adminA, 'EXPERT'),
    );

    expect(err.extensions).toMatchObject({
      code: CARE_LEVEL_ERROR.INVALID,
      received: 'EXPERT',
    });
    expect(db.prisma.caregiver.findUnique).not.toHaveBeenCalled();
    expect(db.row!.kyc_status).toBe('pending');
  });

  it('ไม่ส่งระดับ แต่ผู้ดูแลมีระดับอยู่แล้ว (เช่นถูกส่งกลับมาตรวจซ้ำ · E8) → อนุมัติได้ คงระดับเดิม ไม่เพิ่มประวัติ', async () => {
    await setup({
      kyc_status: 'pending',
      care_level: 'advanced',
      care_level_set_by: 'admin-b',
    });

    const result = await service.approveKyc(CAREGIVER_ID, adminA, undefined);

    expect(result.kycStatus).toBe('verified');
    expect(result.careLevel).toBe(CareLevel.ADVANCED);
    expect(db.row!.care_level_set_by).toBe('admin-b');
    expect(db.logs).toEqual([]);
  });

  it('E4: ส่งค่าเดิมที่มีอยู่แล้ว → ไม่เขียนประวัติซ้ำ ไม่เปลี่ยนผู้กำหนด', async () => {
    await setup({
      kyc_status: 'pending',
      care_level: 'basic',
      care_level_set_by: 'admin-b',
    });

    await service.approveKyc(CAREGIVER_ID, adminA, 'BASIC');

    expect(db.logs).toEqual([]);
    expect(db.row!.care_level_set_by).toBe('admin-b');
    expect(db.row!.kyc_status).toBe('verified');
  });

  it('สถานะเปลี่ยนระหว่างรอล็อก (อีกคนเพิ่งอนุมัติไป) → ConflictException ไม่เขียนอะไรซ้ำ', async () => {
    await setup({ kyc_status: 'pending' });
    db.$queryRaw.mockImplementationOnce(() =>
      Promise.resolve([
        {
          id: CAREGIVER_ID,
          kyc_status: 'verified',
          care_level: 'basic',
          care_level_set_by: 'admin-b',
        },
      ]),
    );

    await expect(
      service.approveKyc(CAREGIVER_ID, adminA, 'ADVANCED'),
    ).rejects.toThrow(ConflictException);
    expect(db.logs).toEqual([]);
    expect(db.reviews).toEqual([]);
  });

  it('ผู้ดูแลที่อนุมัติไปแล้ว → ConflictException เหมือนเดิม (เช็คสถานะก่อนเรื่องระดับ)', async () => {
    await setup({ kyc_status: 'verified' });

    await expect(
      service.approveKyc(CAREGIVER_ID, adminA, undefined),
    ).rejects.toThrow(ConflictException);
  });

  it('E2: ปฏิเสธ KYC ได้โดยไม่ต้องมีระดับ และไม่แตะระดับ', async () => {
    await setup({ kyc_status: 'pending' });

    const result = await service.rejectKyc(
      { caregiverId: CAREGIVER_ID, reasons: [{ title: 'รูปบัตรไม่ชัด' }] },
      adminA,
    );

    expect(result.kycStatus).toBe('rejected');
    expect(db.row!.care_level).toBeNull();
    expect(db.logs).toEqual([]);
  });
});

describe('AdminService.adminKycList — ระดับในหน้ารายการ (E3)', () => {
  it('ส่ง careLevel + careLevelNeedsReview ของแต่ละแถว', async () => {
    const row = (
      id: string,
      careLevel: string | null,
      careLevelSetBy: string | null,
    ) => ({
      id,
      caregiverNumber: null,
      fullName: id,
      kycStatus: 'verified',
      kycSubmittedAt: new Date('2026-10-01'),
      createdAt: new Date('2026-09-01'),
      careLevel,
      careLevelSetBy,
      user: { email: `${id}@x.com` },
      _count: { documents: 2 },
    });
    const prisma = {
      caregiver: {
        count: jest.fn().mockResolvedValue(3),
        findMany: jest
          .fn()
          .mockResolvedValue([
            row('migrated', 'basic', null),
            row('reviewed', 'advanced', 'admin-a'),
            row('no-level', null, null),
          ]),
      },
    };
    const mod = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: SupabaseService, useValue: {} },
        { provide: CaregiverService, useValue: {} },
        { provide: NotificationService, useValue: {} },
        { provide: EmailService, useValue: {} },
        { provide: PayoutAccountService, useValue: {} },
        { provide: DrivingLicenseService, useValue: {} }, // PYG-597 (#132) — adminKycList ไม่ได้เรียก
      ],
    }).compile();
    const service = mod.get(AdminService);
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);

    const result = await service.adminKycList({ page: 1, limit: 20 } as never);

    expect(
      result.items.map((i) => [
        i.fullName,
        i.careLevel ?? null,
        i.careLevelNeedsReview,
      ]),
    ).toEqual([
      ['migrated', CareLevel.BASIC, true],
      ['reviewed', CareLevel.ADVANCED, false],
      ['no-level', null, false],
    ]);
  });
});
