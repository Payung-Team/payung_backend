/**
 * AdminService.adminUpdateCaregiverInfo — แอดมินตั้งราคาผู้ดูแล (PYG-534)
 *
 * ★ ตั้งแต่ PYG-534 ผู้ดูแลตั้งราคาเองไม่ได้แล้ว (ดู caregiver-profile-rate.spec.ts)
 *   ทางนี้จึงเป็นทางเดียวที่เหลือ จนกว่า Catalog ราคาของ PYG-487 จะพร้อม
 *   เทสต์ชุดนี้ตรึงว่า:
 *     1. แอดมินส่ง hourlyRate → เขียนลงตารางจริง + คืนค่าใหม่ใน payload
 *     2. เปลี่ยนราคาต้องลง admin_audit_logs พร้อม from/to (เป็นเรื่องเงิน)
 *     3. ไม่ส่ง hourlyRate → ไม่แตะราคาเดิม
 *     4. DTO กันราคาที่ทำให้จ่ายเงินไม่ได้ (null / 0 / ติดลบ)
 *
 * แยกไฟล์จาก admin.service.spec.ts เพราะไฟล์นั้นมีเทสต์ที่แดงอยู่ก่อนแล้ว
 * ผลของชุดนี้จะได้อ่านแยกได้ชัด
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminUpdateCaregiverInfoInput } from './dto/admin-update-caregiver-info.input';
import { PrismaService } from '../common/prisma.service';
import { SupabaseService } from '../common/supabase.service';
import { EmailService } from '../email/email.service';
import { CaregiverService } from '../identity/kyc/caregiver.service';
import { NotificationService } from '../notification/notification.service';
import { PayoutAccountService } from '../payment/payout-account.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { ROLE_ID } from '../common/constants/roles.constant';

const CAREGIVER_ID = '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607';
const LINKED_USER_ID = 'user-cg-1';

const admin: AuthUser = {
  id: 'admin-uuid',
  supabaseUid: 'supabase-admin-uid',
  email: 'admin@payung.app',
  role: ROLE_ID.ADMIN,
  isSuspended: false,
};

/** แถว caregiver เดิม (+ user ที่ผูกอยู่ ตามที่ service include มา) */
const caregiverRow = (hourlyRate: number | null) => ({
  id: CAREGIVER_ID,
  fullName: 'สมศรี ใจดี',
  idCardNumber: '1234567890123',
  hourlyRate,
  user: {
    id: LINKED_USER_ID,
    email: 'cg@payung.app',
    supabaseUid: 'supabase-cg-uid',
  },
});

describe('AdminService.adminUpdateCaregiverInfo — แอดมินตั้งราคาผู้ดูแล (PYG-534)', () => {
  let service: AdminService;
  let prisma: {
    caregiver: { findUnique: jest.Mock; update: jest.Mock };
    user: { findUnique: jest.Mock; update: jest.Mock };
    $executeRaw: jest.Mock;
  };

  /** data ที่ถูกส่งเข้า caregiver.update = สิ่งที่จะถูกเขียนลงตารางจริง */
  const writtenData = (): Record<string, unknown> => {
    const [arg] = prisma.caregiver.update.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    return arg.data;
  };

  /** details (JSON) ที่ถูกเขียนลง admin_audit_logs */
  const auditDetails = (): Record<string, unknown> => {
    const params = (prisma.$executeRaw.mock.calls[0] as unknown[]).slice(1);
    const json = params.find(
      (p): p is string => typeof p === 'string' && p.startsWith('{'),
    );
    return JSON.parse(json as string) as Record<string, unknown>;
  };

  const setup = async (currentRate: number | null) => {
    prisma = {
      caregiver: {
        findUnique: jest.fn().mockResolvedValue(caregiverRow(currentRate)),
        // จำลอง DB: เขียนเฉพาะ key ที่อยู่ใน data ทับแถวเดิม
        update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...caregiverRow(currentRate), ...data }),
        ),
      },
      user: { findUnique: jest.fn(), update: jest.fn() },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: SupabaseService, useValue: {} },
        { provide: CaregiverService, useValue: {} },
        { provide: NotificationService, useValue: {} },
        { provide: EmailService, useValue: {} },
        { provide: PayoutAccountService, useValue: {} },
      ],
    }).compile();

    service = mod.get(AdminService);
    // ปิดเสียง logger.log ในผลเทสต์
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  };

  it('ตั้งราคาให้ผู้ดูแลใหม่ที่ยังไม่มีราคา (null) → เขียนลงตาราง + payload คืนราคาใหม่', async () => {
    await setup(null);

    const result = await service.adminUpdateCaregiverInfo(
      { caregiverId: CAREGIVER_ID, hourlyRate: 250 },
      admin,
    );

    expect(writtenData()).toEqual({ hourlyRate: 250 });
    expect(result.hourlyRate).toBe(250);
  });

  it('เปลี่ยนราคา → ลง admin_audit_logs พร้อม from/to', async () => {
    await setup(200);

    await service.adminUpdateCaregiverInfo(
      { caregiverId: CAREGIVER_ID, hourlyRate: 300 },
      admin,
    );

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const params = (prisma.$executeRaw.mock.calls[0] as unknown[]).slice(1);
    expect(params).toContain(admin.id);
    expect(params).toContain(LINKED_USER_ID);
    expect(auditDetails()).toEqual({ hourlyRate: { from: 200, to: 300 } });
  });

  it('ส่งราคาเดิม → ไม่นับเป็นการเปลี่ยนใน audit', async () => {
    await setup(200);

    await service.adminUpdateCaregiverInfo(
      { caregiverId: CAREGIVER_ID, hourlyRate: 200 },
      admin,
    );

    expect(auditDetails()).not.toHaveProperty('hourlyRate');
  });

  it('แก้ field อื่นโดยไม่ส่ง hourlyRate → ไม่แตะราคาเดิม', async () => {
    await setup(200);

    const result = await service.adminUpdateCaregiverInfo(
      { caregiverId: CAREGIVER_ID, idCardNumber: '9876543210987' },
      admin,
    );

    expect(writtenData()).toEqual({ idCardNumber: '9876543210987' });
    expect(result.hourlyRate).toBe(200);
  });

  it('ผู้ดูแลที่ยังไม่มีราคา → payload คืน hourlyRate ว่าง ไม่ใช่ 0 (0 จะดูเหมือนตั้งไว้ 0 บาท)', async () => {
    await setup(null);

    const result = await service.adminUpdateCaregiverInfo(
      { caregiverId: CAREGIVER_ID, firstName: 'สมใจ' },
      admin,
    );

    expect(result.hourlyRate).toBeUndefined();
  });
});

