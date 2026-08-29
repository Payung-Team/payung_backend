/**
 * PYG-375 STEP 2 — repair-stuck-payments (DRY-RUN BY DEFAULT)
 *
 * Repairs the backlog of `payments` stuck at `pending` by asking Omise the TRUTH for each row
 * (retrieveCharge — a GET) and reconciling our DB status to match. It NEVER moves money and
 * NEVER writes on an Omise non-answer. See repair-stuck-payments.core.ts for the decision table.
 *
 *   dry-run (default): read + print + write plan CSV. ZERO DB writes.
 *   --apply          : per row, tx + SELECT…FOR UPDATE + re-check pending, then FSM transition.
 *
 * ⚠ --apply is Sam's to run in an Omise-credentialed env. It refuses without OMISE_SECRET_KEY.
 *
 * Usage:
 *   ts-node src/payment/scripts/repair-stuck-payments.ts \
 *     [--apply] [--older-than-hours=24] [--booking=<uuid>] [--limit=N] [--out=<path>]
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { writeFileSync } from 'fs';
import { Prisma } from '@prisma/client';
import { AppModule } from '../../app.module';
import { PrismaService } from '../../common/prisma.service';
import { ClockService } from '../../common/clock.service';
import { OmiseService } from '../omise/omise.service';
import { PaymentStateMachine } from '../payment-state-machine';
import { PaymentStatus } from '../entities/payment-status.enum';
import {
  planRow,
  toCsv,
  summarize,
  RepairBucket,
  type StuckPayment,
  type ChargeOutcome,
  type PlanRow,
} from './repair-stuck-payments.core';

const OMISE_BATCH_SIZE = 20;
const OMISE_BATCH_PAUSE_MS = 1000;
const OMISE_CALL_TIMEOUT_MS = 10000;
const REPAIR_ACTOR = 'system:pyg-375-repair';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
}
const out = (m: string) => process.stdout.write(m + '\n');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`omise timeout ${ms}ms`)), ms),
    ),
  ]);
}

/**
 * Ask Omise about one charge (GET only), collapsing to a decision outcome.
 * ⚠ retrieveCharge throws a single generic Error for 404 / 5xx / network / timeout and cannot
 * distinguish them. To honour the invariant "never write on a non-answer", EVERY throw becomes
 * `unreachable` (→ skip). A genuine 404 therefore stays pending+skipped rather than risk a wrong
 * `failed` write on a network blip. Only a NULL charge id yields `failed` (unambiguous). See PR:
 * a follow-up adding 404 discrimination to OmiseService lets fetched-404 safely → failed.
 */
async function fetchOutcome(omise: OmiseService, chargeId: string): Promise<ChargeOutcome> {
  try {
    const c = await withTimeout(omise.retrieveCharge(chargeId), OMISE_CALL_TIMEOUT_MS);
    return { kind: 'ok', paid: c.paid, authorized: c.authorized, amountSatang: c.amount };
  } catch {
    return { kind: 'unreachable' };
  }
}

