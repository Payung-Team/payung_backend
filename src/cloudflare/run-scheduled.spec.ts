import type { INestApplication } from '@nestjs/common';
import { KycStorageAuditCron } from '../identity/kyc/kyc-storage-audit.cron';
import { PrismaService } from '../common/prisma.service';
import { runScheduledTasks } from './run-scheduled';

describe('runScheduledTasks', () => {
  function makeApp(run: jest.Mock) {
    const prisma = { onModuleDestroy: jest.fn().mockResolvedValue(undefined) };
    const registerRequestByContextId = jest.fn();
    const resolve = jest.fn().mockImplementation((token: unknown) => {
      if (token === PrismaService) return Promise.resolve(prisma);
      if (token === KycStorageAuditCron) return Promise.resolve({ run });
      throw new Error(`Unexpected cron token: ${String(token)}`);
    });

    return {
      app: {
        resolve,
        registerRequestByContextId,
      } as unknown as INestApplication,
      prisma,
      registerRequestByContextId,
      resolve,
    };
  }

  it('resolves scheduled services in one Nest request context and releases Prisma', async () => {
    const run = jest.fn().mockResolvedValue(undefined);
    const { app, prisma, registerRequestByContextId, resolve } = makeApp(run);

    await runScheduledTasks(app, '30 4 * * *', Date.UTC(2026, 9, 21, 4, 30));

    expect(registerRequestByContextId).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(PrismaService, expect.anything(), {
      strict: false,
    });
    expect(resolve).toHaveBeenCalledWith(
      KycStorageAuditCron,
      expect.anything(),
      { strict: false },
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(prisma.onModuleDestroy).toHaveBeenCalledTimes(1);
  });

  it('reports task failures after releasing Prisma', async () => {
    const failure = new Error('audit failed');
    const run = jest.fn().mockRejectedValue(failure);
    const { app, prisma } = makeApp(run);

    await expect(
      runScheduledTasks(app, '30 4 * * *', Date.UTC(2026, 9, 21, 4, 30)),
    ).rejects.toMatchObject({
      message: '[cloudflare-cron] 1 task(s) failed for 30 4 * * *',
      errors: [failure],
    });
    expect(prisma.onModuleDestroy).toHaveBeenCalledTimes(1);
  });
});
