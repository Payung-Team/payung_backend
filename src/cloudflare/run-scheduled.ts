import type { INestApplication, Type } from '@nestjs/common';
import { ContextIdFactory } from '@nestjs/core';
import { AdminCleanupService } from '../admin/admin-cleanup.service';
import { UserCleanupService } from '../admin/user-cleanup.service';
import { BookingExpiryService } from '../booking/booking-expiry.service';
import { KycStorageAuditCron } from '../identity/kyc/kyc-storage-audit.cron';
import { JobTypeRemovalNotifier } from '../identity/kyc/job-type/job-type-removal-notifier';
import { LicenseExpiryCron } from '../identity/kyc/license/license-expiry.cron';
import { NoCheckoutSweeperService } from '../monitoring/no-checkout-sweeper.service';
import { PaymentCronService } from '../payment/payment-cron.service';
import { PayoutAccountService } from '../payment/payout-account.service';
import { PayoutReaperService } from '../payout/payout-reaper.service';
import { PayoutWorkerService } from '../payout/payout-worker.service';
import { ReconciliationCron } from '../reconciliation/reconciliation.cron';
import { PrismaService } from '../common/prisma.service';

type ResolveCronService = <T>(token: Type<T>) => Promise<T>;

async function runTask(
  name: string,
  task: () => Promise<unknown>,
  failures: Error[],
): Promise<void> {
  try {
    await task();
  } catch (error) {
    console.error(`[cloudflare-cron] ${name} failed`, error);
    failures.push(
      error instanceof Error ? error : new Error(`${name}: ${String(error)}`),
    );
  }
}

async function dispatchScheduledTasks(
  resolve: ResolveCronService,
  cron: string,
  scheduledTime: number,
  failures: Error[],
): Promise<void> {
  const scheduled = new Date(scheduledTime);
  const minute = scheduled.getUTCMinutes();
  const hour = scheduled.getUTCHours();

  if (cron === '*/10 * * * *') {
    await runTask(
      'payout-worker',
      async () => (await resolve(PayoutWorkerService)).run(),
      failures,
    );
    await runTask(
      'payout-reaper',
      async () => (await resolve(PayoutReaperService)).run(),
      failures,
    );
    await runTask(
      'payout-recipient-sync',
      () =>
        resolve(PayoutAccountService).then((service) =>
          service.syncPendingRecipients(),
        ),
      failures,
    );

    if (minute === 0) {
      await runTask(
        'promptpay-reconciliation',
        () =>
          resolve(PaymentCronService).then((service) =>
            service.reconcileAbandonedPromptPay(),
          ),
        failures,
      );
    }
    if (minute === 10) {
      await runTask(
        'job-type-removal-notifier',
        () => resolve(JobTypeRemovalNotifier).then((service) => service.run()),
        failures,
      );
    }
    return;
  }

  if (cron === '5,15,35,45 * * * *') {
    if (minute === 5 || minute === 35) {
      await runTask(
        'no-checkout-sweeper',
        () =>
          resolve(NoCheckoutSweeperService).then((service) => service.run()),
        failures,
      );
    }
    if (minute === 15 || minute === 45) {
      await runTask(
        'booking-expiry',
        () => resolve(BookingExpiryService).then((service) => service.run()),
        failures,
      );
    }
    return;
  }

  if (cron === '0 0,1,2,3 * * *') {
    if (hour === 0) {
      await runTask(
        'admin-cleanup',
        () =>
          resolve(AdminCleanupService).then((service) =>
            service.handleAdminCleanup(),
          ),
        failures,
      );
      await runTask(
        'user-cleanup',
        () =>
          resolve(UserCleanupService).then((service) =>
            service.handleUserCleanup(),
          ),
        failures,
      );
    } else if (hour === 1) {
      await runTask(
        'hold-refresh',
        () =>
          resolve(PaymentCronService).then((service) =>
            service.refreshExpiringHolds(),
          ),
        failures,
      );
    } else if (hour === 2) {
      await runTask(
        'expired-holds',
        () =>
          resolve(PaymentCronService).then((service) =>
            service.handleExpiredHolds(),
          ),
        failures,
      );
    } else if (hour === 3) {
      await runTask(
        'payment-reconciliation',
        () => resolve(ReconciliationCron).then((service) => service.run()),
        failures,
      );
      await runTask(
        'idempotency-prune',
        () =>
          resolve(PaymentCronService).then((service) =>
            service.pruneIdempotencyKeys(),
          ),
        failures,
      );
    }
    return;
  }

  if (cron === '30 4 * * *') {
    await runTask(
      'kyc-storage-audit',
      () => resolve(KycStorageAuditCron).then((service) => service.run()),
      failures,
    );
    return;
  }

  if (cron === '5 17 * * *') {
    await runTask(
      'license-expiry',
      () => resolve(LicenseExpiryCron).then((service) => service.run()),
      failures,
    );
  }
}

export async function runScheduledTasks(
  app: INestApplication,
  cron: string,
  scheduledTime: number,
): Promise<void> {
  const contextId = ContextIdFactory.create();
  app.registerRequestByContextId(
    { type: 'scheduled', cron, scheduledTime },
    contextId,
  );

  const resolve: ResolveCronService = <T>(token: Type<T>) =>
    app.resolve(token, contextId, { strict: false });
  const prisma = await resolve(PrismaService);
  const failures: Error[] = [];

  try {
    await dispatchScheduledTasks(resolve, cron, scheduledTime, failures);
  } finally {
    await prisma.onModuleDestroy();
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `[cloudflare-cron] ${failures.length} task(s) failed for ${cron}`,
    );
  }
}
