/**
 * KycStorageAuditCron — ตรึงว่า invariant check "ทำงานจริง" ไม่ใช่สคริปต์ที่ไม่มีใครรัน
 *
 * repo นี้ยังไม่มี CI เลย งานตรวจจึงต้องอยู่บนเส้นที่รันเองได้ (cron ของแอป)
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../common/prisma.service';
import { NotificationService } from '../../notification/notification.service';
import { NotificationType } from '../../notification/entities/notification-type.enum';
import { ROLE_ID } from '../../common/constants/roles.constant';
import { KycStorageAuditCron } from './kyc-storage-audit.cron';

const CLEAN = {
  full_urls: 0n,
  traversal: 0n,
  leading_slash: 0n,
  no_folder: 0n,
  cross_user: 0n,
};

describe('KycStorageAuditCron', () => {
  let cron: KycStorageAuditCron;
  let prisma: { $queryRaw: jest.Mock; user: { findMany: jest.Mock } };
  let notifications: { create: jest.Mock };
  let errorSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(async () => {
    prisma = {
      $queryRaw: jest.fn().mockResolvedValue([CLEAN]),
      user: {
        findMany: jest.fn().mockResolvedValue([{ id: 'sa-1' }, { id: 'sa-2' }]),
      },
    };
    notifications = { create: jest.fn().mockResolvedValue({}) };

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        KycStorageAuditCron,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationService, useValue: notifications },
      ],
    }).compile();

    cron = mod.get(KycStorageAuditCron);
    errorSpy = jest.spyOn(cron['logger'], 'error').mockImplementation();
    logSpy = jest.spyOn(cron['logger'], 'log').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('ข้อมูลสะอาด → log ปกติ ไม่ error', async () => {
    await cron.run();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('invariant ครบถ้วน'));
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('เจอแถวชี้ข้ามคน → log ERROR พร้อมคำเตือนเฉพาะของ cross_user', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ ...CLEAN, cross_user: 3n }]);

    await cron.run();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const msg = errorSpy.mock.calls[0][0] as string;
    expect(msg).toContain('cross_user=3');
    expect(msg).toContain('ตรวจสอบด่วน');
  });

  it('เจอ URL เต็มหลุดกลับมา → log ERROR (แต่ไม่ใช่คำเตือน cross_user)', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ ...CLEAN, full_urls: 2n }]);

    await cron.run();

    const msg = errorSpy.mock.calls[0][0] as string;
    expect(msg).toContain('full_urls=2');
    expect(msg).not.toContain('ตรวจสอบด่วน');
  });

  it('ยกเว้นแถว fixture ออกจากการนับ (ไม่งั้นเตือนทุกวันเรื่องที่รู้อยู่แล้ว)', async () => {
    await cron.check();

    const params = prisma.$queryRaw.mock.calls[0].slice(1);
    expect(params).toContain('87d7fa1c-caf2-4de5-ac0c-e4315a5c76b8');
  });

  it('query พัง → log ERROR ไม่ throw ออกจาก cron (ตรวจไม่ได้ ≠ ไม่มีปัญหา)', async () => {
    prisma.$queryRaw.mockRejectedValueOnce(new Error('db down'));

    await expect(cron.run()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('ตรวจ invariant ไม่สำเร็จ'));
  });

  it('query ไม่คืนแถว → ถือว่าสะอาด ไม่ระเบิด', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([]);

    await expect(cron.run()).resolves.toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  // ── เส้นแจ้งเตือนที่มีคนเห็นจริง ─────────────────────────────────────────
  // log ERROR ตอนตีสี่ครึ่งที่ไม่มีใครเปิดอ่าน = สคริปต์ที่ไม่มีใครรัน แบบเดิม
  describe('แจ้งเตือน super admin', () => {
    it('cross_user > 0 → ส่ง notification ให้ super admin ทุกคน', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ ...CLEAN, cross_user: 2n }]);

      await cron.run();

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { role: ROLE_ID.SUPER_ADMIN, isActive: true, is_deleted: false },
        }),
      );
      expect(notifications.create).toHaveBeenCalledTimes(2);

      const [userId, type, title, body, data] = notifications.create.mock.calls[0];
      expect(userId).toBe('sa-1');
      expect(type).toBe(NotificationType.security_alert);
      expect(title).toContain('ชี้ไปบัญชีผู้ใช้รายอื่น');
      expect(body).toContain('2 เอกสาร');
      // bigint ต้องถูกแปลงเป็น number ไม่งั้น JSON.stringify ระเบิด
      expect(data).toMatchObject({ crossUser: 2, source: 'KycStorageAuditCron' });
      expect(() => JSON.stringify(data)).not.toThrow();
    });

    it('ผิดรูปแบบแต่ไม่ข้ามคน → ยังแจ้ง แต่ใช้ข้อความที่ไม่ใช่ระดับด่วน', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ ...CLEAN, full_urls: 3n }]);

      await cron.run();

      const [, , title, body] = notifications.create.mock.calls[0];
      expect(title).toContain('ผิดปกติของเส้นทางไฟล์');
      expect(body).toContain('url เต็ม 3');
    });

    it('ส่งให้คนหนึ่งไม่สำเร็จ → คนที่เหลือยังได้รับ (ไม่ล้มทั้งรอบ)', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ ...CLEAN, cross_user: 1n }]);
      notifications.create.mockRejectedValueOnce(new Error('notify down'));

      await expect(cron.run()).resolves.toBeUndefined();

      expect(notifications.create).toHaveBeenCalledTimes(2);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('ส่งแจ้งเตือนให้ super admin sa-1 ไม่สำเร็จ'),
      );
    });

    it('ไม่มี super admin ที่ active → log ERROR ว่าไม่มีใครได้รับแจ้ง', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ ...CLEAN, cross_user: 1n }]);
      prisma.user.findMany.mockResolvedValueOnce([]);

      await cron.run();

      expect(notifications.create).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('ไม่มีใครได้รับแจ้งเตือน'),
      );
    });
  });
});
