/**
 * repair-stuck-payments (PYG-309/375) — one-off data-repair for payments stuck `pending` > 24h.
 *
 * For each stuck row it asks Omise the TRUTH (retrieveCharge) and proposes a fix:
 *   paid=true   → captured   (webhook was lost — money is really ours)
 *   paid=false  → expired    (charge dead / abandoned)
 *   not found   → failed     (charge never existed / gone)
 *   no chargeId → failed
 *
 * ⚠️ DRY-RUN BY DEFAULT. It prints the proposed changes and writes NOTHING.
 *    A human reviews the output, then re-runs with `--apply` to execute for real.
 *    Never runs the backfill without a dry-run first.
 *
 * Usage:
 *   npx ts-node src/payment/scripts/repair-stuck-payments.ts            # dry-run (safe)
 *   npx ts-node src/payment/scripts/repair-stuck-payments.ts --apply    # execute (after review)
 *   STUCK_HOURS=48 npx ts-node ... --apply
 *
 * Transitions go through PaymentStateMachine (never a bare UPDATE). Every change is logged.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../../app.module';
import { PrismaService } from '../../common/prisma.service';
import { OmiseService } from '../omise/omise.service';
import { PaymentStateMachine } from '../payment-state-machine';
import { PaymentStatus } from '../entities/payment-status.enum';

type Plan = {
  paymentId: string;
  bookingId: string;
  omiseChargeId: string | null;
  from: string;
  to: PaymentStatus;
  reason: string;
};

async function main() {
  const apply = process.argv.includes('--apply');
  const stuckHours = Number(process.env.STUCK_HOURS ?? 24);
  const log = new Logger('RepairStuckPayments');
  // human-facing output via console.* so it is NEVER suppressed by the Nest logger level
  const out = (m: string) => process.stdout.write(m + '\n');

  // Money-safety: without Omise creds every retrieveCharge fails → every row would be
  // misclassified as `failed`. Refuse to run (dry-run OR apply) so no one reviews/acts on
  // a bogus plan. Run this in an environment that has OMISE_SECRET_KEY (staging/prod).
  if (!process.env.OMISE_SECRET_KEY) {
    out(
      '✋ OMISE_SECRET_KEY is not set — aborting. retrieveCharge cannot verify charges, so the ' +
        'plan would misclassify every row. Run this where Omise credentials are configured.',
    );
    process.exit(2);
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const prisma = app.get(PrismaService);
  const omise = app.get(OmiseService);
  const fsm = app.get(PaymentStateMachine);

  const cutoff = new Date(Date.now() - stuckHours * 60 * 60 * 1000);
  const stuck = await prisma.payment.findMany({
    where: { paymentStatus: PaymentStatus.pending, createdAt: { lt: cutoff } },
  });

  out(`Found ${stuck.length} payment(s) stuck 'pending' > ${stuckHours}h`);
  out(apply ? '⚠️  APPLY MODE — changes WILL be written' : '🔎 DRY-RUN — nothing will change');

  const plans: Plan[] = [];
  for (const p of stuck) {
    let to = PaymentStatus.failed;
    let reason = 'no omiseChargeId — cannot verify';
    if (p.omiseChargeId) {
      try {
        const charge = await omise.retrieveCharge(p.omiseChargeId);
        if (charge.paid) {
          to = PaymentStatus.captured;
          reason = 'Omise says paid (webhook lost) → captured';
        } else {
          to = PaymentStatus.expired;
          reason = charge.expiresAt
            ? `Omise not paid, expires_at=${charge.expiresAt} → expired`
            : 'Omise not paid → expired';
        }
      } catch {
        to = PaymentStatus.failed;
        reason = 'Omise charge not found → failed';
      }
    }
    plans.push({
      paymentId: p.id,
      bookingId: p.bookingId,
      omiseChargeId: p.omiseChargeId,
      from: p.paymentStatus,
      to,
      reason,
    });
  }

  // print the plan (this is the dry-run output a human reviews)
  for (const plan of plans) {
    out(
      `payment=${plan.paymentId} booking=${plan.bookingId} ${plan.from} → ${plan.to}  (${plan.reason})`,
    );
  }

  if (!apply) {
    out(`DRY-RUN complete: ${plans.length} row(s) WOULD change. Re-run with --apply to execute.`);
    await app.close();
    return;
  }

  let changed = 0;
  for (const plan of plans) {
    try {
      await fsm.transition(plan.paymentId, plan.to, {
        reason: `[repair] ${plan.reason}`,
        metadata: { repairedAt: new Date().toISOString(), omiseChargeId: plan.omiseChargeId },
      });
      changed += 1;
      out(`✔ repaired payment=${plan.paymentId} → ${plan.to}`);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      log.error(`x failed payment=${plan.paymentId}: ${m}`);
    }
  }
  out(`APPLY complete: ${changed}/${plans.length} row(s) changed`);
  await app.close();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