async function main() {
  const log = new Logger('RepairStuckPayments');
  const apply = process.argv.includes('--apply');
  const olderThanHours = Number(arg('older-than-hours') ?? 24);
  const bookingFilter = arg('booking');
  const limit = arg('limit') ? Number(arg('limit')) : undefined;
  const outPath = arg('out') ?? `./repair-plan-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;

  // §3.2 — --apply must refuse without an Omise key (fail fast, before any work).
  // dry-run keyless is allowed but every row will be unreachable→skip (safe, but not useful);
  // we warn loudly. (This refines PR #20's abort-both: now unreachable→skip, so a keyless
  // dry-run can no longer misclassify anything.)
  if (apply && !process.env.OMISE_SECRET_KEY) {
    out('✋ --apply refused: OMISE_SECRET_KEY not set. Run --apply in an Omise-credentialed env.');
    process.exit(2);
  }
  if (!apply && !process.env.OMISE_SECRET_KEY) {
    out('⚠ No OMISE_SECRET_KEY — every charge will be UNREACHABLE→skip. This plan is not usable;');
    out('  run the dry-run in an Omise env for a real plan. Continuing to show the (empty-ish) plan…');
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const prisma = app.get(PrismaService);
  const omise = app.get(OmiseService);
  const fsm = app.get(PaymentStateMachine);
  const clock = app.get(ClockService);

  try {
    const cutoff = new Date(clock.now().getTime() - olderThanHours * 60 * 60 * 1000);
    const stuck = (await prisma.payment.findMany({
      where: {
        paymentStatus: PaymentStatus.pending,
        createdAt: { lt: cutoff },
        ...(bookingFilter ? { bookingId: bookingFilter } : {}),
      },
      select: {
        id: true,
        bookingId: true,
        paymentMethod: true,
        amount: true,
        omiseChargeId: true,
        paymentStatus: true,
      },
      orderBy: { createdAt: 'asc' },
      ...(limit ? { take: limit } : {}),
    })) as StuckPayment[];

    out(`Found ${stuck.length} payment(s) stuck 'pending' > ${olderThanHours}h` +
      (bookingFilter ? ` (booking=${bookingFilter})` : ''));
    out(apply ? '⚠️  APPLY MODE — proposed changes WILL be written via the FSM' : '🔎 DRY-RUN — nothing will be written');

    // ── build the plan: batched Omise GETs (pause + timeout; fault-isolated) ──
    const plan: PlanRow[] = [];
    for (let i = 0; i < stuck.length; i += OMISE_BATCH_SIZE) {
      const batch = stuck.slice(i, i + OMISE_BATCH_SIZE);
      const outcomes = await Promise.all(
        batch.map(async (p): Promise<[StuckPayment, ChargeOutcome]> => {
          if (!p.omiseChargeId) return [p, { kind: 'no_charge_id' }];
          return [p, await fetchOutcome(omise, p.omiseChargeId)];
        }),
      );
      for (const [p, outcome] of outcomes) plan.push(planRow(p, outcome));
      if (i + OMISE_BATCH_SIZE < stuck.length) await sleep(OMISE_BATCH_PAUSE_MS);
    }

    // ── write the plan CSV (BOTH modes) ──
    writeFileSync(outPath, toCsv(plan), 'utf8');
    out(`Plan written: ${outPath}`);

    // ── apply (only under --apply): per row, tx + FOR UPDATE + recheck pending ──
    if (apply) {
      for (const row of plan) {
        if (row.proposedStatus === null) continue; // skip buckets
        try {
          const moved = await applyOne(prisma, fsm, row);
          out(moved ? `✔ ${row.paymentId} ${row.currentStatus} → ${row.proposedStatus}`
                    : `↷ ${row.paymentId} skip:already_moved (no longer pending)`);
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          log.error(`x apply failed payment=${row.paymentId}: ${m}`);
        }
      }
    }

    // ── summary ──
    const counts = summarize(plan);
    out('\n── Summary ──');
    out(`  threshold: > ${olderThanHours}h    total stuck: ${plan.length}`);
    for (const b of Object.values(RepairBucket)) out(`  ${b}: ${counts[b]}`);

    if (!apply) {
      out('\nDRY-RUN — no rows changed. Review the plan, then run with --apply in an Omise env.');
    }
  } finally {
    await app.close();
  }
}

/**
 * Apply one repair inside a tx (§6 concurrency): lock the row, re-check it is STILL pending
 * (the live PromptPay-reconcile cron may have moved it), then FSM-transition + set captured_amount.
 * Returns false when the row already moved (skip:already_moved).
 */
export async function applyOne(
  prisma: PrismaService,
  fsm: PaymentStateMachine,
  row: PlanRow,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "payments" WHERE "id" = ${row.paymentId}::uuid FOR UPDATE`;
    const fresh = await tx.payment.findUnique({
      where: { id: row.paymentId },
      select: { paymentStatus: true },
    });
    if (!fresh || fresh.paymentStatus !== PaymentStatus.pending) return false;

    await fsm.transition(
      row.paymentId,
      row.proposedStatus!,
      {
        changedBy: REPAIR_ACTOR,
        reason: row.reason,
        metadata: {
          omiseChargeId: row.omiseChargeId,
          omisePaid: row.omisePaid,
          omiseCaptured: row.omiseCaptured,
          omiseAmountSatang: row.omiseAmountSatang,
        },
      },
      tx,
    );

    // §4: on →captured, persist captured_amount from the Omise amount (satang→baht, exact).
    if (row.proposedStatus === PaymentStatus.captured && row.omiseAmountSatang != null) {
      await tx.payment.update({
        where: { id: row.paymentId },
        data: { capturedAmount: new Prisma.Decimal(row.omiseAmountSatang).div(100) },
      });
    }
    return true;
  });
}

// only auto-run as a CLI — importing this module (e.g. in tests) must NOT bootstrap Nest
if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
