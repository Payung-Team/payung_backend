# PYG-440 · QR check-in / check-out E2E — security & edge · QA report

- Ticket: PYG-440 (QA) · Parent story: PYG-433 (QR check-in/out) · Config: PYG-441 · Related: PYG-434/435/436/437 (BE), PYG-364 (escrow gate), PYG-470 (raw photo path)
- **No test sheet existed.** The 24 cases come from the agent prompt and are written up in house format in §8, with run status filled in.
- Specs:
  - `test/qr-checkin-checkout.e2e-spec.ts` (TC _01–_14, _16–_24)
  - `test/qr-checkin-checkout.concurrency.e2e-spec.ts` (TC _15)
  - `test/support/qr-e2e.ts` (shared harness)
- Branch: `test/PYG-440-qr-checkin-checkout` off `origin/dev` @ **`6fdc2e0`** (origin/dev moved on from the `0a6f1ec` used in PYG-415/420/427/423)
- Created By / Execute By: Wasan. R
- **Result: 18 PASS · 6 FAIL · 0 BLOCKED** (24 TCs)

**What runs for real:** the app boots the whole `MonitoringModule`:
- `JobScanResolver` / `JobScanService`
- `JobQrResolver` / `JobQrService`
- `MonitoringService`
- `CareLogController`
- `NoCheckoutSweeperService`

It has the real guard chain (`SupabaseAuthGuard → RolesGuard`, and `SupabaseHttpAuthGuard → HttpRolesGuard` for REST) and Prisma against a **disposable Postgres 17 in Docker**. Each QR session is created by the real `JobQrService.createForBooking()`, and the raw token is fetched through the patient's real `jobQr` query.

**What is mocked:** only `SupabaseService` (auth), `EmailService`, and **`ClockService`, replaced with a clock each test sets explicitly**. No time-boundary case depends on wall-clock time. This module never touches Omise.

---

## 1. Baseline before / after

Measured in the worktree after `npm ci` and `prisma generate` (log line `✔ Generated Prisma Client (v6.19.3)`).

| Check | Before (`6fdc2e0`) | After (this branch) | Δ |
|---|---|---|---|
| `npx tsc --noEmit` | 19 errors | 19 errors, 0 in new files | 0 |
| `npm test` | 35 failed / 1071 | 35 failed / 1071 | 0 |
| `npm run test:e2e` (no test DB, local) | 1 failed / 29 (`app.e2e-spec`) | 1 failed / 53, 24 skipped (new suites skip without a DB) | 0 failures added |
| PYG-440 specs against Docker DB (final run 2026-09-15T17:04:46Z, formatted files) | n/a | 18 passed / 6 failed | — |

**CI guard verified:** `CI=1` with no DB URL → exit 1, `Test Suites: 2 failed, 2 total`, message `PYG440_DATABASE_URL ไม่ได้ตั้งค่าใน CI`.

| Run parameter | Value |
|---|---|
| `BOOKING_EXPIRY_CRON_ENABLED` | **unset** (not in the shell; also deleted by the harness before boot) |
| `HOLD_REFRESH_CRON_ENABLED` | **unset** (same) |
| QR config env (`QR_VALID_FROM_OFFSET_MIN`, `QR_VALID_UNTIL_GRACE_MIN`, `QR_SINGLE_USE_PER_ACTION`, `QR_MIN_SECONDS_BETWEEN_ACTIONS`) | **all unset**, so code defaults are in force (§2.2) |
| `QR_TOKEN_SECRET` | Fixed test-only value set by the harness (not a real secret) |
| Connection guard | Reads only `PYG440_DATABASE_URL` and throws if the host isn't localhost. **Unset locally → the suite is skipped; unset with `CI` set → the suite fails** |

**Schema verified before running**, on the test DB (built from `schema.prisma` plus hand-copied CHECKs, PYG-415 §6):
- Tables `job_sessions`, `job_scan_events` and `job_events` all present
- Unique indexes:
  - `job_sessions_booking_id_key`
  - `job_sessions_token_hash_key`
  - `job_events_booking_id_event_type_key`
- CHECKs:
  - `job_sessions_status_check`, `_token_hash_check`, `_valid_window_check`
  - `job_events_event_type_check`, `_source_check`
  - `job_scan_events_action_check`, `_result_check`

---

## 2. Read from the code

### 2.1 Scan result codes

Source: `src/monitoring/qr/qr.constants.ts` (`SCAN_RESULT`), matching DB CHECK `job_scan_events_result_check`.

