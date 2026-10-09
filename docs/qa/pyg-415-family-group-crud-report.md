# PYG-415 · TC-BS-01 — Family group CRUD + permissions · QA report

- Ticket: PYG-415 (QA) · Parent story: PYG-407 (AC-BS-01)
- Spec: `test/family-group-crud.e2e-spec.ts` (24 `it()`, one per TC_NO)
- Branch: `test/PYG-415-family-group-crud` off `origin/dev` @ `0a6f1ec`
- Run date: 2026-09-15 · Created By / Execute By: Wasan. R
- **Result: 19 PASS · 5 FAIL · 0 BLOCKED**

The tests call the **GraphQL API** through supertest. The guard chain is the real one (`SupabaseAuthGuard → RolesGuard → FamilyGroupGuard`), and so are `ValidationPipe` (same options as `main.ts`), `FamilyGroupService` and `PrismaService`. The only mock is `SupabaseService.auth.getUser`, which maps a token to a Supabase uid. Database effects are checked with Prisma queries against a **disposable Postgres 17 in Docker**.

---

## 1. Baseline before / after

Measured in the worktree after `npm ci` and `prisma generate`, which succeeded.

| Check | Before (`origin/dev`) | After (this branch) | Δ |
|---|---|---|---|
| `npx tsc --noEmit` | 19 errors (all in `*.spec.ts`) | 19 errors, 0 in the new spec | 0 |
| `npm test` | 35 failed / 1071 (4 suites failed) | 35 failed / 1071 (4 suites failed) | 0 |
| `npm run test:e2e` (no test DB) | 1 failed / 29 (`app.e2e-spec`) | 1 failed / 53, 24 skipped | 0 failures added |
| PYG-415 spec against the Docker DB | n/a | 19 passed / 5 failed / 24 | — |

`PYG415_DATABASE_URL` is opt-in. Without it the new suite is `describe.skip`, so a plain `npm run test:e2e` gains no failures. If the variable points at anything other than localhost, or the URL contains `supabase`, the spec throws before connecting.

---

## 2. Results

