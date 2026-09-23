# PYG-423 · TC-BS-07 — Activity feed + member-only access · QA report

- Ticket: PYG-423 (QA) · Parent story: PYG-409 (FG-3, **stretch**, AC-BS-07)
- Specs used:
  - AC-BS-07 (PYG-409 description)
  - **Both PYG-423 comments of 2026-09-02**, which bring in SCR-FG2-001 (email invites replaced by join links)
  - The PYG-408 thread (B1–B10)
  - PYG-464 ("a group member is the patient")
  - **Where the sheet disagrees with the comments or merged code, the comments and code win, and the disagreement is reported (§5).**
- Test sheet: tab `[PYG-423]` in `Testcase_Payung` (Google Drive), _01–_21
- Specs:
  - `test/family-group-activity-feed.e2e-spec.ts`
  - `test/support/activity-feed-e2e.ts` (shared harness)
- Branch: `test/PYG-423-activity-feed` off `origin/dev` @ `0a6f1ec`
- Final run: 2026-09-15T13:32:18Z · Created By / Execute By: Wasan. R
- **Result: 26 PASS · 3 FAIL · 1 BLOCKED · 1 deleted (_17)** (30 `it()` blocks)

**What runs for real:** the tests call the GraphQL API through supertest. The app boots the whole real `FamilyGroupModule`, which brings in Booking, Payment, Monitoring and Notification, because _18, _19 and _27 need the real `createBookingOnBehalf`. The guard chain is the real one (`SupabaseAuthGuard → RolesGuard → FamilyGroupGuard`), with Prisma against a **disposable Postgres 17 in Docker**.

**What is mocked:** only `SupabaseService` (auth), `OmiseService` (it throws if called; no case reaches payment) and `EmailService`.

**Controlled timestamps:** ordering and pagination cases seed a group directly in the DB, with every activity row's `created_at` set explicitly, so they never depend on wall-clock timing.

---

## 1. Baseline before / after

Measured in the worktree after `npm ci` and `prisma generate` (log line `✔ Generated Prisma Client (v6.19.3)`).

| Check | Before (`0a6f1ec`) | After (this branch) | Δ |
|---|---|---|---|
| `npx tsc --noEmit` | 19 errors | 19 errors, 0 in new files | 0 |
| `npm test` | 35 failed / 1071 | 35 failed / 1071 | 0 |
| `npm run test:e2e` (no test DB, local) | 1 failed / 29 (`app.e2e-spec`) | 1 failed / 59, 30 skipped | 0 failures added |
| PYG-423 spec against Docker DB | n/a | 26 passed / 3 failed / 1 skipped | — |

**Connection guard:** the spec reads only `PYG423_DATABASE_URL` and throws if the host isn't localhost. **Unset locally → skipped; unset with `CI` set → fails.** Verified: `CI=1` → exit 1, `Test Suites: 1 failed`, message `PYG423_DATABASE_URL ไม่ได้ตั้งค่าใน CI`.

**Schema verified before running**, on the test DB (built from `schema.prisma` plus the hand-copied family-group constraints, PYG-415 §6):
- `family_group_activity_group_id_created_at_idx` = `btree (group_id, created_at DESC, id DESC)` ✔ (the keyset index)
- `family_group_activity_pkey` = `btree (id)`
- `id uuid DEFAULT gen_random_uuid()` · `created_at timestamptz DEFAULT CURRENT_TIMESTAMP` · `metadata jsonb DEFAULT '{}'`

The **production** database has the same keyset index (read-only catalog query, §4 TC_29).

---

## 2. Activity action names in the code

Every emission test asserts a name from this list. Source: `src/family-group/family-group.constants.ts:55–76` (`ACTIVITY_ACTION`), matching DB CHECK `family_group_activity_action_check` (migration `20260902000000`).

