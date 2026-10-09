# PYG-427 · TC-BS-03/06 — Book on behalf · QA report

- Ticket: PYG-427 (QA) · Parent story: PYG-410 (FG-4, AC D1–D5) · **Model change: PYG-464** (merged; migration `20260911000000_pyg500_care_recipient_self_reported` deployed 11 Sep)
- Specs compared: PYG-410 description (D1–D5 + key invariant), PYG-464 description (AC) and its 2026-09-15 comment, and the sheet `PYG-427_BookOnBehalf_TestCases` (Google Drive, _01–_21). **Where the specs disagree, the merged code is treated as the truth, and the disagreement is reported in §3–§4.**
- Specs:
  - `test/booking-on-behalf.e2e-spec.ts` (TC _01–_30, _32–_35)
  - `test/booking-on-behalf.concurrency.e2e-spec.ts` (TC _31)
  - `test/support/booking-on-behalf-e2e.ts` (shared harness)
- Branch: `test/PYG-427-book-on-behalf` off `origin/dev`
- **Pinned regression commit: `0a6f1ec`** (origin/dev HEAD, which includes PYG-461/462 phase 1: `dd5c884`, `a7ecaf3`)
- Final run: 2026-09-15T13:02:41Z · Created By / Execute By: Wasan. R
- **Result: 27 PASS · 8 FAIL · 0 BLOCKED** (35 TCs: 21 from the sheet, of which 4 were rewritten, plus 13 new PYG-464 cases and 1 extra case, _35)

**What runs for real:** the app boots the actual `FamilyGroupModule`, which pulls in `BookingModule`, `PaymentModule`, `MonitoringModule` and `NotificationModule`. That means the real guards, resolvers, services, REST controller, payment FSM and event listeners, with Prisma against a **disposable Postgres 17 in Docker**. Self-booking goes through `POST /api/v1/bookings`; everything else goes through GraphQL.

**What is mocked:** only the three external services, `SupabaseService` (auth), `OmiseService` and `EmailService`. **No real Omise, Supabase or SMTP call is ever made.**

---

## 1. Baseline before / after

Measured in the worktree after `npm ci` and `prisma generate` (log line `✔ Generated Prisma Client (v6.19.3)`).

| Check | Before (`0a6f1ec`) | After (this branch) | Δ |
|---|---|---|---|
| `npx tsc --noEmit` | 19 errors | 19 errors, 0 in new files | 0 |
| `npm test` | 35 failed / 1071 | 35 failed / 1071 | 0 |
| `npm run test:e2e` (no test DB, local) | 1 failed / 29 (`app.e2e-spec`) | 1 failed / 64, 35 skipped | 0 failures added |
| PYG-427 specs against Docker DB | n/a | 27 passed / 8 failed | — |

| Run parameter | Value |
|---|---|
| Pinned regression commit | `0a6f1ec` — "self-booking behaviour today" is whatever this commit does, measured **in the same run** as each on-behalf case |
| `BOOKING_EXPIRY_CRON_ENABLED` | **unset** (not in the shell; also deleted by the harness before boot) |
| `HOLD_REFRESH_CRON_ENABLED` | **unset** (same) |
| Omise mode | **Mock**: `OmiseService` is overridden with jest fns and `OMISE_*` keys are unset. No sandbox keys were used |
| Connection guard | Reads only `PYG427_DATABASE_URL` and throws if the host isn't localhost. **Unset locally → the suite is skipped; unset with `CI` set → the suite fails.** Verified: `CI=1` → exit 1, `Test Suites: 2 failed`, message `PYG427_DATABASE_URL ไม่ได้ตั้งค่าใน CI` |

**FSM baseline note:** at `0a6f1ec`, `booking_status_history` is written **only** by the expiry cron (`booking-expiry.service.ts:191`). Creating, accepting, paying and capturing a booking never write it. So "FSM parity" is measured from the observed booking statuses plus `payment_status_history`.

---

## 2. Results