| TC_NO | Result | Evidence | Notes |
|---|---|---|---|
| PYG-415_01 | PASS | `createFamilyGroup` → `myRole=OWNER`, `memberCount=1`; DB row `{role:OWNER,status:ACTIVE}` | Covers AC A1, including the ACTIVE row |
| PYG-415_02 | **FAIL** | `data=null`; `family_groups` count for creator = 0 ✔; `extensions.code` = `BAD_REQUEST` ✘ (expected `GROUP_NAME_INVALID` + `maxLength:80`) | The block works; the error contract doesn't match. See F1 |
| PYG-415_03 | **FAIL** | 81 chars → `data=null`, count 0 ✔; 80 chars → created, count 1 ✔; 81-char error code = `BAD_REQUEST` ✘ | Max 80 confirmed. See F1 |
| PYG-415_04 | PASS | Rename → re-query `familyGroup.name` and DB `name` both = new value | |
| PYG-415_05 | PASS | Member rename → `NOT_GROUP_OWNER`; DB name unchanged | UI half: NOT COVERED (FE) |
| PYG-415_06 | PASS | Stranger on real groupId → `NOT_A_MEMBER`, `data=null`; random UUID → same code and same message | Member list is part of the `familyGroup` query; there is no separate query |
| PYG-415_07 | PASS | Member could read before; `removeMember` → `memberCount=1`, DB `status=REMOVED`; next read by removed member → `NOT_A_MEMBER` | Access loss is immediate, on the next request |
| PYG-415_08 | PASS | Member removes another → `NOT_GROUP_OWNER`; active count and target row unchanged | UI half: NOT COVERED (FE) |
| PYG-415_09 | PASS | Owner sees `memberCount` 2 → 1 after member `leaveFamilyGroup`; DB `status=LEFT` | UI half: NOT COVERED (FE) |
| PYG-415_10 | PASS | Owner leave with 2 members → `LAST_OWNER`; owner row still `OWNER/ACTIVE`; active count 3 | The message tells the owner to transfer or delete |
| PYG-415_11 | PASS | `transferOwnership` → response `myRole=MEMBER`; DB target `OWNER/ACTIVE`, previous `MEMBER/ACTIVE` | |
| PYG-415_12 | PASS | Member transfer → `NOT_GROUP_OWNER`; all 3 rows' roles unchanged | UI half: NOT COVERED (FE) |
| PYG-415_13 | PASS | Cap-1 members → 1 join succeeds (count = 10); next join → `GROUP_MEMBER_LIMIT_REACHED`, `extensions.maxMembers=10`; count stays 10; no row for the rejected user | Cap = **10** (see §4) |
| PYG-415_14 | PASS | Link rows 1 → 0 after `deleteFamilyGroup` (FK cascade); old token → `JOIN_LINK_INVALID` | |
| PYG-415_15 | **FAIL** | Empty rename → `data=null`, DB name unchanged ✔; code = `BAD_REQUEST` ✘ | See F1 |
| PYG-415_16 | **FAIL** | 80 chars accepted and persisted ✔; 81 chars → `data=null`, name stays the 80-char value ✔; code = `BAD_REQUEST` ✘ | See F1 |
| PYG-415_17 | PASS | Sole owner leave → `LAST_OWNER`; group exists; owner `OWNER/ACTIVE` | |
| PYG-415_18 | PASS | Transfer, then previous owner leaves; both succeed; previous owner `LEFT`; exactly one ACTIVE owner = new owner | |
| PYG-415_19 | **FAIL** | Group gone ✔; `family_group_members` for G = 0 ✔; `family_group_activity` for G = 0 ✔; **care recipient row still exists with `familyGroupId=null`** ✘ | See F2. Needs a product decision |
| PYG-415_20 | PASS | Delete not blocked (`deleted=true`); booking `{status:'confirmed', familyGroupId:null}`; `booking_status_history` rows = 1 (unchanged) | AC edge case confirmed |
| PYG-415_21 | PASS | Exactly one row per action with actor + target: `GROUP_CREATED`, `GROUP_RENAMED`, `MEMBER_REMOVED`, `OWNERSHIP_TRANSFERRED`. **Same transaction:** a temporary trigger in the disposable DB makes the activity insert fail for G only → rename returns an error, name unchanged, still 4 activity rows | The trigger is dropped in `finally` |
| PYG-415_22 | PASS | Member rename → `NOT_GROUP_OWNER`; activity count for G unchanged | |
| PYG-415_23 | PASS | Member delete → `NOT_GROUP_OWNER`; group exists; active count 3 | UI half: NOT COVERED (FE) |
| PYG-415_24 | PASS | Owner `removeMember(self)` → `LAST_OWNER`; owner `OWNER/ACTIVE`; active count 2 | |

---

## 3. Product findings (not fixed)

### F1 — Group-name validation returns `BAD_REQUEST`, not the documented `GROUP_NAME_INVALID` · suggested severity: **Medium** (API contract)

- **What the contract says:** `src/family-group/family-group.errors.ts` declares `GROUP_NAME_INVALID` as the FE contract ("ห้ามเปลี่ยนค่า code โดยไม่บอกทีม FE"), with `extensions.maxLength` so the FE can show a character counter without hard-coding 80. The resolver descriptions say "ชื่อว่างหรือเกิน 80 ตัวอักษร → GROUP_NAME_INVALID".
- **What the code does:** `CreateFamilyGroupInput.name` and `RenameFamilyGroupInput.name` both have `@Length(1, 80)`. The global `ValidationPipe` rejects the input before the resolver runs, so the response is `extensions.code = "BAD_REQUEST"` with no `maxLength`. `FamilyGroupService.assertValidName()`, which throws `GroupNameInvalidError`, is unreachable through the API.
- **Behaviour is otherwise correct:** the request is rejected and nothing is written (checked in TC 02/03/15/16).
- **Repro:**
  ```graphql
  mutation { createFamilyGroup(input: { name: "" }) { id } }
  # → errors[0].extensions.code = "BAD_REQUEST"  (expected "GROUP_NAME_INVALID", maxLength: 80)
  ```
  The same happens with `renameFamilyGroup` using `""` or 81 characters.