| # | Action | Origin | Status in code |
|---|---|---|---|
| 1 | `GROUP_CREATED` | PYG-412 | emitted by `createFamilyGroup` |
| 2 | `GROUP_RENAMED` | PYG-412 | emitted by `renameFamilyGroup` |
| 3 | `MEMBER_INVITED` | v1.0 | **@deprecated** (SCR-FG2-001); no emitter |
| 4 | `INVITE_REVOKED` | v1.0 | **@deprecated**; no emitter |
| 5 | `JOIN_LINK_CREATED` | PYG-416 | emitted by `createJoinLink`, and by `rotateJoinLink` when no link existed |
| 6 | `JOIN_LINK_ROTATED` | PYG-416 | emitted by `rotateJoinLink` |
| 7 | `JOIN_LINK_REVOKED` | PYG-416 | emitted by `revokeJoinLink` |
| 8 | `MEMBER_JOINED` | PYG-417 | emitted by `joinGroupByLink` (also on re-join) |
| 9 | `MEMBER_REJOINED` | PYG-417 | **declared, never emitted** (service header note) |
| 10 | `MEMBER_LEFT` | PYG-412 | emitted by `leaveFamilyGroup` |
| 11 | `MEMBER_REMOVED` | PYG-412 | emitted by `removeMember` |
| 12 | `OWNERSHIP_TRANSFERRED` | PYG-412 | emitted by `transferOwnership` |
| 13 | `RECIPIENT_ADDED` | PYG-424 | **declared, never emitted** (F2) |
| 14 | `RECIPIENT_UPDATED` | PYG-424 | **declared, never emitted** (F2) |
| 15 | `RECIPIENT_REMOVED` | PYG-424 | **declared, never emitted** (F2) |
| 16 | `BOOKING_ON_BEHALF` | PYG-424 | emitted inside the `createBookingOnBehalf` transaction |

**`INVITE_SENT` and `BOOKING_CREATED` don't exist** in the code or the DB CHECK.

---

## 3. Results

