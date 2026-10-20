# PYG-639 · S16 implementation and validation

20 Oct 2026 · Contract: [PYG-637](pyg-637-s16-booking-level-api-contract.md)

S16 calculates ADL through S09's classifier, finds exact active Flag rules (including system unsure/severe dementia), and applies service overrides before falling back to S15 activity levels. The 9 Oct F03 advanced correction supersedes the old physiotherapy exception. Levels use S02's existing CareLevel and shared ordering.

Creation, assessment saves affecting every unconfirmed booking, and confirmation call `recalculateBookingRequirements` in the caller's transaction. It writes levels/time and S17's scalar/relation skill snapshots together, under recipient then booking locks. A failure in either calculator rolls back the source change and all snapshots. Confirmed bookings read their saved values. Queries do not calculate. S15 currently exposes activity selection on creation; future activity/service edit operations must call the same hook inside their source transaction.

GraphQL exposes nullable `requiredLevel` and `levelBreakdown` on BookingSummary, CaregiverBookingSummary and GroupBookingSummary. REST BookingRest includes the same fields and uppercase level names. `level_calculated_at` distinguishes legacy from computed no-effect criteria. The generated schema preserves every previous type, field, argument and enum value. Existing root authorization applies.

## Verification

Baseline commit `70bcad2` includes S08/S09/S17 prerequisites plus dev `e2a6e75` (S15). Prisma Client 6.19.3 generated successfully before both baseline and final measurements. No production database was modified.

| Check | Before | After | Result |
| --- | --- | --- | --- |
| `npm test -- --runInBand` | 2461 pass / 1 fail | 2510 pass / 1 fail | 49 new unit/contract tests pass; identical existing failure |
| `npm run test:e2e -- --runInBand` without Docker URL, inside sandbox | 30 fail / 4 failed suites / 39 skipped | 30 fail / 4 failed suites / 50 skipped | Same failing tests and suites; 11 new DB tests skipped in this mode |
| `npx tsc --noEmit` | 4 errors | 4 errors | Identical TS2694 Express.Multer locations |
| Docker Postgres S08/S09/S16/S17 suites | — | 37 pass / 4 suites | Real transactions, rollback and concurrent saves/confirmation |
| Contract examples | — | 4 successful responses | Executed through generated GraphQL schema, checked REST mapping |
| Schema compatibility | — | additive | All existing fields/arguments/types/enum values preserved |
| `git diff --check` | — | pass | No whitespace errors |

The existing unit failure is PYG-634's createBookingOnBehalf lock-order assertion: it assumes the last `$queryRaw` is the pre-creation activity lock; S17 already adds later snapshot locks. Its identity and count are unchanged. The four TypeScript failures are profile-photo controller/service and care-log controller/service references to Express.Multer. Existing full-e2e failures include dependency-injection, sandbox listener and Multer type issues; these are not reported as passing.

The 49 new unit/contract cases cover all ADL boundaries and valid scores, invalid inputs, all 12 seed rules with the F03 correction, dementia variants, unsure, active/inactive/missing rules, maxima, fallback/override/no-effect behavior, stored reads, batching, schema nullability and the actual contract examples. The 11 new Postgres cases cover creation, F03 without selected activities, recalculating every unconfirmed sibling, null ADL/unsure, S15 activity selection/replacement hook, missing/inactive Flag errors in GraphQL/REST with rollback, rollback after the level write if skills fail, confirmed snapshots, concurrent save/confirmation, and legacy/missing assessments.

Reproduce the database check against a disposable Docker Postgres initialized from the current Prisma schema:

```sh
PYG609_DATABASE_URL=postgresql://pyg609:pyg609-local-test@127.0.0.1:55409/pyg609_test \
  npm run test:e2e -- --runInBand --runTestsByPath \
  test/pyg609-assessment.e2e-spec.ts test/pyg614-care-group.e2e-spec.ts \
  test/pyg639-booking-level.e2e-spec.ts test/pyg643-required-skills.e2e-spec.ts
```

The suites reject remote/non-test database URLs. CI adds S16 to the existing disposable Postgres job and seeds the committed rules plus approved F03 correction as local fixtures.

## Remaining acceptance work

- PYG-640/Sammy must provide the actual five infographic input cases, updated for F03 advanced. The supplied story explicitly contains only their old expected outputs; no fabricated replacement is labelled AC8.
- BE PYG-639 and S18 contract owner PYG-646 must review/sign off PYG-637, including the proposed field visibility and null/error details. Creating this document/PR does not constitute their approval.
- Human gate and prerequisite rollout remain required. In particular PYG-638's F03 correction must be present before enabling S16. [Read-only readiness query](../prisma/checks/booking_level_readiness.sql) returns zero rows when all twelve approved rules are active and correct. Run through the existing deployment process; no migration is added or replayed here.

## Integration update

The feature branch subsequently integrated S18 and dev `83ccd4d`. Full unit tests now pass 2680/2680 (dev baseline 2591/2591); the original lock-order failure was fixed upstream by PR #143. Docker S08/S09/S16/S17/S18 passes 55 tests. Full e2e and the four Express.Multer errors remain identical to the fresh current-dev baseline. See the [final S18 integration report](pyg-647-s18-matching-validation.md) for the exact comparison and review of merge resolutions.
