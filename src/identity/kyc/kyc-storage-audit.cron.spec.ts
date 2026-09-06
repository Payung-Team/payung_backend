/**
 * KycStorageAuditCron — ตรึงว่า invariant check "ทำงานจริง" ไม่ใช่สคริปต์ที่ไม่มีใครรัน
 *
 * repo นี้ยังไม่มี CI เลย งานตรวจจึงต้องอยู่บนเส้นที่รันเองได้ (cron ของแอป)
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../common/prisma.service';
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
  let prisma: { $queryRaw: jest.Mock };
  let errorSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(async () => {
    prisma = { $queryRaw: jest.fn().mockResolvedValue([CLEAN]) };

    const mod: TestingModule = await Test.createTestingModule({
      providers: [KycStorageAuditCron, { provide: PrismaService, useValue: prisma }],
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
});