| TC_NO | Result | Evidence | Notes |
|---|---|---|---|
| _01 | PASS | 3 seeded rows at +0/+10/+20 min, then a real rename → feed `[GROUP_RENAMED(now), +20, +10, +0]`; `created_at` strictly descending | |
| _02 (rewritten) | PASS | Rename → node[0] `{action: GROUP_RENAMED, actor: {userId: owner, displayName}}`, `createdAt` within the request window ±1 s. `createJoinLink` → node[0] `{action: JOIN_LINK_CREATED, actor: owner}`, same timing check. Both names are in §2 | Sheet used "send invite" / `INVITE_SENT`, which don't exist (C1) |
| _03 | PASS | 2 rows with identical `created_at` → same order on 2 calls, equal to `id DESC`. **Id column = `uuid` with `gen_random_uuid()` (v4, random)** | The tiebreak is deterministic but **not chronological**; see O1 |
| _04 | PASS | 12 rows, `first:5` → exactly the 5 newest; `pageInfo = {endCursor: cursor of 5th, hasNextPage: true}` | |
| _05 | PASS | Page 2 via `endCursor` = expected rows 6–10; no overlap with page 1; page 1 + page 2 = the first 10 exactly (no gap) | |
| _06 | PASS | Fetch page 1, insert a row newer than all others, then page 2 with the page-1 cursor still = rows 6–10 exactly (an offset-based feed would repeat row 5) | Proves the cursor is anchored, not offset |
| _07 | PASS | Page sizes `[5, 5, 2]`, all 12 ids in order; final `hasNextPage=false`. The final `endCursor` is still set (Relay `pageInfo`), and paging with it returns `[]` with `hasNextPage=false` | The sheet says "nextCursor null/empty"; the API signals the end with `hasNextPage` (C3) |
| _08 | **FAIL** | 6 tampered cursors: `notBase64`, `garbage`, `emptyId`, `tooManyParts`, `badDate` → **`ACTIVITY_CURSOR_INVALID`** ✔. **`nonUuidId`** (`base64url("2026-01-01T00:00:00.000Z\|not-a-uuid")`) → **`INTERNAL_SERVER_ERROR`**. No rows returned, no other group's ids leaked, no rows written | **F1** |
| _09 | PASS | Member row asserted `{status: ACTIVE, role: MEMBER}`; `first:50` returns all 12 seeded ids in order | |
| _10 | PASS | Non-member → **`NOT_A_MEMBER`**, `data=null`, no seeded ids in the body, row count unchanged | |
| _11 | PASS | No token and an invalid token → both **`UNAUTHENTICATED`**, `data=null`, no ids | |
| _12 | PASS | G2 member reading G1 → **`NOT_A_MEMBER`**, no G1 ids | |
| _13 | PASS | Member reads OK → owner `removeMember` → the same member gets **`NOT_A_MEMBER`** | |
| _14 | PASS | Member reads OK → `leaveFamilyGroup` → **`NOT_A_MEMBER`** | |
| _15 | PASS | Member reads OK → removed. **The same token still authenticates** (`myFamilyGroups` → `[]`, no error), but the feed → **`NOT_A_MEMBER`** | Membership is re-checked per request (guard `findUnique` on `(group_id, user_id)`); the cache lives only inside one request |
| _16 | PASS | `createFamilyGroup` → the group's activity rows = exactly `[{GROUP_CREATED, actor: creator}]` | |
| _17 | **DELETED** | — | Invites no longer exist (SCR-FG2-001). `inviteMember` / `revokeInvite` / `acceptInvite` aren't in the GraphQL schema. Replaced by _22–_25 |
| _18 (rewritten) | **FAIL** | An explicit reachable mutation exists (`addGroupCareRecipient` / `updateGroupCareRecipient`, `family-booking.resolver.ts`), so it was tested, not marked BLOCKED. **Add → `RECIPIENT_ADDED` rows: 0; update → `RECIPIENT_UPDATED` rows: 0.** Implicit path (PYG-464) `createBookingOnBehalf` → `BOOKING_ON_BEHALF`: 1 and `RECIPIENT_ADDED`: 0 ✔ | **F2**. The `recipientRowsFromImplicitProvisioning: -1` in the failure diff is an artifact of subtracting 1 from a total of 0; the real count of recipient rows is 0 |
| _19 (rewritten) | PASS | `createBookingOnBehalf` → exactly `[{action: BOOKING_ON_BEHALF, actor: booker, target: booking}]`; `BOOKING_ON_BEHALF` ∈ §2 and `BOOKING_CREATED` ∉ §2 | **C2**: the code agrees with PYG-427_05; PYG-423's sheet is wrong |
| _20 | PASS | A temporary trigger makes the activity insert fail for G only → rename returns an error; group name unchanged; row count unchanged; no `GROUP_RENAMED` in the feed | Proves the activity row is written inside the mutation's transaction |
| _21 | **BLOCKED** | — | No family-group mutation accepts an idempotency key (`grep -i idempot src/family-group` finds only a comment about repeated link clicks being a no-op). Idempotency exists only for payments (PYG-375). Not fabricated |
| _22 | PASS | `createJoinLink` ×2 (the second returns the existing link) → `JOIN_LINK_CREATED` rows = exactly `[{actor: owner, targetType: JOIN_LINK}]` | Replaces _17 |
| _23 | PASS | Create, then rotate → `{JOIN_LINK_CREATED: 1, JOIN_LINK_ROTATED: 1, JOIN_LINK_REVOKED: 0}` | By design, the implicit revoke inside rotate writes **no** separate revoke row (`rotateJoinLink` writes one activity row) |
| _24 | PASS | Create, then revoke → `JOIN_LINK_REVOKED` rows = exactly `[{actor: owner}]` | |
| _25 | **FAIL** | Join via link → exactly 1 `MEMBER_JOINED` row, actor = joiner ✔. **Metadata keys = `["joinedViaLinkId"]`**; `linkId` is absent. The value equals the link used | **F3**: key name differs from the 2026-09-02 comment |
| _26 | PASS | Create → rotate → revoke → create → join; the feed as an ordinary member contains all four link actions, and the payload contains **none** of: 3 link URLs, 3 raw tokens, the `token_hash` values, `token_raw` values, `token=`, or the base URL | |
| _27 | PASS | On-behalf booking with conditions/medicines/allergies/careInstructions → member P's feed: booking event actor = booker, **metadata keys exactly `[bookingDate, recipientName, startTime]`**, and none of the 4 health strings anywhere in the payload | Exposed: the recipient's name, booking date and start time |
| _28 | PASS | Schema introspection: **0** mutations matching `/activity/i`; `deleteFamilyGroupActivity` / `updateFamilyGroupActivity` → `GRAPHQL_VALIDATION_FAILED`; rows identical before and after | Append-only **through the API**. No DB-level trigger; see O2 |
| _29 | PASS | Repo migrations (comments stripped): `family_group_activity` is **not** added to `supabase_realtime`, and `ENABLE ROW LEVEL SECURITY` is present. **Production, read-only catalog query:** table not in any publication; `relrowsecurity=true`; policy `family_group_activity_select_members` (SELECT) | Safe state: not published, RLS on (migration `20260824000000` §7 says realtime was deliberately left out) |
| _30 | PASS | M is in G1 and G2 with interleaved timestamps; G2 queried with G1's page-1 cursor → 0 G1 ids; every returned id belongs to G2 | Scoped by the query's `groupId` filter; the cursor carries no group, see O3 |
| _31 | PASS | Membership rows with `LEFT` and `REMOVED` → both **`NOT_A_MEMBER`**, `data=null`, no ids | Reads require an ACTIVE row, not just any row |