| Code | Meaning (code comment) | `ok` |
|---|---|---|
| `SUCCESS` | Scan accepted; check-in or check-out done | true |
| `TOKEN_NOT_FOUND` | Token matches no session | false |
| `NOT_A_CAREGIVER` | Scanning account has no caregiver profile | false |
| `WRONG_CAREGIVER` | A caregiver, but not the one on this booking (compared with `bookings.caregiver_id` **now**) | false |
| `BOOKING_INACTIVE` | Booking `cancelled` / `rejected` (`QR_DEAD_BOOKING_STATUSES`) | false |
| `OUT_OF_WINDOW` | `now < valid_from` or `now > valid_until` | false |
| `ALREADY_COMPLETED` | Session already `CHECKED_OUT` | false |
| `TOO_SOON` | Check-out sooner than `QR_MIN_SECONDS_BETWEEN_ACTIONS` after check-in | false |
| `DUPLICATE` | Lost a concurrent race; the job is already in the intended state | **true** |
| `WRONG_SEQUENCE` | Check-out with no check-in row | false |
| `JOB_NOT_READY` | `MonitoringService` rejected it (not `confirmed`, unpaid, wrong day, bad attachment) | false |

A scan **does not throw** for business rejections; it returns `{ ok, result, action, message }`. Actions (`SCAN_ACTION`) are `CHECK_IN | CHECK_OUT | NONE`. Session states are `PENDING | CHECKED_IN | CHECKED_OUT`.

### 2.2 Config keys and defaults (PYG-441 — ticket is Done)

| Key | Default in force | Meaning | Source |
|---|---|---|---|
| `QR_VALID_FROM_OFFSET_MIN` | **60** | `valid_from` = scheduled start − 60 min | `qr.constants.ts` (`envInt`) |
| `QR_VALID_UNTIL_GRACE_MIN` | **120** | `valid_until` = scheduled end + 120 min (the grace is **inside** `valid_until`) | same |
| `QR_SINGLE_USE_PER_ACTION` | **true** | Loser of a concurrent advance gets `DUPLICATE` (when `false`, it gets `SUCCESS`) | same |
| `QR_MIN_SECONDS_BETWEEN_ACTIONS` | **60** | Minimum gap between check-in and check-out (`TOO_SOON`) | same |
| `QR_TOKEN_SECRET` | none (random per boot outside production; throws in production) | HMAC key for token derivation | `job-qr.service.ts` `resolveSecret()` |

The window is computed once, when the session is created. Both edges are **inclusive** (`now < validFrom || now > validUntil` rejects; verified in _09).

### 2.3 `job_scan_events` columns