describe('AdminUpdateCaregiverInfoInput.hourlyRate — กันราคาที่ทำให้จ่ายเงินไม่ได้ (PYG-534)', () => {
  // ตั้งค่าเดียวกับ main.ts ทุกตัว — ถ้า main.ts เปลี่ยน ให้แก้ตรงนี้ตาม
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const validate = (value: Record<string, unknown>) =>
    pipe.transform(
      { caregiverId: CAREGIVER_ID, ...value },
      { type: 'body', metatype: AdminUpdateCaregiverInfoInput },
    ) as Promise<AdminUpdateCaregiverInfoInput>;

  it.each([
    ['ราคาปกติ', 250],
    ['ทศนิยม 2 ตำแหน่ง', 199.5],
  ])('%s (%p) → ผ่าน', async (_label, hourlyRate) => {
    const input = await validate({ hourlyRate });

    expect(input.hourlyRate).toBe(hourlyRate);
  });

  it('ไม่ส่ง hourlyRate เลย → ผ่าน (แก้ field อื่นได้ตามเดิม)', async () => {
    await expect(validate({ firstName: 'สมใจ' })).resolves.toBeInstanceOf(
      AdminUpdateCaregiverInfoInput,
    );
  });

  // payment.service ปฏิเสธราคา <= 0 (422) → ต้องกันตั้งแต่ตอนตั้งราคา ไม่ใช่ไปพังตอนผู้รับบริการจ่ายเงิน
  // ตรวจข้อความด้วย ไม่ใช่แค่ "throw" — ต้องโดนกันเพราะกติการาคา
  // ไม่ใช่เพราะ DTO ไม่รู้จัก field นี้ (ซึ่งก็ throw เหมือนกัน แต่แปลว่าแอดมินตั้งราคาไม่ได้เลย)
  it.each([
    ['0 บาท', 0, 'ค่าบริการต้องมากกว่า 0 บาท'],
    ['ติดลบ', -100, 'ค่าบริการต้องมากกว่า 0 บาท'],
    [
      'null (ล้างราคา)',
      null,
      'ค่าบริการต้องเป็นตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง',
    ],
    [
      'ทศนิยมเกิน 2 ตำแหน่ง',
      250.555,
      'ค่าบริการต้องเป็นตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง',
    ],
  ])('%s → 400', async (_label, hourlyRate, expectedMessage) => {
    const error = await validate({ hourlyRate }).then(
      () => {
        throw new Error('ควรถูกปฏิเสธ แต่ผ่าน validation');
      },
      (e: BadRequestException) => e,
    );

    expect(error).toBeInstanceOf(BadRequestException);
    const { message } = error.getResponse() as { message: string[] };
    expect(message).toContain(expectedMessage);
  });
});