**No generic `BAD_REQUEST` appeared instead of a domain code.** The feed query has no class-validator arguments, and every rejected cursor except the non-UUID one got `ACTIVITY_CURSOR_INVALID`. The PYG-415 pattern does **not** recur. _08's failure is a different defect (F1).

---

## 4. AC coverage matrix

| Source | Requirement | TC_NO | Status |
|---|---|---|---|
| AC-BS-07 | Paginated feed, **newest first**, keyset on `created_at DESC` | _01, _03, _04, _05, _06, _07, _30 | ✅ pass (keyset index verified) |
| AC-BS-07 | Invalid cursor rejected safely | _08 | ❌ F1 (one variant → 500) |
| AC-BS-07 | **Only ACTIVE members can read** | _09, _10, _11, _12, _13, _14, _15, _31 | ✅ pass |
| AC-BS-07 | Each entry shows **actor, action, timestamp** | _01, _02, _16, _22, _24, _25 | ✅ pass |
| AC-BS-07 notes | Activity rows **written in the same transaction** as each change | _20, (_19 via on-behalf tx) | ✅ pass |
| AC-BS-07 notes | Every covered mutation writes activity (group / recipient / booking) | _16, _18, _19 | ⚠️ _16 _19 pass · **_18 FAIL (F2)** |
| AC-BS-07 notes | **Append-only** feed | _28 | ✅ pass through the API (O2) |
| AC-BS-07 notes | Realtime only with RLS | _29 | ✅ pass (not published; RLS on) |
| AC-BS-07 notes | Idempotent retry → one row | _21 | ⏸ BLOCKED (no mechanism) |
| **Comment 2026-09-02 ①** | Emission checked against `createJoinLink / rotateJoinLink / revokeJoinLink / joinGroupByLink` instead of invites | _22, _23, _24, _25 (replacing _17) | ✅ _22 _23 _24 pass · _25 FAIL on the metadata key (F3) |
| **Comment 2026-09-02 ②** | Feed never shows the join token or full link URL | _26 | ✅ pass |
| **Comment 2026-09-02 ③** | Joining via link → **one `MEMBER_JOINED` row with `linkId` in metadata** | _25 | ❌ F3 (row ✔, key is `joinedViaLinkId`) |
| PYG-464 / PDPA | Feed doesn't embed recipient health details | _27 | ✅ pass |

