# PYG-647 · S18 validation and code review

20 Oct 2026 · [API contract PYG-646](pyg-646-s18-matching-api-contract.md) · Branch feature/CODE

The backend now evaluates level, canonical skills, profession locks from S17 and approved/unexpired S03 evidence. It exposes the eligible Elder list, an admin-only live report, and an atomic caregiver selector. The user confirmed expiry is checked on the booking's service day. No table, migration, caregiver skill conversion or KYC approval operation is added.

## Final integration with current dev

After the first measurements, dev advanced to `83ccd4d` (including S08/S09, the activity-lock test fix and S03/S10 updates). It was merged into feature/CODE without replacing those changes. A detached checkout of that exact dev commit was measured with a freshly generated Prisma Client and compared with the merged implementation:

| Check | dev 83ccd4d baseline | Final S16/S18 integration |
| --- | --- | --- |
| Full unit tests | 2591 pass / 0 fail | 2680 pass / 0 fail across 138 suites |
| Full e2e without a Docker URL | 30 fail / 4 failed suites / 39 skipped | Same 30 fail / 4 failed suites / 68 skipped |
| Fresh TypeScript check, incremental disabled | 4 errors | Same 4 Express.Multer errors |
| Docker S08/S09/S16/S17/S18 | — | 55 pass across 5 suites |
| Compatibility | — | Schema preserves both previous feature/CODE and current dev fields/arguments/enum values |

The extra 89 unit cases over dev are the previously committed 49 S16 cases plus 40 S18 cases. The extra 29 skipped e2e cases without Docker are 11 S16 plus 18 S18; all run and pass in the Docker invocation. Failure identities in full e2e are unchanged.

The old unit failure disappeared because dev already fixed the activity-lock assertion in PR #143. Merge review also removed the duplicate S17 recalculation introduced by combining PR #144 with the shared S16/S17 hook, retained S10 infectionDisclosure alongside levelBreakdown, and deduplicated test imports. A validation helper in the existing S17 skill test now accepts the explicit union of its two DTO constructors after KYC integration; its 14 tests were rerun and pass, with no runtime validation skipped. No new TypeScript errors remain.

## Review findings addressed

| Finding | Implementation and evidence |
| --- | --- |
| Direct creation could bypass a booking-specific List filter | Existing REST/GraphQL creation with caregiverId calls the same evaluator after S16/S17 persistence, inside the creation transaction. A real-DB failure leaves no new booking. |
| A candidate could change between listing and selection | Selection rechecks stored requirements and current caregiver/evidence inside recipient → booking → caregiver locks, plus evidence/availability row locks. Tests change level, skills, evidence and booking inputs after listing; none can assign on failure. |
| Assigned caregivers could become invalid before confirmation | confirmBooking rechecks after S16/S17 refresh before committing confirmed status. Rejected evidence blocks confirmation and rolls back the recalculation timestamp. |
| Existing rejected-booking recovery returned the old unfiltered matches | Recovery validates matchability before resetting status and restricts its existing match query to S18 eligible IDs before the old limit. |
| Filtering after the existing page limit could hide valid caregivers | Eligible IDs restrict the existing SearchService SQL before pagination. S18 adds only an ID tie-break for stable pages, preserving existing sort priorities. A >50 candidate database test returns all passing IDs once. |
| Private data/rejected IDs could leak through a shared result type | Elder and admin payloads are distinct. Elder output has no reject reasons/counts/documents. Only accepted IDs reach the public projection/avatar signer. Schema and real-DB tests inspect the response. |
| Prisma loses NULL vs [] scalar-list semantics | Matching reads SQL required_skills directly and requires a calculation marker. Legacy NULL returns BOOKING_NOT_MATCHABLE; computed [] still evaluates level. |
| Pending profession evidence or another user's license could qualify | The adapter uses the approved caregivers.profession and owned professional_license documents, excludes other-profession request documents and unbound documents predating an approved profession change. Real-DB tests cover all three cases. |
| Multiple selection requests could overwrite one another | The booking row lock and fresh unmatched/null-assignment check allow exactly one concurrent selector to commit. Notification is emitted only after success. |