| Column | Notes |
|---|---|
| `id` uuid | |
| `session_id` uuid null | null when the token matched no session |
| `booking_id` uuid null | **null for `TOKEN_NOT_FOUND`** (the booking isn't known) |
| `scanned_by` text | `users.id` from the JWT |
| `caregiver_id` text null | null for `NOT_A_CAREGIVER` |
| `token_hash` text | `sha256(submitted token)`, never the raw token |
| `action` | `CHECK_IN` / `CHECK_OUT` / `NONE` |
| `result` | one of §2.1 |
| `reason` text | the Thai user-facing message; distinct per result (_19) |
| `scanned_at` timestamptz | server clock |

**Failed scans are recorded**, but only when the request reaches `JobScanService.finish()`. See F2 for the paths that don't, and F1 for the unhandled exception path.

---

## 3. Results

| TC_NO | Result | Evidence | Notes |
|---|---|---|---|
| _01 | PASS | `{ok: true, result: SUCCESS, action: CHECK_IN, sessionStatus: CHECKED_IN}`; booking `in_progress`; `job_events = [check_in:caregiver]` with `server_ts` = the server clock; one `job_scan_events` row `{SUCCESS, CHECK_IN, scanned_by: C}` | |
| _02 | **FAIL** | Check-out succeeded (`SUCCESS/CHECK_OUT/CHECKED_OUT`); events `[check_in:caregiver, check_out:caregiver]`; check-out `server_ts` = server clock (client `deviceTs` 2020 ignored); 1 session row. **But the check-in token is no longer accepted (`TOKEN_NOT_FOUND`), and the check-out token differs** | **C1**: PYG-437 rotates the token per action |
| _03 | PASS | Scan input carrying `bookingId` → `BAD_USER_INPUT` (the field doesn't exist); neither booking changes. The booking is bound to the token; the client can't name one | No "wrong-booking" code exists because the mismatch can't be expressed (O2). The GraphQL-level rejection isn't logged (F2) |
| _04 | PASS | Unassigned caregiver D → `WRONG_CAREGIVER`, `ok=false`; session, booking and events unchanged; +1 row `{scanned_by: D, caregiver_id: D, booking_id: B}` | Money path ✔ |
| _05 | PASS | (1) Input with `action: CHECK_OUT` → `BAD_USER_INPUT`. (2) Legacy `checkOutBooking` with no scan → "งานนี้ต้องสแกน QR ของผู้รับบริการก่อนจึงจะเริ่มหรือจบงานได้"; state unchanged. (3) A plain scan → server derives `CHECK_IN` | **The client can't choose the action**; it never jumps `PENDING → CHECKED_OUT` |
| _06 | PASS | Scan after check-out → `ALREADY_COMPLETED`; still `CHECKED_OUT`; still 2 `job_events`; +1 row | Money path ✔ |
| _07 | PASS | Clock = `valid_from − 60 s` → `OUT_OF_WINDOW`; unchanged; +1 row; `valid_from` = start − 60 min | |
| _08 | PASS | `valid_until` = end + 120 min (grace included); clock = `valid_until + 1 s` → `OUT_OF_WINDOW`; unchanged; +1 row | |
| _09 | PASS | At exactly `valid_from` → `SUCCESS` (check-in); at exactly `valid_until` → `SUCCESS` (check-out); 1 ms before `valid_from` → `OUT_OF_WINDOW`; 1 ms after `valid_until` → `OUT_OF_WINDOW` | **Both edges inclusive** (previously undocumented) |
| _10 | PASS | Booking set to `cancelled` after the QR was issued → `BOOKING_INACTIVE`; no event; +1 row | |
| _11 | PASS | Booking set to `expired` → rejected **`JOB_NOT_READY`**; no check-in; +1 row | `expired` isn't in `QR_DEAD_BOOKING_STATUSES`; the block comes from `checkInBooking`'s "must be confirmed" check (O1). Money path ✔ |
| _12 | PASS | Booking returned to `unmatched` with `caregiver_id = null` (as `booking.service.ts:874` does) → previous caregiver gets `WRONG_CAREGIVER`; no advance; +1 row | Money path ✔ |
| _13 | PASS | `job_sessions.token_hash = sha256(current token)`; `job_scan_events.token_hash = sha256(scanned token)`; the raw check-in and check-out tokens appear **nowhere** in session rows, scan rows or captured logs; hashes aren't logged either | Tokens are HMAC-derived on demand (PYG-437), never stored. Money path ✔ |
| _14 | **FAIL** | Random / truncated / one-char-changed → `TOKEN_NOT_FOUND`, +1 row each, no booking id in the response ✔. **Empty token → `BAD_REQUEST` from class-validator (`@IsNotEmpty`), 0 rows logged.** State unchanged | **F2** (the PYG-415 `BAD_REQUEST` pattern, reported once). Money path |
| _15 | **FAIL** | 10 rounds. **Money invariant holds every round:** exactly 1 `check_in`, 1 `check_out`, session `CHECKED_OUT`. Concurrent check-in: `[DUPLICATE, SUCCESS]` ×10 ✔. **Concurrent check-out: `[INTERNAL_SERVER_ERROR, SUCCESS]` ×10, only 3 of 4 attempts logged.** SQL level: CAS `UPDATE … WHERE status='PENDING'` blocks the 2nd connection, then 0 rows; `job_events` unique index rejects a 2nd check-in insert | **F1**. Money path |
| _16 | PASS | Check-in row `server_ts` = server clock. REST `POST /api/v1/monitoring/bookings/:id/care-logs` with `deviceTs` = check-in + 1 min → **201**; no `care_log.missing_check_in_event` log | |
| _17 | PASS | Clean job: check-in at start, check-out at +120 min with coordinates at the job location, client `deviceTs` = +90 min. Result: `check_out.source = caregiver`, `check_out.server_ts` = +120 min (not `deviceTs`), `review_reasons = []`, `dispute_status = none`, `proofOfWorkForSystem.verdict = valid`, booking `awaiting_release` | Verdict inputs verified. The release cron (PaymentModule) itself wasn't run; its anchor is `check_out.server_ts`, asserted here (O6) |
| _18 | PASS | (a) Assigned caregiver closes without scanning → blocked by `assertScanned`. (b) Another caregiver scans the check-out token → `WRONG_CAREGIVER`. (c) Clock past end + 6 h → `NoCheckoutSweeperService.run()` writes `check_out.source = system`; `review_reasons = [no_checkout]`; **verdict `needs_review`**; booking `needs_review` | **Money can't release on a check-out the assigned caregiver didn't make.** Money path ✔ |
| _19 | PASS | 1 success + 3 failures → 4 rows: `{OUT_OF_WINDOW, C, booking}`, `{SUCCESS, C, booking}`, `{TOKEN_NOT_FOUND, C, no booking}`, `{WRONG_CAREGIVER, D, booking}`; 4 distinct non-empty `reason` values | |
| _20 | **FAIL** | Patient scans own token → `FORBIDDEN` (role guard); session `PENDING`; no events ✔. **0 rows logged** | **F2** |
| _21 | **FAIL** (expected) | Check-out scan with `photoUrl = <bookingId>/check-out-1.jpg` → `SUCCESS`, but response `jobEvent.photoUrl = "<bookingId>/check-out-1.jpg"`, a raw storage path | **Evidence for PYG-470**, not a new finding. PYG-470 scoped the QR scan response *out* of signing (O3) |
| _22 | PASS | Defaults in force `{60, 120, true, 60}`, no QR env set. With env `QR_VALID_FROM_OFFSET_MIN=15`, `QR_VALID_UNTIL_GRACE_MIN=5`, `QR_SINGLE_USE_PER_ACTION=false`, a fresh module registry gives the real `JobQrService` a window of start − 15 min .. end + 5 min, and single-use `false` | Values come from env, read once at module load (changing them needs a restart) |
| _23 | **FAIL** | The issued token checks in (`SUCCESS`); **the same token at check-out → `TOKEN_NOT_FOUND`**; 1 session row ✔ | **C1**, same root cause as _02 |
| _24 | PASS | Booking `pending` with no caregiver: a session still exists and the patient can fetch the QR, but any caregiver's scan → `WRONG_CAREGIVER`; unchanged; +1 row | "No usable QR" holds through rejection (O4) |

---

## 4. Blocked list

**None.** The prompt expected missing pieces, but by the time of the run the relevant cards were **Done** in Jira: PYG-434 (generate), PYG-435 (scan + gate), PYG-436 (schema), PYG-441 (config). Only the parent PYG-433 is In Progress. All three tables, every result code and every config key exist in the code, so no case had to be BLOCKED.

---

## 5. Product findings (not fixed)

### F1 — Concurrent check-out scans: the loser gets a 500 and its attempt isn't logged · suggested severity: **Medium — money path** (no double release; audit gap on the payout-triggering action)

- **Spec:** PYG-435: "เขียน JobScanEvent ทุกครั้ง (สำเร็จ+ล้มเหลว)"; edge "สแกนรัว 2 ครั้ง (idempotency/lock)"; single advance per action (PYG-433).
- **Code:**
  - `checkInBooking` catches the unique-constraint collision (`P2002`) and returns the winning row (`src/monitoring/monitoring.service.ts:257`), so the losing scan reaches the session compare-and-swap and ends as `DUPLICATE` (logged).
  - **`checkOutBooking` has no such catch** around its `$transaction` (`:389`). The losing concurrent check-out throws `PrismaClientKnownRequestError P2002` (`job_events_booking_id_event_type_key`).
  - `JobScanService` treats anything that isn't a `BadRequestException` as a system fault and rethrows it (`src/monitoring/qr/job-scan.service.ts:302`; comment `:300` says such cases deliberately write no row).
- **Evidence (_15):** 10/10 rounds of concurrent check-out → `[INTERNAL_SERVER_ERROR, SUCCESS]`, 3 of 4 scan attempts logged. **Money invariant holds:** exactly one `check_out` row and one verdict, so the escrow gate isn't triggered twice.
- **Impact:**
  - The caregiver's app shows a server error for a job that actually closed.
  - The attempt behind the money-release clock (`check_out.server_ts`) has no audit row.
  - The error log gets noise that looks like a DB failure.
- **Repro:** check a job in, advance the clock past `QR_MIN_SECONDS_BETWEEN_ACTIONS`, then fire two `scanJobQr(input: {token: <check-out token>})` calls in parallel as the assigned caregiver.
- **Fix direction:** handle `P2002` in `checkOutBooking` the same way `checkInBooking` does (return the winner), so the loser flows to `DUPLICATE` and is logged.

### F2 — Scan rejections before `JobScanService` aren't written to `job_scan_events` · suggested severity: **Medium — money path** (audit completeness)

One root cause: role guard, input validation and GraphQL input checks all run before the service's single exit (`finish()`), so these rejections never reach the audit table.

- **Spec:** PYG-435 AC: "เขียน JobScanEvent ทุกครั้ง (สำเร็จ+ล้มเหลว)"; PYG-440 prompt: every negative case must be logged.
- **Paths confirmed unlogged:**
  - **Empty token** → class-validator `@IsNotEmpty` on `ScanJobQrInput.token` → `BAD_REQUEST`, 0 rows (**_14**). This is the PYG-415 `BAD_REQUEST`-instead-of-domain-code pattern: the domain code would be `TOKEN_NOT_FOUND`. Likely the same for tokens over `@MaxLength(512)` (not asserted).
  - **Patient (or any non-caregiver role) scanning** → `@Roles(ROLE_ID.CAREGIVER)` on `scanJobQr` (`job-scan.resolver.ts:32`) → `FORBIDDEN`, 0 rows (**_20**).
  - Unknown input fields (`bookingId`, `action`) → `BAD_USER_INPUT`, 0 rows (_03/_05; those cases didn't assert logging, noted for completeness).
- **Impact:** a patient or third party trying to advance a job, or a scanner sending malformed tokens, leaves no trace in the scan log that ops/admin would review.
- **Decide:** either log these rejections (for example an exception filter or interceptor that writes a `job_scan_events` row with a new result such as `FORBIDDEN_ROLE` / `INVALID_INPUT`; needs a CHECK change, so a migration), or amend the AC to "every attempt that reaches the service".

### C1 — Spec conflict: "one QR for the whole job" vs per-action token rotation (PYG-437) · needs a spec decision, not a defect

- **PYG-433 and this prompt (_02, _23):** one QR per booking, the same token for check-in and check-out, "no new token issued".
- **Code (PYG-437, merged):** `token = HMAC(secret, "payung:jobqr:v2:<sessionId>:<action>:<updated_at>")`. On a successful check-in the session's `token_hash` is re-derived for `CHECK_OUT` (`job-scan.service.ts:336–349`), so the check-in token dies at once and the patient's app shows a new QR for check-out. The trade-offs are documented in the `JobQrService` header (`job-qr.service.ts:83–97`): printed QRs can't be reused, a leaked QR can be rotated away, and a check-in QR can't be used to close the job.
- **Still true:** one `job_sessions` row per booking (_02/_23 ✔); the action is still derived from state (_05 ✔).
- **Evidence:** _02 and _23 both show `TOKEN_NOT_FOUND` when the issued token is reused at check-out.
- **Decide:** update PYG-433 and the QA sheet to the per-action token model (recommended; it's a security improvement), or revert PYG-437.

### Observations (not failures)

- **O1:** `expired` isn't in `QR_DEAD_BOOKING_STATUSES` (`cancelled`, `rejected`). An expired booking is still rejected, by `checkInBooking` requiring `confirmed`, but with code `JOB_NOT_READY` and a generic message rather than `BOOKING_INACTIVE`. Adding `expired` to the list would give the right message (PYG-461/462 added the status after the QR work).
- **O2:** there's no "wrong booking" result. The scan input has no booking field, so a QR can only ever act on its own booking (_03).
- **O3 (_21 / PYG-470):** the `JobEvent` entity describes `photoUrl` as a "signed URL หมดอายุใน 1 ชม.", but the scan response returns the raw path. PYG-470 explicitly decided the QR scan and `checkOutBooking` responses won't sign (the FE refetches through `proofOfWork`). Either the entity description or that scope decision should change so they agree.
- **O4 (_24):** a booking with no caregiver still gets a session at creation, and the patient can fetch its QR. Harmless (every scan is rejected), but the FE may show a QR that can't work yet.
- **O5:** the loser of a concurrent check-in gets `DUPLICATE` with `ok=true` by design ("the job is in the intended state"). The prompt's "the other is rejected" doesn't match; this is recorded, not failed.
- **O6 (_17):** verified that `check_out.server_ts` is the server clock and ignores client `deviceTs`, and that the verdict inputs are valid. The release cron itself lives in Payment/Settlement and wasn't exercised in this suite.

---

## 6. Deferred scope confirmation

Screenshot anti-replay, offline queue and geofence (plus the "deep edge cases" PYG-433 defers to Sprint 9) were **intentionally not tested**, and their absence isn't reported as a failure.

---

## 7. Questions / assumptions

1. **C1:** confirm per-action token rotation (PYG-437) as the product rule, and update PYG-433 plus the sheet (_02, _23).
2. **F2:** should role and validation rejections be written to `job_scan_events`? That needs a new result value and a CHECK migration, which only Sammy can apply.
3. **F1:** is `DUPLICATE` the intended outcome for a concurrent check-out loser (matching check-in)?
4. **O1:** add `expired` to `QR_DEAD_BOOKING_STATUSES`?
5. **Assumptions:**
   - Bookings and payments are seeded directly; sessions come from the real `createForBooking`, and tokens from the real `jobQr`.
   - `cancelled`, `expired` and `unmatched` states are set directly as preconditions (the expiry cron is disabled).
   - The system check-out in _18 is produced by calling the real sweeper's `run()` with the clock past the cutoff.
   - RLS and the Supabase schemas aren't in the test DB; the backend connects as the table owner.

---

## 8. Case table (house format, ready to paste)

Columns follow the house sheet (23 columns). Type Functional · Mode Manual · Created By / Execute By Wasan. R · Automate Status "Automated (e2e)" · Test Area BE. The Test Suite column carries the run status.

| TC_NO. | Module_name | Test Case Title | Test Data | Estimate | Reference | Precondition | Steps | Expected_result | Test Suite | Tags | Description | Type | Priority | Mode | Created By | Execute By | Test Run (Retest) | Issue Link | Remark | isRegression | Automate Status | Test Area |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PYG-440_01 | Monitoring > QR Check-in/out | Verify that the assigned caregiver's first scan checks in the job [QR][CheckIn][Happy] | Booking B (confirmed, paid), caregiver C | 10m | PYG-440 | 1. B accepted by C, session PENDING 2. Now inside the valid window | 1. As C, scan B's QR 2. Inspect state and job_events | - State CHECKED_IN - One check_in job_events row, source caregiver, server-set server_ts - One JobScanEvent SUCCESS row | PASS | QR, CheckIn, Happy | First scan = check-in | Functional | High | Manual | Wasan. R | Wasan. R | | | | Y | Automated (e2e) | BE |
| PYG-440_02 | Monitoring > QR Check-in/out | Verify that the second scan checks the job out [QR][CheckOut][Happy] | Booking B in CHECKED_IN | 10m | PYG-440 | 1. B in CHECKED_IN | 1. As C, scan again 2. Inspect state and job_events | - State CHECKED_OUT - One check_out row, source caregiver, server-set server_ts - Same QR, no new token issued | FAIL | QR, CheckOut, Happy | Token rotates per action (PYG-437) | Functional | High | Manual | Wasan. R | Wasan. R | | PYG-437 | C1 spec conflict | Y | Automated (e2e) | BE |
| PYG-440_03 | Monitoring > QR Check-in/out | Verify that a QR belonging to another booking is rejected [QR][Security][Negative] | B1, B2 both assigned to C | 10m | PYG-440 | 1. B1 and B2 assigned to C | 1. As C, scan B2's QR against B1 | - Rejected - Neither booking advances - Rejection logged | PASS | QR, Security, Negative | Booking bound to token; no booking arg exists | Functional | High | Manual | Wasan. R | Wasan. R | | | GraphQL-level rejection not logged (F2) | Y | Automated (e2e) | BE |
| PYG-440_04 | Monitoring > QR Check-in/out | Verify that a caregiver who is not assigned to the booking cannot scan [QR][Authz][Security] | Caregiver D not on B | 10m | PYG-440 | 1. B assigned to C; D is not | 1. As D, scan B's QR | - WRONG_CAREGIVER - State unchanged - Logged with D as actor | PASS | QR, Authz, Security | Money path | Functional | High | Manual | Wasan. R | Wasan. R | | | | Y | Automated (e2e) | BE |
| PYG-440_05 | Monitoring > QR Check-in/out | Verify that the action is derived from booking state and a client-supplied action is ignored [QR][StateMachine][Security] | B in PENDING | 10m | PYG-440 | 1. B in PENDING | 1. As C, request check-out explicitly 2. Inspect result and state | - Client cannot choose the action - Never PENDING → CHECKED_OUT | PASS | QR, StateMachine, Security | action field rejected; server derives CHECK_IN | Functional | High | Manual | Wasan. R | Wasan. R | | | | Y | Automated (e2e) | BE |
| PYG-440_06 | Monitoring > QR Check-in/out | Verify that a third scan after check-out is rejected [QR][StateMachine][Negative] | B in CHECKED_OUT | 5m | PYG-440 | 1. B in CHECKED_OUT | 1. As C, scan a third time | - ALREADY_COMPLETED - No third job_events row - Stays CHECKED_OUT | PASS | QR, StateMachine, Negative | Money path | Functional | High | Manual | Wasan. R | Wasan. R | | | | Y | Automated (e2e) | BE |
| PYG-440_07 | Monitoring > QR Check-in/out | Verify that a scan before validFrom is rejected [QR][Window][Negative] | now = validFrom − 60 s | 5m | PYG-440 | 1. Now earlier than validFrom | 1. As C, scan B's QR | - OUT_OF_WINDOW - State unchanged, logged | PASS | QR, Window, Negative | validFrom = start − 60 min | Functional | Medium | Manual | Wasan. R | Wasan. R | | | | Y | Automated (e2e) | BE |
| PYG-440_08 | Monitoring > QR Check-in/out | Verify that a scan after validUntil plus grace is rejected [QR][Window][Negative] | now = validUntil + 1 s | 5m | PYG-440 | 1. Now past validUntil (grace included) | 1. As C, scan B's QR | - OUT_OF_WINDOW - State unchanged, logged | PASS | QR, Window, Negative | validUntil = end + 120 min | Functional | Medium | Manual | Wasan. R | Wasan. R | | | | Y | Automated (e2e) | BE |
| PYG-440_09 | Monitoring > QR Check-in/out | Verify that the window boundaries are inclusive as configured [QR][Window][Boundary] | Clock at exactly validFrom / validUntil, ±1 ms | 10m | PYG-440 | 1. Clock frozen at each edge | 1. Scan at exactly validFrom 2. Scan at exactly validUntil | - Both edges accepted - 1 ms outside rejected | PASS | QR, Window, Boundary | Both edges inclusive | Functional | Medium | Manual | Wasan. R | Wasan. R | | | | Y | Automated (e2e) | BE |
| PYG-440_10 | Monitoring > QR Check-in/out | Verify that scanning a cancelled booking is rejected [QR][Lifecycle][Negative] | B cancelled after QR issued | 5m | PYG-440 | 1. B cancelled after QR issued | 1. As C, scan B's QR | - BOOKING_INACTIVE - No advance, no job_events - Logged | PASS | QR, Lifecycle, Negative | | Functional | High | Manual | Wasan. R | Wasan. R | | | | Y | Automated (e2e) | BE |
| PYG-440_11 | Monitoring > QR Check-in/out | Verify that scanning an expired booking is rejected [QR][Lifecycle][Negative] | B status expired | 5m | PYG-440 | 1. B moved to expired | 1. As C, scan B's QR | - Rejected - No check-in recorded | PASS | QR, Lifecycle, Negative | Rejected as JOB_NOT_READY (O1). Money path | Functional | High | Manual | Wasan. R | Wasan. R | | | | Y | Automated (e2e) | BE |
| PYG-440_12 | Monitoring > QR Check-in/out | Verify that scanning a booking returned to unmatched is rejected [QR][Lifecycle][Negative] | B unmatched, caregiver_id null | 5m | PYG-440 | 1. B returned to unmatched | 1. As the previous caregiver, scan the QR | - Rejected - No advance - Stale assignment grants nothing | PASS | QR, Lifecycle, Negative | WRONG_CAREGIVER. Money path | Functional | High | Manual | Wasan. R | Wasan. R | | | | Y | Automated (e2e) | BE |
| PYG-440_13 | Monitoring > QR Check-in/out | Verify that the raw QR token is never persisted [QR][Security][DataLeak] | QR issued and scanned | 10m | PYG-440 | 1. QR issued for B | 1. Query job_sessions 2. Query job_scan_events 3. Search logs for the token | - Only sha256 stored - No raw token in DB or logs | PASS | QR, Security, DataLeak | Token HMAC-derived, not stored. Money path | Functional | High | Manual | Wasan. R | Wasan. R | | | | Y | Automated (e2e) | BE |
| PYG-440_14 | Monitoring > QR Check-in/out | Verify that a guessed or tampered token is rejected [QR][Security][Negative] | Random, truncated, empty, one-char-changed | 10m | PYG-440 | 1. B with a live QR | 1. Scan with each invalid token | - Each rejected with the invalid code - No booking existence leak - Each attempt logged | FAIL | QR, Security, Negative | Empty token → BAD_REQUEST, not logged. Money path | Functional | High | Manual | Wasan. R | Wasan. R | | | F2 | Y | Automated (e2e) | BE |
| PYG-440_15 | Monitoring > QR Check-in/out | Verify that two simultaneous scans advance the job exactly once [QR][Concurrency][Security] | 10 rounds × check-in and check-out, real Postgres | 15m | PYG-440 | 1. B in PENDING | 1. Fire two identical scans in parallel 2. Repeat for check-out | - Exactly one advance - One job_events row per action - Enforced at SQL level | FAIL | QR, Concurrency, Security | Single advance holds; check-out loser → 500, unlogged. Money path | Functional | High | Manual | Wasan. R | Wasan. R | | | F1 | Y | Automated (e2e) | BE |
| PYG-440_16 | Monitoring > QR Check-in/out | Verify that check-in records the fields the care log depends on [QR][Integration] | B checked in | 10m | PYG-440 | 1. B checked in | 1. Inspect check_in row 2. Add a care log entry | - server_ts server-generated - deviceTs lower bound resolves from check_in - No missing_check_in_event log | PASS | QR, Integration | REST care log 201 | Functional | Medium | Manual | Wasan. R | Wasan. R | | | | Y | Automated (e2e) | BE |
| PYG-440_17 | Monitoring > QR Check-in/out | Verify that a valid check-out produces the inputs the escrow gate requires [QR][Payment][Integration] | Clean job, coordinates at job location | 10m | PYG-440 | 1. B checked out normally by C | 1. Inspect check-out event and verdict inputs | - source caregiver - review_reasons empty - Clock anchored to check_out.server_ts | PASS | QR, Payment, Integration | verdict valid → awaiting_release | Functional | High | Manual | Wasan. R | Wasan. R | | | O6: release cron not run | Y | Automated (e2e) | BE |
| PYG-440_18 | Monitoring > QR Check-in/out | Verify that a check-out not made by the assigned caregiver cannot yield a valid verdict [QR][Payment][Security] | No-scan bypass, other caregiver, system sweeper | 15m | PYG-440 | 1. B checked in | 1. Produce non-caregiver check-outs 2. Inspect verdict | - Verdict not valid - Routes to review - Money does not release | PASS | QR, Payment, Security | system source → needs_review. Money path | Functional | High | Manual | Wasan. R | Wasan. R | | | | Y | Automated (e2e) | BE |
| PYG-440_19 | Monitoring > QR Check-in/out | Verify that every scan attempt is logged, including failures [QR][Audit] | 1 success + 3 distinct failures | 10m | PYG-440 | 1. Mix of success and rejections | 1. Perform the scans 2. Query JobScanEvent | - One row per attempt - Actor, booking, outcome, distinct reason | PASS | QR, Audit | Holds for attempts that reach the service (see F2) | Functional | Medium | Manual | Wasan. R | Wasan. R | | | | Y | Automated (e2e) | BE |
| PYG-440_20 | Monitoring > QR Check-in/out | Verify that a patient cannot scan to advance their own job [QR][Authz][Security] | Patient holds own QR | 5m | PYG-440 | 1. Patient shown the QR | 1. As the patient, call scan for B | - Rejected - Patient cannot advance - Rejection logged | FAIL | QR, Authz, Security | FORBIDDEN, not logged | Functional | High | Manual | Wasan. R | Wasan. R | | | F2 | Y | Automated (e2e) | BE |
| PYG-440_21 | Monitoring > QR Check-in/out | Verify that the scan response does not return raw storage paths [QR][DataLeak] | Check-out with photoUrl | 5m | PYG-440 | 1. B with job evidence attached | 1. Scan and inspect response | - photoUrl is a signed URL | FAIL | QR, DataLeak | Raw path returned (expected) | Functional | Low | Manual | Wasan. R | Wasan. R | | PYG-470 | Evidence for PYG-470; scope excluded (O3) | N | Automated (e2e) | BE |
| PYG-440_22 | Monitoring > QR Check-in/out | Verify that the QR window and single-use settings come from configuration [QR][Config] | Defaults; env override 15 / 5 / false | 10m | PYG-440 | 1. Current environment | 1. Read settings 2. Change and confirm behaviour | - Read from config - Behaviour follows | PASS | QR, Config | Defaults 60 / 120 / true / 60 | Functional | Medium | Manual | Wasan. R | Wasan. R | | PYG-441 | | Y | Automated (e2e) | BE |
| PYG-440_23 | Monitoring > QR Check-in/out | Verify that one QR serves the whole job and is not reissued per action [QR][BusinessRule] | Full check-in and check-out | 10m | PYG-440 | 1. B through full job | 1. Capture token 2. Check in, check out 3. Compare | - Same token works for both - No second QR row | FAIL | QR, BusinessRule | Same token rejected at check-out (PYG-437) | Functional | Medium | Manual | Wasan. R | Wasan. R | | PYG-437 | C1 spec conflict | Y | Automated (e2e) | BE |
| PYG-440_24 | Monitoring > QR Check-in/out | Verify that a booking with no accepted caregiver has no usable QR [QR][Lifecycle][Negative] | B pending, no caregiver | 5m | PYG-440 | 1. B not accepted | 1. Fetch or scan its QR | - No usable QR, or scan rejected | PASS | QR, Lifecycle, Negative | Scan → WRONG_CAREGIVER (O4) | Functional | Medium | Manual | Wasan. R | Wasan. R | | | | Y | Automated (e2e) | BE |

---

## 9. How to run

Same schema recipe as PYG-415 (`docs/qa/pyg-415-family-group-crud-report.md` §6). The migration chain can't be replayed from empty (it stops at migration #7, `kyc_verified_at already exists`), so the schema is built from `schema.prisma`.

```bash
# 1. disposable Postgres (localhost only)
docker run -d --rm --name pyg440-qa-pg -e POSTGRES_USER=qa -e POSTGRES_PASSWORD=qa \
  -e POSTGRES_DB=pyg440 -p 127.0.0.1:5438:5432 postgres:17

# 2. schema from schema.prisma (renders SQL only; never connects to a DB)
DATABASE_URL="postgresql://u:p@localhost:5999/none" \
  npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > /tmp/pyg440-schema.sql
docker exec -i pyg440-qa-pg psql -U qa -d pyg440 -v ON_ERROR_STOP=1 -1 < /tmp/pyg440-schema.sql

# 3. hand-written CHECKs for the job tables (copied from migrations 20260803000000 / 20260828000000 / 20260829000000)
docker exec -i pyg440-qa-pg psql -U qa -d pyg440 -v ON_ERROR_STOP=1 -1 <<'SQL'
ALTER TABLE "job_sessions" ADD CONSTRAINT "job_sessions_status_check" CHECK ("status" IN ('PENDING','CHECKED_IN','CHECKED_OUT'));
ALTER TABLE "job_sessions" ADD CONSTRAINT "job_sessions_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "job_sessions" ADD CONSTRAINT "job_sessions_valid_window_check" CHECK ("valid_until" > "valid_from");
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_event_type_check" CHECK ("event_type" IN ('check_in','check_out'));
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_source_check" CHECK ("source" IN ('caregiver','system'));
ALTER TABLE "job_scan_events" ADD CONSTRAINT "job_scan_events_action_check" CHECK ("action" IN ('CHECK_IN','CHECK_OUT','NONE'));
ALTER TABLE "job_scan_events" ADD CONSTRAINT "job_scan_events_result_check" CHECK ("result" IN ('SUCCESS','TOKEN_NOT_FOUND','NOT_A_CAREGIVER','WRONG_CAREGIVER','BOOKING_INACTIVE','OUT_OF_WINDOW','ALREADY_COMPLETED','TOO_SOON','DUPLICATE','WRONG_SEQUENCE','JOB_NOT_READY'));
SQL

# 4. REQUIRED: verify the job tables exist before running
docker exec pyg440-qa-pg psql -U qa -d pyg440 -tA -c \
  "select table_name from information_schema.tables where table_name in ('job_sessions','job_scan_events','job_events') order by 1"

# 5. run (DATABASE_URL and QR config env deliberately unset; cron flags unset)
env -u DATABASE_URL -u QR_VALID_FROM_OFFSET_MIN -u QR_VALID_UNTIL_GRACE_MIN -u QR_SINGLE_USE_PER_ACTION -u QR_MIN_SECONDS_BETWEEN_ACTIONS \
  PYG440_DATABASE_URL="postgresql://qa:qa@127.0.0.1:5438/pyg440" \
  npx jest --config ./test/jest-e2e.json --runInBand --forceExit test/qr-checkin-checkout

# 6. cleanup
docker stop pyg440-qa-pg
```

`--forceExit` is needed because `PrismaService` creates a `pg.Pool` that `$disconnect()` doesn't close.