---

## 5. Spec conflicts found

| # | Conflict | Cards | What the code does | Who should change |
|---|---|---|---|---|
| **C1** | Sheet _02 / _17 use "send invite" and `INVITE_SENT` | PYG-423 sheet vs PYG-423 comments + SCR-FG2-001 | No invite mutations; no `INVITE_SENT` (only the deprecated `MEMBER_INVITED`, never emitted) | PYG-423 sheet: _02 rewritten, _17 deleted, _22–_25 added |
| **C2** | **Booking-on-behalf action name:** PYG-423 _19 says `BOOKING_CREATED`; **PYG-427 _05 says `BOOKING_ON_BEHALF`** | PYG-423 vs PYG-427 | Emits **`BOOKING_ON_BEHALF`**; `BOOKING_CREATED` doesn't exist in the code or the DB CHECK | **PYG-423 sheet _19** |
| **C3** | Sheet _07: last page has "nextCursor null/empty" | PYG-423 sheet vs the Relay-style API | `pageInfo.endCursor` is still the last node's cursor; the end is signalled by `hasNextPage=false` | PYG-423 sheet wording (or FE docs) |
| **C4** | Sheet _18 assumes a user-facing "add/update recipient" flow; PYG-464 says profiles are created implicitly and the old mutation has no FE caller | PYG-423 sheet vs PYG-464 | **Both exist:** explicit GraphQL mutations still ship (with no activity), and implicit provisioning inside on-behalf booking | Product: remove the unused mutations or give them activity rows (F2) |
| **C5** | Comment ③ requires `linkId` in `MEMBER_JOINED` metadata | PYG-423 comment vs PYG-417 implementation | Key is `joinedViaLinkId` | Either the comment/AC or the code (F3) |
| **C6** | The sheet's Estimate column is blank for all 21 cases | PYG-423 sheet | — | Sheet (estimates for new cases are in §8) |

---

## 6. Product findings (not fixed)

### F1 — A cursor with a non-UUID id returns a 500 instead of `ACTIVITY_CURSOR_INVALID` · suggested severity: **Medium** (an unhandled server error from user-supplied input; no data leak)

- **Spec:** sheet _08 says a tampered cursor is "rejected with a validation error (no crash)". The code's own contract (`family-group.errors.ts`) says a malformed cursor → `ACTIVITY_CURSOR_INVALID`.
- **Code:** `decodeActivityCursor` (`src/family-group/family-group.service.ts:1386`) checks there are 2 parts, the date is valid, and `id.length !== 0` (`:1405`), **but not that `id` is a UUID**. The id then reaches Prisma as `id: { lt: cursor.id }` (`:1331`) against a `uuid` column, and the query fails inside the adapter:
  ```
  PrismaClientKnownRequestError: Invalid `this.prisma.familyGroupActivity.findMany()` invocation … family-group.service.ts:1320
  Raw query failed. Code: `InvalidArg`. Message: `unknown variant `InvalidInputValue` …`
  ```
- **Repro** (as an ACTIVE member):
  ```graphql
  query { familyGroupActivity(groupId: "<G>", first: 5,
          after: "MjAyNi0wMS0wMVQwMDowMDowMC4wMDBafG5vdC1hLXV1aWQ") { nodes { id } } }
  # after = base64url("2026-01-01T00:00:00.000Z|not-a-uuid")
  # → errors[0].extensions.code = "INTERNAL_SERVER_ERROR" (expected "ACTIVITY_CURSOR_INVALID")
  ```
- **Fix direction:** validate `id` as a UUID in `decodeActivityCursor` and throw `ActivityCursorInvalidError`.