S03 stores a generic professional_license rather than an explicit profession on each document. Initial evidence therefore continues to rely on S03's administrative approval for the caregiver's current profession; S18 uses existing profession-change associations where available and does not guess from file names or add schema without a DB card.

## Initial verification before dev integration

Baseline: committed S16 `56dc0d6`. Prisma Client 6.19.3 generated successfully before baseline and final measurements. Full-suite failure identities were compared, not only counts.

| Check | Before | After |
| --- | --- | --- |
| Unit tests | 2510 pass / 1 fail | 2550 pass / 1 fail |
| Full e2e without a Docker URL, inside sandbox | 30 fail / 4 failed suites / 50 skipped | 30 fail / 4 failed suites / 68 skipped |
| tsc --noEmit | 4 errors | Same 4 errors |
| Disposable Docker Postgres S08/S09/S16/S17/S18 | — | 55 pass across 5 suites, including 18 S18 cases |
| New pure/contract/search checks | — | 40 new passing unit tests |
| GraphQL contract examples | — | All 4 successful responses execute against the actual schema |
| Schema compatibility | — | All previous types, fields, arguments and enum values preserved |
| git diff --check | — | Pass |

The unchanged unit failure is PYG-634 createBookingOnBehalf's lock-order assertion, which treats the last raw query as the pre-create activity lock despite S17 snapshot locks. The four unchanged TS2694 errors reference Express.Multer in profile-photo controller/service and care-log controller/service. Existing full-e2e failures are the same DI/listener/type problems as baseline. They are not labelled as passing. The final full-unit measurement used --forceExit after the existing baseline open-handle warning; this does not skip tests or suppress assertion failures.

The new unit tests cover all 9 level pairs, missing levels, every required skill, professional locks, every evidence status, expiry boundaries, explicit reference dates, all four reasons together, the BASIC physiotherapy profession example, incompatible injection + physiotherapy, metadata-driven locks, protected operation roles, privacy of GraphQL types, real document examples and the public SQL restriction/snapshot boundary.

Database verification used a new local postgres:16 container `payung-pyg647-postgres`, port 55418, database `pyg609_test`, initialized from the current Prisma schema with test-only fixture seeds. No production database or existing test database was changed. CI adds the S18 suite to the existing fresh-schema Postgres job.

```sh
PYG609_DATABASE_URL=postgresql://pyg609:pyg609-local-test@127.0.0.1:55418/pyg609_test \
  npm run test:e2e -- --runInBand --runTestsByPath \
  test/pyg647-matching.e2e-spec.ts test/pyg639-booking-level.e2e-spec.ts \
  test/pyg643-required-skills.e2e-spec.ts test/pyg609-assessment.e2e-spec.ts \
  test/pyg614-care-group.e2e-spec.ts
```

## Acceptance still open

- **AC6 is not closed.** The user confirmed storage is undecided. The admin operation returns a live result with evaluatedAt/persisted=false. It is not a historical record of the list the relative previously saw. PYG-571/646 and Sammy must decide storage and arrange a DB card/gate if a new table is chosen.
- **AC7 needs a real contact URL.** Empty-state behavior and the configurable contact field are implemented; production's actual Payung LINE Official/form/phone has not been supplied. Missing configuration returns null, never an invented contact address.
- BE PYG-647 / FE PYG-648 must review the draft contract, including operation names, group read vs owner selection permissions and public careLevel. QA PYG-649 must reconcile its approved table with the cases supplied in this chat. No separate QA table or human sign-off has been claimed.
- The draft PR still needs the repository's human gate and prerequisite rollout. The inherited S16 contract also retains its documented sign-off/infographic-input items.