- **Affects:** PYG-415_02, _03, _15, _16

### F2 — Deleting a group does not delete care recipients (`ON DELETE SET NULL`) · suggested severity: **needs PO decision** (spec conflict)

- **What AC A2 says:** "delete cascades members / invites / **recipients** / activity". TC_19 expects no remaining recipient rows.
- **What the code does:** FK `care_recipients_family_group_id_fkey` is `ON DELETE SET NULL` (migration `20260824000000_family_group_management`, and the same in `schema.prisma`). The recipient row survives with `family_group_id = NULL`.
- **This is deliberate:** the migration header explains that AC A2 conflicts with the edge case "bookings keep history". Cascading would delete patient profiles, including `is_self` ones, and null `bookings.care_recipient_id` through its own SET NULL FK. The `deleteFamilyGroup` resolver description also says recipients are not deleted.
- **Repro:** create a group, insert a `care_recipients` row with `family_group_id = G`, then call `deleteFamilyGroup(groupId: G)`. The row is still there with `family_group_id` null.
- **Needs a decision:** either update AC A2 to "recipients are unlinked (family_group_id set null)" and I'll change TC_19's expectation, or change the FK to CASCADE and accept that booking history loses "who it was for".
- **Affects:** PYG-415_19

### Observations (outside TC-BS-01 scope, worth a ticket)

- **O1 — The migration history can't be replayed on an empty database.** Applying `prisma/migrations/*` in order stops at `20260409092523_add_phone_address_bio_to_user` with `column "kyc_verified_at" of relation "caregivers" already exists`. A new environment or a disaster-recovery rebuild can't be built from the migration chain alone. That's why the test DB was built as described in §6.
- **O2 — `20260914000000_pyg466_care_log_images_bucket` writes to `storage.buckets` without the `undefined_table` guard** that `20260803000000_add_job_events_monitoring` uses. It only runs on Supabase.

---

## 4. Config values read

| Setting | Value used in this run | Source |
|---|---|---|
| Group name length | 1–80, measured after trim | `GROUP_NAME_MIN/MAX_LENGTH` in `family-group.constants.ts`; DB CHECK `family_groups_name_check` (`char_length(btrim(name)) BETWEEN 1 AND 80`) |
| Member cap (PYG-428) | **10** | `GROUP_MAX_MEMBERS` = `FAMILY_GROUP_MAX_MEMBERS` env, default 10. The env var was unset in the test process |
| Join link max uses | 10 (default); TC_13 passes `maxUses = cap` explicitly | `FAMILY_JOIN_LINK_MAX_USES`, default 10, `0` = unlimited |
| Join link TTL | 168 h (default) | `FAMILY_JOIN_LINK_TTL_HOURS` (falls back to `FAMILY_INVITE_TTL_HOURS`) |

---

## 5. Questions / assumptions

1. **F2:** should TC_19 follow AC A2 as written (cascade) or the implemented SET NULL? The test currently asserts the AC, so it fails.
2. **F1:** which is the intended contract, `GROUP_NAME_INVALID` + `maxLength` (as documented) or `BAD_REQUEST`?
3. **Production member cap:** this run used the default of 10. I didn't read `FAMILY_GROUP_MAX_MEMBERS` on the deployed environment, because that would mean touching the shared project. If production sets a different value, TC_13 still passes, since it reads the same constant, but the number in §4 should be confirmed.
4. **Preconditions:** extra members are inserted directly into `family_group_members` (ACTIVE / MEMBER), so no `MEMBER_JOINED` activity is written for them. The group itself is always created through the API. TC_13 and TC_14 join through a real join link.
5. **UI halves:** "control not shown to user X" for TC 05/08/09/12/23 is **not covered (FE)**. Only the API denial is asserted.
6. **The prompt's DB setup reference is outdated:** the brief said to follow "the pattern already used by the PYG-377 integration tests". That commit (`e303a1a`) adds one mock-based unit spec (`src/payment/pyg377-money.spec.ts`) and has no Docker or Postgres pattern. The Docker setup below is new.
7. **RLS is not present in the test DB.** Policies, `is_group_member()` and the Supabase schemas are Supabase-only. The backend connects as the table owner and bypasses RLS, so the API behaviour under test doesn't depend on it.