### F2 — Care-recipient mutations write no activity rows · suggested severity: **Medium** (AC-BS-07 audit gap; the rows aren't in the same transaction either)

- **Spec:** AC-BS-07: "feed of meaningful group events (member joined, **recipient added**, booking on behalf …)"; the module rule says every state-changing mutation writes activity in the same transaction. Sheet _18 expects exactly one row per recipient add/update.
- **Code:** `addGroupCareRecipient` (`family-group.service.ts:563`), `updateGroupCareRecipient` (`:592`) and `removeGroupCareRecipient` (`:634`) write `care_recipients` with no `writeActivity` call and no `$transaction`. The service header says so (`:152`: "add/update/removeGroupCareRecipient ยังไม่เขียน RECIPIENT_ADDED/UPDATED/REMOVED และยังไม่อยู่ใน $transaction"). The action names exist in the enum and DB CHECK but are never used.
- **Repro:** `addGroupCareRecipient(input: {groupId: G, name: "…"})` succeeds, then `updateGroupCareRecipient(input: {groupId: G, recipientId, nickname: "…"})` succeeds. `family_group_activity` has 0 `RECIPIENT_*` rows.
- **Context:** PYG-464 moved the product to implicit provisioning, and these mutations have no FE caller. They are still live in the GraphQL schema, so any member can change a group profile without leaving a trace. Either give them activity rows (in a transaction) or remove them from the schema.

### F3 — `MEMBER_JOINED` metadata uses `joinedViaLinkId`, not `linkId` · suggested severity: **Low** (contract naming; the information is present)

- **Spec:** PYG-423 comment of 2026-09-02: "คนที่เข้ามาด้วยลิงก์ → มี MEMBER_JOINED 1 แถว พร้อม **linkId** ใน metadata".
- **Code:** `joinGroupByLink` writes `metadata: { joinedViaLinkId: link.id }` (`family-group.service.ts:973`), matching the `family_group_members.joined_via_link_id` column name.
- **Evidence (_25):** exactly 1 row, actor = joiner, metadata keys `["joinedViaLinkId"]`, value = the link used.
- **Decide:** rename the key, or update the AC/comment and any FE code that reads `metadata.linkId`.

### Observations (not failures)

- **O1 — The tiebreak is deterministic but not chronological.** `id` is `uuid` from `gen_random_uuid()` (v4), so rows with the same `created_at` (for example several activity rows written in one transaction) are ordered by a random UUID, not by insertion order. _03 passes; if strict in-transaction order ever matters (say "created then rotated" in one transaction), it needs a sequence column or UUID v7.
- **O2 — Append-only is enforced by API surface only.** There's no DB trigger or `REVOKE UPDATE/DELETE`. Client roles are limited by RLS (SELECT policy only), but the backend's owner role could modify rows. That's fine today; note it if the feed is ever used as an audit record.
- **O3 — The cursor isn't bound to a group.** It holds only `(createdAt, id)`. Cross-group use can't leak rows, because the query always filters by the guarded `groupId` (_30). A G1 cursor used on G2 just acts as a timestamp filter, which is harmless.
- **O4 — `MEMBER_REJOINED` is declared but never emitted.** A re-join writes `MEMBER_JOINED` (known, service header). Relevant to PYG-420 decision ค.

---

## 7. Questions / assumptions

1. **C2:** confirm `BOOKING_ON_BEHALF` as the canonical name, and correct PYG-423 sheet _19. The code, the DB CHECK and PYG-427 agree.
2. **F2 / C4:** should the explicit `add/update/removeGroupCareRecipient` mutations be removed (PYG-464 made them unused), or kept and given activity rows in a transaction?
3. **F3:** `linkId` or `joinedViaLinkId`: which one does the FE feed renderer read?
4. **_21:** is idempotency for family-group mutations in scope for FG-3 at all? If not, delete the case from the sheet.
5. **_29 production evidence:** it came from a **read-only** Supabase catalog query (`pg_publication_tables`, `pg_class.relrowsecurity`, `pg_policies`, `pg_indexes`) touching no user data and writing nothing. The automated test itself checks only the repo's migration files.
6. **Assumptions:**
   - Groups for ordering and paging cases are inserted directly (owner membership included) with no `GROUP_CREATED` row, so every `created_at` is controlled.
   - Emission cases use groups created through the API.
   - Member and non-ACTIVE membership rows are seeded with Prisma.
   - The test DB has no RLS policies or Supabase schemas; the backend connects as the table owner, so API behaviour doesn't depend on them.