| TC_NO | Result | Evidence | Notes |
|---|---|---|---|
| _01 (rewritten) | PASS | 0 group profiles before booking. M books with `memberUserId = N` → booking `pending`, `caregiverId` = seeded caregiver, `family_group_id = G`, `care_recipient_id` not null | No recipient added beforehand (PYG-464) |
| _02 | PASS | `family_group_id = G` | |
| _03 (rewritten) | PASS | Exactly 1 profile for N in G; `booking.care_recipient_id` = that profile; `profile.patientId = N`; `booking.patientId = M` (the booker/payer) | |
| _04 | PASS | `member_details = {conditions:['เบาหวาน'], medicines:'metformin'}`; `booked_by = M`; `profile.patientId = N` ≠ `booked_by` | memberDetails holds the subject's details. The booker is identified by `booked_by`, not memberDetails |
| _05 | PASS | Exactly one `{actor: M, targetType: BOOKING, target: booking}` `BOOKING_ON_BEHALF` row | |
| _06 | PASS | N (subject) calling `createPayment` is rejected with 0 charges; M (booker) pays → payment `{patientId: M, held}`, `createCharge` +1; N has 0 payments | |
| _07 | **FAIL** | Hold path identical to self-booking: after accept + pay, the deltas are `createCharge 1 · createCustomerWithCard 0 · captureCharge 0`, the **same as self-booking**, and the payment is `held`. **But `chargesCreatedAtBookingTime = 0`** (the sheet expects 1) | **F4** (spec conflict). The card-vaulting worry doesn't apply at `0a6f1ec`: vaulting happens only when `saveCard=true` (§5) |
| _08 | PASS | On-behalf flow: booking `pending→accepted→confirmed→completed`; payment `null→held`, `held→captured`. **Equal to the pinned self-booking flow** | |
| _09 | PASS | On-behalf `{estimatedCost: 600, platformFee, paymentAmount: 600}` equals self-booking with the same caregiver and duration | 2 h × 300 |
| _10 | **FAIL** | Card declined at `createPayment`: on-behalf booking **persisted**, payment `failed`, `BOOKING_ON_BEHALF` activity 1, group profile 1, caregiver `booking_new` notification 1. **Self-booking with the same failure also persists** (`selfBookingPersistedAfterSameFailure: true`) | **F4**: on-behalf matches self-booking exactly; the sheet's expectation doesn't match the flow |
| _11 (rewritten) | PASS | Non-member subject via `memberUserId` → **`MEMBER_NOT_FOUND`**; out-of-group `careRecipientId` → **`RECIPIENT_NOT_IN_GROUP`**. Bookings, payments, activity, group profiles and charges unchanged; the outsider's profile is untouched | **F7**: D4 names only `RECIPIENT_NOT_IN_GROUP` |
| _12 | PASS | Non-member → **`NOT_A_MEMBER`**, `data=null`, no side effects | |
| _13 | PASS | Unknown `careRecipientId` → `RECIPIENT_NOT_IN_GROUP`; unknown `memberUserId` → `MEMBER_NOT_FOUND`; neither sent → `RECIPIENT_NOT_IN_GROUP`; no side effects | |
| _14 (rewritten) | PASS | M in G1 booking N (G2): under G1 with `memberUserId` → `MEMBER_NOT_FOUND`; under G2 → `NOT_A_MEMBER`; under G1 with N's G2 profile → `RECIPIENT_NOT_IN_GROUP`. No side effects in either group | **F7** |
| _15 | **FAIL** | Caregiver gets exactly 1 `booking_new` notification with the same title as self-booking. Body: "มีคำขอจองใหม่ บริการดูแลทั่วไป วันที่ … — แตะเพื่อดูรายละเอียดและตอบรับ"; `data: {link, source, bookingId}`. **No recipient name** | **F6**. UI half: NOT COVERED (FE) |
| _16 | PASS | On-behalf `['pending','accepted','confirmed']` equals self-booking | The caregiver's action is `acceptBooking` → `accepted`; `confirmed` only comes after the booker pays (§4 F4) |
| _17 | **FAIL** | Held on-behalf booking, caregiver `declineBooking` → rejected: "Only bookings with status \"pending\" can be declined"; booking stays `confirmed`, payment stays `held`, 0 Omise void/reverse calls. Declining a `pending` booking works (`rejected`) | **F4**: under the current FSM there is never a hold while a booking is pending |
| _18 | PASS | REST self-booking → 201, `pending`, `patientId = self`, `family_group_id`, `care_recipient_id` and `booked_by` all null | |
| _19 | PASS | Self-booking booking and payment status sequences equal the pinned flow `0a6f1ec` (see _08) | |
| _20 | PASS | 0 activity rows targeting the self-booking | |
| _21 | PASS | `member_details`, `family_group_id`, `care_recipient_id` all null | |
| _22 | PASS | `groupBookings(G)` returns exactly `[{id, careRecipientName: 'คุณแม่ ทดสอบ', bookedByUserId: M, bookedByMe: true}]`; `family_group_id = G` | **The PYG-464 defect is fixed** |
| _23 | PASS | M books for M through the group → `family_group_id = G`, `profile.patientId = M`, and the booking appears in `groupBookings` | |
| _24 | PASS | Branch ①: an existing group profile is reused (`care_recipient_id` = existing id); N's profile count in G stays 1 | |
| _25 | PASS | Branch ②: the personal profile is copied into G with `self_reported = true` and the medical fields copied; new id ≠ personal id; **personal row identical** before and after | |
| _26 | PASS | Branch ③: profile `{name, self_reported: false, medical_conditions, current_medications, allergies, care_notes}` taken from `patientName` + `memberDetails` | |
| _27 | PASS | No `patientName` → **`PATIENT_NAME_REQUIRED`**; no booking, payment, activity or profile; charges unchanged | |
| _28 | PASS | Membership `REMOVED` → **`MEMBER_NOT_FOUND`**; no side effects | |
| _29 | PASS (API half) | Two on-behalf payload shapes (search-result caregiver / caregiver-profile caregiver) → both `family_group_id = G`; the second reuses the first's profile | The backend has one entry point (`createBookingOnBehalf`). SearchPage vs CaregiverProfilePage: **NOT COVERED (FE)** |
| _30 | PASS | Member P sees exactly `[id]` with `bookedByMe=false`. Outsider → **`NOT_A_MEMBER`**, `data=null`, and the response contains no recipient name, health text or booking id | |
| _31 | **FAIL** | 5 rounds, each with 2 parallel on-behalf bookings for N (no profile yet). Every booking succeeded, but N's group profile count per round = **`[1, 2, 2, 2, 2]`** (run 2026-09-15T13:01:31Z); the final run also failed | **F1**. Expected failure (PYG-464 comment ⚠️3) |
| _32 | **FAIL** | GraphQL `memberDetails.medicines`/`allergies`: 1000 → OK, 1001 → `BAD_REQUEST`, **2000 → `BAD_REQUEST`**. REST `patientProfile.medicines`/`allergies`: 2000 → 201, 2001 → 400 | **F5**. FE limit: NOT COVERED (FE; no FE code in this repo) |
| _33 | PASS | `careRecipientId` only (a group profile of N) → booking `{family_group_id: G, care_recipient_id: profile, booked_by: M}`; 1 activity row | Backward-compatible path works |
| _34 | **FAIL** | **(a) hold failure:** booking 1, activity 1, profile 1 (the F4 flow, same as _10). **(b) booking-record failure after profile resolution** (caregiver doesn't exist): bookings **0**, activity **0**, but **group profile for N = 1** | **F2** (b is a genuine orphan) + **F4** (a) |
| _35 (added) | **FAIL** | A caregiver-role (role 2) group member books on behalf → OK; the caregiver accepts; the member calls `createPayment` → **"Access denied. Required role: 1"** | **F3** |

No domain code was replaced by a generic `BAD_REQUEST` in this suite. `MEMBER_NOT_FOUND`, `PATIENT_NAME_REQUIRED`, `RECIPIENT_NOT_IN_GROUP` and `NOT_A_MEMBER` were each returned exactly, so the PYG-415 validation finding does **not** recur here. The only `BAD_REQUEST` responses are genuine field-length violations (_32), for which no domain code exists.

---

## 3. AC coverage matrix

### PYG-410 (FG-4) — D1–D5 and key invariant

| AC | Requirement (as written) | TC_NO | Status | Conflict with PYG-464 / code |
|---|---|---|---|---|
| **D1** | Member selects a **care recipient in the group** and fills in condition/details; the booking's subject is the recipient | _01, _23, _24, _25, _26, _33 | ✅ pass | ⚠️ **Conflicts:** PYG-464 replaced "select a group care recipient" with "select a **member**", so nothing has to be added beforehand. The code accepts `memberUserId` (new) or `careRecipientId` (legacy) |
| **D2** | `family_group_id` + `care_recipient_id` + memberDetails persisted | _02, _03, _04, _21 | ✅ pass | ⚠️ `care_recipient_id` is now the **resolved** profile (branch ①/②/③), not a pre-existing recipient R |
| **D3** | Booker is the paying user; the existing hold/capture flow is used as-is | _06, _07, _08, _09, _16, _19, _35 | ⚠️ _06 _08 _09 _16 _19 pass · _07 FAIL (F4) · _35 FAIL (F3) | The flow **is** reused as-is (_07 path parity, _08 = _19). But "as-is" puts the hold after caregiver acceptance, not at booking time, and caregiver-role bookers can't use it (F3) |
| **D4** | Recipient outside the group → `RECIPIENT_NOT_IN_GROUP` | _11, _13, _14 | ✅ pass against code | ⚠️ **Conflicts:** on the `memberUserId` path the code returns **`MEMBER_NOT_FOUND`**. Only the legacy `careRecipientId` path returns `RECIPIENT_NOT_IN_GROUP` (F7) |
| **D5** | Caregiver notification/confirmation flow unchanged | _15, _16, _17 | ⚠️ _16 pass · _15 FAIL (F6) · _17 FAIL (F4) | The notification is identical to self-booking (unchanged ✔), but the sheet additionally expects the recipient to be named. Decline can't release a hold that doesn't exist yet |
| Key invariant | Payment path unchanged; only `family_group_id`, `care_recipient_id`, memberDetails added | _07, _08, _10, _18–_21 | ✅ parity holds wherever it's comparable | ⚠️ PYG-464 also adds `booked_by`, a group patient profile and `self_reported`, so "only three fields" is no longer literally true |

### PYG-464 — acceptance criteria

| AC | Requirement | TC_NO | Status |
|---|---|---|---|
| 464-1 | Booking on behalf by selecting a member → `familyGroupId` tagged **and appears in the group feed** | _01, _02, _22 | ✅ pass (the fixed defect) |
| 464-2 | Every member can book on behalf, **including themselves**, with no recipient added beforehand | _01, _23, _29, _30 | ✅ pass · ⚠️ a caregiver-role member can book but **can't pay** (_35, F3) |
| 464-3 | Member has existing data → reuse it, "ข้อมูลจากเจ้าตัว" label (`self_reported=true`) | _24, _25 | ✅ API/DB pass · label: NOT COVERED (FE) |
| 464-4 | Member has no data → booker fills it in, "คุณกำลังกรอกให้" label + confirmation checkbox (`self_reported=false`) | _26, _27 | ✅ API/DB pass · label and checkbox: NOT COVERED (FE) |
| 464-5 | Both SearchPage and CaregiverProfilePage bind the group | _29 | ⚠️ API half pass · page distinction NOT COVERED (FE) |
| 464 rules | Subject must be an ACTIVE member (`MemberNotFoundError`); name required in branch ③ (`PATIENT_NAME_REQUIRED`); `patientId` of profile = subject | _03, _11, _13, _14, _27, _28 | ✅ pass |
| 464 comment ⚠️3 | Concurrent bookings may duplicate group profiles | _31 | ❌ confirmed (F1) |
| 464 follow-up | memberDetails length FE/BE mismatch | _32 | ❌ confirmed server-side (F5) |
| 464 invariant | Visibility: all ACTIVE members see group bookings; non-members don't | _30 | ✅ pass |
| (integrity) | Failed attempt leaves no orphan profile | _10, _34 | ❌ F2 (+ F4) |

---

## 4. Product findings (not fixed)

### F1 — Concurrent on-behalf bookings create duplicate group patient profiles · suggested severity: **Medium** (data integrity)

- **Spec:** one group patient profile per member per group (implied by branch ① "reuse"). The PYG-464 comment ⚠️3 flagged this risk.
- **Code:** `resolveGroupPatientProfile()` (`src/booking/booking.service.ts:311`) does `findFirst` (`:325`) and then `create` (`:338` / `:378`) with no lock, outside any transaction. `care_recipients` has **no** unique index covering `(patient_id, family_group_id)`; verified on the test schema, 0 such indexes.
- **Evidence:** in _31, 2 parallel bookings for N in each of 5 rounds gave profile counts **`[1, 2, 2, 2, 2]`**, and all 10 bookings succeeded, each linked to a different copy.
- **Impact:** later reads pick the most recent profile (`orderBy updated_at desc`), so the other copy and the bookings pointing to it drift apart. Health details can split across two rows.
- **Fix direction** (needs a migration, which Sammy runs): a partial unique index on `(patient_id, family_group_id) WHERE family_group_id IS NOT NULL AND NOT is_deleted`, plus upsert or catching the conflict on create.

### F2 — A failed on-behalf booking leaves an orphan group patient profile · suggested severity: **Medium** (integrity; stores health data typed by someone else with no booking behind it)

- **Spec:** the PYG-427 brief for _34 says "no orphan care-recipient profile created by the failed attempt"; the sheet's _10 has the same integrity intent.
- **Code:** the profile is resolved **before and outside** the booking transaction (`booking.service.ts:256` resolve → `:281` `createBookingRecord`). The comment at `:308` says this is intentional ("โปรไฟล์กลุ่มที่ค้างโดยไม่มี booking ไม่เป็นอันตราย"). Any failure inside `createBookingRecord` afterwards leaves the profile behind: caregiver not found or unavailable, a time conflict, a transaction error.
- **Repro:** `createBookingOnBehalf(input: {groupId: G, memberUserId: N, patientName: "…", caregiverId: <non-existent uuid>, …})` → error, 0 bookings, 0 activity, **1 new profile for N in G** (_34b).
- **Related:** combined with PYG-477, a booker-typed orphan (`self_reported=false`) can later be treated as N's personal profile and copied with the label "ข้อมูลจากเจ้าตัว".

### F3 — Caregiver-role group members can book on behalf but can't pay · suggested severity: **High** (the flow dead-ends; the booking can never be confirmed)

- **Intent:** `FamilyBookingResolver` deliberately allows any role, so caregivers can book for their own parents (`src/family-group/family-booking.resolver.ts:36–39`). PYG-464-2 says every member can book.
- **Code:** `createPayment` has `@Roles(ROLE_ID.PATIENT)` (`src/payment/payment.resolver.ts:37`), and `booking.patientId` = the booker. Nobody else is allowed to pay (`payment.service.ts:268`).
- **Repro (_35):** a role-2 member books on behalf (OK) → the caregiver accepts (OK) → the member calls `createPayment` → "Access denied. Required role: 1". The booking stays `accepted` until the payment deadline passes.

### F4 — The sheet assumes the Omise hold is placed when the booking is created; the existing flow places it after caregiver acceptance · suggested severity: **spec conflict — needs a QA/PO decision, not an on-behalf defect**

- **Sheet:** _07 "Omise hold is created at booking time"; _10 "failed hold → no booking persisted, no activity, caregiver not notified"; _17 "caregiver declines a held, pending booking → hold voided"; _34(a) likewise.
- **Code at `0a6f1ec`**, identical for self-booking and on-behalf:
  1. The booking is created as `pending` (`family-booking.resolver.ts:88`: "★ ยังไม่รวมขั้นตอนจ่ายเงิน — จ่ายเป็น step แยกเหมือนการจองปกติทุกประการ").
  2. The caregiver accepts: `pending→accepted`.
  3. The booker calls `createPayment`, allowed only from `accepted` (`payment.service.ts:270`): Omise authorize → payment `held`, booking `confirmed`.
  4. Decline is allowed only from `pending` (`caregiver-booking.service.ts:313`), when no hold can exist.
  5. A declined card records a `failed` payment and the booking stays `accepted`.
- **Evidence:** in _10, self-booking behaves exactly the same (`selfBookingPersistedAfterSameFailure: true`). _07 confirms the on-behalf hold path equals the self-booking path.
- **Why it isn't a defect:** D3 and the key invariant require the existing flow unchanged, and that's what the code does. The sheet cases _07, _10, _17 and _34(a) should be rewritten against the two-step flow, or the product decides to change the flow. I'm not picking one.

### F5 — memberDetails length limits differ between the two paths that write the same column · suggested severity: **Medium** (contract)

- **Spec:** PYG-464 follow-up: "เพดานความยาว `memberDetails` FE/BE ยังไม่ตรงกัน (medicines/allergies 1000 vs 2000)".
- **Code:**
  - GraphQL `MemberDetailsInput.medicines` / `.allergies` → `@MaxLength(1000)` (`src/family-group/dto/create-booking-on-behalf.input.ts:42,48`)
  - REST `patientProfile.medicines` / `.allergies` → 2000 (`src/booking/dto/patient-profile.type.ts`)

  Both write `bookings.member_details`.
- **Evidence (_32):** 1500–2000-character medicines text is accepted by REST self-booking but rejected by on-behalf booking with `BAD_REQUEST`.
- The FE limit couldn't be checked from this repo.

### F6 — Caregiver's new-booking notification doesn't name the recipient · suggested severity: **Low** (spec gap; possibly deliberate for privacy)

- **Sheet _15:** "Notification reflects the recipient as the service subject".
- **Code:** the `booking_new` body template (`src/notification/listeners/booking-notification.listener.ts:103`) includes only service and date, the same for self-booking and on-behalf. `data` = `{link, source, bookingId}`.
- **Decide:** is omitting the name intentional (PDPA), or should the sheet or code change?

### F7 — PYG-410 D4 names one error code; the merged code uses two · suggested severity: **Low** (AC out of date)

- **D4:** "recipient outside the group → `RECIPIENT_NOT_IN_GROUP`".
- **Code:**
  - `memberUserId` path → **`MEMBER_NOT_FOUND`** (non-member, removed member, unknown id, cross-group)
  - `careRecipientId` path → `RECIPIENT_NOT_IN_GROUP`
  - A new branch-③ rule → `PATIENT_NAME_REQUIRED`

  Evidence: _11, _13, _14, _27, _28.
- **Documentation drift:**
  - The `createBookingOnBehalf` resolver description (`family-booking.resolver.ts:88`) still mentions only `NOT_A_MEMBER` / `RECIPIENT_NOT_IN_GROUP`.
  - The DTO class comment (`create-booking-on-behalf.input.ts:67`) still says `patientName` is deliberately absent, although the field now exists.
  - The `serviceType` example `"elderly_care"` (`:138`) isn't a valid `booking_service_type` value; valid values are `general_care | bedridden_care | physiotherapy | medication | companion`.

---

## 5. Config and schema values read

| Item | Value | Source |
|---|---|---|
| `care_recipients.self_reported` | `boolean NOT NULL DEFAULT true` | Verified on the test schema (`information_schema`) before running; matches `schema.prisma` and the PYG-464 migration |
| Unique index on `care_recipients (patient_id, family_group_id)` | **none** | `pg_indexes` on the test schema (relevant to F1) |
| memberDetails limits: GraphQL (on-behalf) | `conditions`: array, no length cap · `medicines` 1000 · `allergies` 1000 · `careInstructions` 2000 | DTO + _32 |
| memberDetails limits: REST (self-booking `patientProfile`) | `medicines` 2000 · `allergies` 2000 | _32 (2000 → 201, 2001 → 400) |
| memberDetails limits: FE | **Not checked** (no FE code in this repo) | — |
| Omise mode | **Mock** (no sandbox keys; `OMISE_*` unset) | Harness |
| Card vaulting on the hold path | `createCustomerWithCard` only when `CreatePaymentInput.saveCard = true` (default `false` → `createCharge`) | `payment.service.ts:377–388`; _07 shows 0 vaulting calls on both paths |
| Cron flags | `BOOKING_EXPIRY_CRON_ENABLED` unset · `HOLD_REFRESH_CRON_ENABLED` unset | Shell env + harness |
| Seeded caregiver rate | 300 THB/h (_29 also uses 450) | Harness |
| Migrations sharing timestamp `20260911000000` | `pyg461_booking_status_history` and `pyg500_care_recipient_self_reported` | Different tables, so order doesn't matter. The test schema is built from `schema.prisma`, not the migration chain, so no ordering applies here |

---

## 6. Questions / assumptions

1. **F4:** should _07, _10, _17 and _34(a) be rewritten to the two-step flow (booking → accept → pay), or does product want the hold at booking time? I didn't assert either as correct.
2. **F3:** is paying restricted to role PATIENT on purpose? If so, should `createBookingOnBehalf` also require PATIENT, contradicting the resolver's stated intent?
3. **F7:** update D4 to list `MEMBER_NOT_FOUND` and `PATIENT_NAME_REQUIRED`?
4. **F6:** should the caregiver notification name the recipient, given the PDPA work in PYG-426?
5. **F1/F2** probably belong in one card: move profile resolution into the booking transaction and add a unique index. The index needs a migration, which only Sammy can apply.
6. **Assumptions:**
   - Members, caregivers, removed memberships and pre-existing profiles are seeded directly with Prisma; groups are created through the API.
   - Omise responses are mocked, so real card-network behaviour (3-D Secure, partial auth) isn't covered.
   - "Two entry points" (_29) can only be simulated as two payload shapes, because the backend exposes a single mutation.
   - RLS policies and the Supabase schemas aren't in the test DB. The backend connects as the table owner, so API behaviour doesn't depend on them.

---

## 7. How to run

Same recipe as PYG-415 (`docs/qa/pyg-415-family-group-crud-report.md` §6). The migration chain can't be replayed from empty (it stops at migration #7, `kyc_verified_at already exists`), so the schema is built from `schema.prisma`.

```bash
# 1. disposable Postgres (localhost only)
docker run -d --rm --name pyg427-qa-pg -e POSTGRES_USER=qa -e POSTGRES_PASSWORD=qa \
  -e POSTGRES_DB=pyg427 -p 127.0.0.1:5436:5432 postgres:17

# 2. schema from schema.prisma (renders SQL only; never connects to a DB)
DATABASE_URL="postgresql://u:p@localhost:5999/none" \
  npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > /tmp/pyg427-schema.sql
docker exec -i pyg427-qa-pg psql -U qa -d pyg427 -v ON_ERROR_STOP=1 -1 < /tmp/pyg427-schema.sql

# 3. hand-written family-group CHECKs + partial unique indexes: identical block to PYG-415 report §6 step 3

# 4. REQUIRED: verify self_reported exists before running (otherwise every branch test is a false result)
docker exec pyg427-qa-pg psql -U qa -d pyg427 -tA -c \
  "select data_type, is_nullable, column_default from information_schema.columns where table_name='care_recipients' and column_name='self_reported'"
# expected: boolean|NO|true

# 5. run (DATABASE_URL and Omise keys deliberately unset; cron flags unset)
env -u DATABASE_URL -u OMISE_SECRET_KEY -u OMISE_PUBLIC_KEY \
  PYG427_DATABASE_URL="postgresql://qa:qa@127.0.0.1:5436/pyg427" \
  npx jest --config ./test/jest-e2e.json --runInBand --forceExit test/booking-on-behalf

# 6. cleanup
docker stop pyg427-qa-pg
```

`--forceExit` is needed because `PrismaService` creates a `pg.Pool` that `$disconnect()` doesn't close.

**Harness note:** `EmailService` is mocked with a `Proxy`. That proxy must **not** answer `then` or lifecycle-hook names; otherwise Nest treats it as a Promise and app init hangs until the 90 s hook timeout.