---

## 6. How to run

```bash
# 1. disposable Postgres (localhost only)
docker run -d --rm --name pyg415-qa-pg -e POSTGRES_USER=qa -e POSTGRES_PASSWORD=qa \
  -e POSTGRES_DB=pyg415 -p 127.0.0.1:5434:5432 postgres:17

# 2. schema from schema.prisma (renders SQL only, never connects to a DB), then apply inside the container
DATABASE_URL="postgresql://u:p@localhost:5999/none" \
  npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > /tmp/pyg415-schema.sql
docker exec -i pyg415-qa-pg psql -U qa -d pyg415 -v ON_ERROR_STOP=1 -1 < /tmp/pyg415-schema.sql

# 3. hand-written family-group pieces Prisma can't express
#    (copied from migrations 20260824000000 + 20260902000000)
docker exec -i pyg415-qa-pg psql -U qa -d pyg415 -v ON_ERROR_STOP=1 -1 <<'SQL'
ALTER TABLE "family_groups" ADD CONSTRAINT "family_groups_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 80);
ALTER TABLE "family_group_members" ADD CONSTRAINT "family_group_members_role_check" CHECK ("role" IN ('OWNER','MEMBER'));
ALTER TABLE "family_group_members" ADD CONSTRAINT "family_group_members_status_check" CHECK ("status" IN ('ACTIVE','REMOVED','LEFT'));
ALTER TABLE "family_group_activity" ADD CONSTRAINT "family_group_activity_action_check" CHECK ("action" IN (
  'GROUP_CREATED','GROUP_RENAMED','MEMBER_INVITED','INVITE_REVOKED','JOIN_LINK_CREATED','JOIN_LINK_ROTATED','JOIN_LINK_REVOKED',
  'MEMBER_JOINED','MEMBER_REJOINED','MEMBER_LEFT','MEMBER_REMOVED','OWNERSHIP_TRANSFERRED',
  'RECIPIENT_ADDED','RECIPIENT_UPDATED','RECIPIENT_REMOVED','BOOKING_ON_BEHALF'));
ALTER TABLE "family_group_activity" ADD CONSTRAINT "family_group_activity_target_type_check"
  CHECK ("target_type" IS NULL OR "target_type" IN ('GROUP','MEMBER','INVITE','JOIN_LINK','RECIPIENT','BOOKING'));
ALTER TABLE "family_group_join_links" ADD CONSTRAINT "family_group_join_links_status_check" CHECK ("status" IN ('ACTIVE','REVOKED'));
ALTER TABLE "family_group_join_links" ADD CONSTRAINT "family_group_join_links_token_hash_check" CHECK (char_length("token_hash") = 64);
ALTER TABLE "family_group_join_links" ADD CONSTRAINT "family_group_join_links_max_uses_check" CHECK ("max_uses" IS NULL OR "max_uses" > 0);
ALTER TABLE "family_group_join_links" ADD CONSTRAINT "family_group_join_links_used_count_check" CHECK ("used_count" >= 0 AND ("max_uses" IS NULL OR "used_count" <= "max_uses"));
CREATE UNIQUE INDEX "family_group_members_one_active_owner_key" ON "family_group_members" ("group_id") WHERE "role"='OWNER' AND "status"='ACTIVE';
CREATE UNIQUE INDEX "family_group_join_links_one_active_key" ON "family_group_join_links" ("group_id") WHERE "status"='ACTIVE';
SQL

# 4. run (DATABASE_URL deliberately unset — the spec only uses PYG415_DATABASE_URL)
env -u DATABASE_URL PYG415_DATABASE_URL="postgresql://qa:qa@127.0.0.1:5434/pyg415" \
  npx jest --config ./test/jest-e2e.json --runInBand --forceExit test/family-group-crud.e2e-spec.ts

# 5. cleanup
docker stop pyg415-qa-pg
```

`--forceExit` is needed because `PrismaService` creates a `pg.Pool` that `$disconnect()` doesn't close, so Jest would otherwise wait on the open handle.