---

## 8. New cases added (house format)

Created By / Execute By = Wasan. R.

| TC_NO | Title | Estimate |
|---|---|---|
| PYG-423_22 | Verify that creating a join link produces exactly one activity row [Emission][JoinLink] | 5m |
| PYG-423_23 | Verify that rotating a join link produces exactly one activity row [Emission][JoinLink] | 5m |
| PYG-423_24 | Verify that revoking a join link produces exactly one activity row [Emission][JoinLink] | 5m |
| PYG-423_25 | Verify that joining via link writes one MEMBER_JOINED row carrying the link id [Emission][JoinLink][Metadata] | 5m |
| PYG-423_26 | Verify that the feed never exposes the join token or full link URL [Feed][Privacy][Security] | 10m |
| PYG-423_27 | Verify that the feed does not expose care recipient health details [Feed][Privacy][PDPA] | 10m |
| PYG-423_28 | Verify that the activity feed is append-only [Feed][Integrity] | 10m |
| PYG-423_29 | Verify that realtime exposure of the activity table is safe [Feed][Realtime][Security] | 10m |
| PYG-423_30 | Verify that a cursor issued for one group cannot page another group's feed [Pagination][Isolation][Security] | 10m |
| PYG-423_31 | Verify that a non-ACTIVE membership cannot read the feed [Access][Authz][Edge] | 5m |

---

## 9. How to run

Same recipe as PYG-415 (`docs/qa/pyg-415-family-group-crud-report.md` §6). The migration chain can't be replayed from empty (it stops at migration #7, `kyc_verified_at already exists`), so the schema is built from `schema.prisma`.

```bash
# 1. disposable Postgres (localhost only)
docker run -d --rm --name pyg423-qa-pg -e POSTGRES_USER=qa -e POSTGRES_PASSWORD=qa \
  -e POSTGRES_DB=pyg423 -p 127.0.0.1:5437:5432 postgres:17

# 2. schema from schema.prisma (renders SQL only; never connects to a DB)
DATABASE_URL="postgresql://u:p@localhost:5999/none" \
  npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > /tmp/pyg423-schema.sql
docker exec -i pyg423-qa-pg psql -U qa -d pyg423 -v ON_ERROR_STOP=1 -1 < /tmp/pyg423-schema.sql

# 3. hand-written family-group CHECKs + partial unique indexes: identical block to PYG-415 report §6 step 3
#    (includes the family_group_activity action/target CHECKs)

# 4. REQUIRED: verify the keyset index exists (pagination results are meaningless without it)
docker exec pyg423-qa-pg psql -U qa -d pyg423 -tA -c \
  "select indexdef from pg_indexes where tablename='family_group_activity'"
# expected to include:
#   CREATE INDEX family_group_activity_group_id_created_at_idx ON public.family_group_activity USING btree (group_id, created_at DESC, id DESC)

# 5. run (DATABASE_URL deliberately unset)
env -u DATABASE_URL PYG423_DATABASE_URL="postgresql://qa:qa@127.0.0.1:5437/pyg423" \
  npx jest --config ./test/jest-e2e.json --runInBand --forceExit test/family-group-activity-feed

# 6. cleanup
docker stop pyg423-qa-pg
```

`--forceExit` is needed because `PrismaService` creates a `pg.Pool` that `$disconnect()` doesn't close.
