import type { INestApplication } from '@nestjs/common';
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

async function runTask(name: string, task: () => Promise<unknown>): Promise<void> {
  try {
    await task();
  } catch (error) {
    console.error(`[cloudflare-cron] ${name} failed`, error);
  }
}

export async function runScheduledTasks(
  app: INestApplication,
  cron: string,
  scheduledTime: number,
): Promise<void> {
  const scheduled = new Date(scheduledTime);
  const minute = scheduled.getUTCMinutes();
  const hour = scheduled.getUTCHours();

  if (cron === '*/10 * * * *') {
    await runTask('payout-worker', () => app.get(PayoutWorkerService).run());
    await runTask('payout-reaper', () => app.get(PayoutReaperService).run());
    await runTask('payout-recipient-sync', () =>
      app.get(PayoutAccountService).syncPendingRecipients(),
    );

    if (minute === 0) {
      await runTask('promptpay-reconciliation', () =>
        app.get(PaymentCronService).reconcileAbandonedPromptPay(),
      );
    }
    if (minute === 10) {
      await runTask('job-type-removal-notifier', () =>
        app.get(JobTypeRemovalNotifier).run(),
      );
    }
    return;
  }

  if (cron === '5,15,35,45 * * * *') {
    if (minute === 5 || minute === 35) {
      await runTask('no-checkout-sweeper', () =>
        app.get(NoCheckoutSweeperService).run(),
      );
    }
    if (minute === 15 || minute === 45) {
      await runTask('booking-expiry', () => app.get(BookingExpiryService).run());
    }
    return;
  }

  if (cron === '0 0,1,2,3 * * *') {
    if (hour === 0) {
      await runTask('admin-cleanup', () =>
        app.get(AdminCleanupService).handleAdminCleanup(),
      );
      await runTask('user-cleanup', () =>
        app.get(UserCleanupService).handleUserCleanup(),
      );
    } else if (hour === 1) {
      await runTask('hold-refresh', () =>
        app.get(PaymentCronService).refreshExpiringHolds(),
      );
    } else if (hour === 2) {
      await runTask('expired-holds', () =>
        app.get(PaymentCronService).handleExpiredHolds(),
      );
    } else if (hour === 3) {
      await runTask('payment-reconciliation', () =>
        app.get(ReconciliationCron).run(),
      );
      await runTask('idempotency-prune', () =>
        app.get(PaymentCronService).pruneIdempotencyKeys(),
      );
    }
    return;
  }

  if (cron === '30 4 * * *') {
    await runTask('kyc-storage-audit', () => app.get(KycStorageAuditCron).run());
    return;
  }

  if (cron === '5 17 * * *') {
    await runTask('license-expiry', () => app.get(LicenseExpiryCron).run());
  }
}
