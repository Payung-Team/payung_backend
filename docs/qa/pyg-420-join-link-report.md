# PYG-420 · TC-BS-02/04/05 — Join link, expiry & token security · QA report

- Ticket: PYG-420 (QA) · Parent story: PYG-408 (FG-2)
- **Spec used: FG-2 v1.1, taken from the PYG-408 comments.** That means AC B1–B8 (2026-09-02), SCR-FG2-001 (2026-09-02), and Amendment 1 (2026-09-03), which adds B9–B10. The PYG-420 comment of 2026-09-02 also applies. The PYG-408 description field still describes the deleted email/Resend flow (v1.0) and was **not** used.
- Test sheet: `PYG420_PYG415_TestCases_WasanR` (Google Drive), cases _01–_15. **_11 was rewritten per Amendment 1.**
- Specs:
  - `test/family-group-join-link.e2e-spec.ts` (TC _01–_15, _17–_26)
  - `test/family-group-join-link.concurrency.e2e-spec.ts` (TC _16)
  - `test/support/join-link-e2e.ts` (shared harness)
- Branch: `test/PYG-420-join-link-security` off `origin/dev` @ `0a6f1ec`
- Final run: 2026-09-15T12:27:13Z · Created By / Execute By: Wasan. R
- **Result: 20 PASS · 3 FAIL · 3 BLOCKED** (26 TCs)

The tests call the **GraphQL API** through supertest. The guard chain is the real one (`SupabaseAuthGuard → RolesGuard → FamilyGroupGuard`), as are `ValidationPipe` (same options as `main.ts`), `FamilyGroupService` and `PrismaService`. The only mock is `SupabaseService.auth.getUser`, which maps a token to a Supabase uid. Database effects are checked with Prisma queries against a **disposable Postgres 17 in Docker** (§7).

---

## 1. Baseline before / after

Measured in the worktree after `npm ci` and `prisma generate` (log line: `✔ Generated Prisma Client (v6.19.3)`).

| Check | Before (`origin/dev`) | After (this branch) | Δ |
|---|---|---|---|
| `npx tsc --noEmit` | 19 errors | 19 errors, 0 in new files | 0 |
| `npm test` | 35 failed / 1071 | 35 failed / 1071 | 0 |
| `npm run test:e2e` (no test DB, local) | 1 failed / 29 (`app.e2e-spec`) | 1 failed / 55, 26 skipped | 0 failures added |
| PYG-420 specs against Docker DB | n/a | 20 passed / 3 failed / 3 skipped | — |

**Connection guard** (`test/support/join-link-e2e.ts`):
- Only `PYG420_DATABASE_URL` is read.
- The spec throws if the host isn't localhost or the URL contains `supabase`.
- **If the variable is unset:**
  - Locally, the suite is skipped.
  - When `CI` is set, the suite fails. Verified with `CI=1` and no DB URL: exit 1, `Test Suites: 2 failed, 2 total`, message `PYG420_DATABASE_URL ไม่ได้ตั้งค่าใน CI — ชุดทดสอบ PYG-420 ต้องรันจริง ห้าม skip`.
- As a result, once PYG-453 enables CI, this suite can't pass without actually running.

---

## 2. Results

| TC_NO | Result | Evidence | Notes |
|---|---|---|---|
| PYG-420_01 | PASS | `createJoinLink` → `isUsable=true`; 1 ACTIVE row; `createdBy=owner`; token matches `^[A-Za-z0-9_-]{43}$` and decodes to **32 bytes**; `token_hash = sha256(token)`; `expires_at − now ≈ 7 d` (±2 min); a second group gets a different token | "displayed and copyable": NOT COVERED (FE) |
| PYG-420_02 | **BLOCKED** | — | Decision ก. (token storage) is still open, and PYG-455 is To Do. See §6-1 |
| PYG-420_03 | PASS | Preview: `groupName`, `ownerName = creator`, `isUsable=true`, `alreadyMember=false`. Join: member row `{MEMBER, ACTIVE, joinedViaLinkId=L}`, `used_count=1`, link still ACTIVE, owner sees `memberCount=2` | Preview returns the current *owner*, not the link *creator* (O1) |
| PYG-420_04 | PASS (API half) | No session → `joinLinkPreview` and `joinGroupByLink` both return `UNAUTHENTICATED`; `used_count=0`; member count unchanged | Resume after login (B7): **NOT COVERED (FE)** |
| PYG-420_05 | PASS | Member: preview `alreadyMember=true`; join returns the group with no error; member count unchanged (2); **`used_count` unchanged (0)** | B4 |
| PYG-420_06 | PASS | `expires_at` set to the past: preview `{isUsable:false, unusableReason:'EXPIRED'}`; join `data=null`, **`JOIN_LINK_EXPIRED`**; no member row; `used_count=0` | |
| PYG-420_07 | PASS | `revokeJoinLink=true`; row `REVOKED`, `revoked_at` set; owner's `groupJoinLink` → `JOIN_LINK_NOT_FOUND`; join → **`JOIN_LINK_REVOKED`**; no member; `used_count=0` | |
| PYG-420_08 | PASS | Rotate: new token ≠ old; old row `REVOKED`, new row `ACTIVE`, exactly 1 ACTIVE; **activity `JOIN_LINK_ROTATED` ×1** with `actor=owner`, `target=new link`, `metadata.replacedLinkId=old`; old token → `JOIN_LINK_REVOKED`; new token joins, count +1 | B8 |
| PYG-420_09 | PASS | `max_uses=2`: 2 joins → `used_count=2`; 3rd → **`JOIN_LINK_EXHAUSTED`**, no row, `used_count` stays 2. Raw `UPDATE … used_count=3` → rejected by `family_group_join_links_used_count_check` | DB-level enforcement confirmed |
| PYG-420_10 | PASS | `createJoinLink` twice → same `id` and `url`, no error, 1 ACTIVE. A direct Prisma insert of a second ACTIVE row → rejected (unique) by `family_group_join_links_one_active_key`; still 1 ACTIVE | DB-level enforcement confirmed |
| PYG-420_11 (rewritten) | PASS | Member calls `createJoinLink`, `rotateJoinLink`, `revokeJoinLink` → all three **`NOT_GROUP_OWNER`**; link row identical (status, hash, expiry, `updated_at`); link and activity row counts unchanged | Per Amendment 1. UI half: NOT COVERED (FE) |
| PYG-420_12 | PASS | 5 variants (`aaaaaaaa`, `12345678`, `""`, 4096×`A`, real token with 1 char changed) → join **and** preview all **`JOIN_LINK_INVALID`**; identical message every time; the group name never appears in any response; count and `used_count` unchanged | |
| PYG-420_13 | PASS | Join with A's token plus `groupId: B` → `GRAPHQL_VALIDATION_FAILED` (the argument doesn't exist); neither membership changes. A normal join with A's token → joins A only; B unchanged | No group substitution is possible |
| PYG-420_14 | **BLOCKED** | — | Decision ก. The expectation flips depending on the storage choice. See §6-1 |
| PYG-420_15 | PASS | Join → activity count +1; `familyGroupActivity` (API, as owner) newest node `{action: MEMBER_JOINED, actor.userId: U}` with a valid `createdAt` | Activity UI: NOT COVERED (FE) |
| PYG-420_16 | PASS | **(a) API:** 10 rounds, each with a link that has 1 slot left and 2 parallel joins → every round `['JOIN_LINK_EXHAUSTED','OK']`, `used_count = max_uses = 2`, member count = 3. **(b) SQL:** 2 pg connections run the service's conditional UPDATE; the second **stays blocked until the first commits** (not finished after 500 ms), then returns **0 rows**; final `used_count=2`. A static check confirms the service still uses the predicate `AND (max_uses IS NULL OR used_count < max_uses)` | Separate file. See O3 on what (a) alone can't prove |
| PYG-420_17 | PASS | Group at cap (10), link with `max_uses=10`, `used_count=0` → **`GROUP_MEMBER_LIMIT_REACHED`** (not EXHAUSTED); count stays 10; `used_count` stays 0 | |
| PYG-420_18 | **FAIL** | Member `groupJoinLink` → `NOT_GROUP_OWNER` ("เฉพาะเจ้าของกลุ่มเท่านั้นที่ทำรายการนี้ได้"); the owner receives the URL | **F1**: B9 not implemented |
| PYG-420_19 | PASS | Non-member `groupJoinLink` → **`NOT_A_MEMBER`**, `data=null`, no token anywhere in the response; the same code and message for a group with no link, so it doesn't reveal whether a link exists | |
| PYG-420_20 | **FAIL** | Member `groupJoinLink` with no ACTIVE link → `NOT_GROUP_OWNER` (expected `JOIN_LINK_NOT_FOUND`); no link row created ✔ | **F1**: B10 not implemented. UI half: NOT COVERED (FE) |
| PYG-420_21 | PASS | Preview `isUsable=true` → owner revokes → join: HTTP 200, `data=null`, code **`JOIN_LINK_REVOKED`** (not `INTERNAL_SERVER_ERROR`), Thai message without prisma/sql/constraint text; no member | |
| PYG-420_22 | PASS | U1 joins via L1 → rotate → U2 joins via L2: `joined_via_link_id` is L1 for U1 and L2 for U2; L1 ≠ L2 | |
| PYG-420_23 | **FAIL** | 30 rapid sequential `joinGroupByLink` calls by one user → all `200:JOIN_LINK_INVALID`; **0 rate-limited**. No throttler anywhere in `src/` or `package.json` | **F2**. Per-IP: not testable because no limiter exists |
| PYG-420_24 | PASS | `JOIN_LINK_TTL_HOURS = 168`; `expires_at = now+1min` → joins; `now−1min` → **`JOIN_LINK_EXPIRED`**, no row, `used_count=0` | |
| PYG-420_25 | PASS | Exactly one row `{MEMBER_JOINED, actor=U, targetType=MEMBER, target=U, metadata.joinedViaLinkId=L}`. **Same transaction:** a temporary trigger makes the activity insert fail for group 2 → join errors, **no member row and `used_count` stays 0** (the conditional UPDATE is rolled back too) | Trigger dropped in `finally` |
| PYG-420_26 | **BLOCKED** | — | Decision ค. (removed-member re-join) is still open. See §6-2 |

No domain code was replaced by a generic `BAD_REQUEST` in this suite: every negative case returned its exact domain code. The PYG-415 validation finding does **not** recur here.

---

## 3. AC coverage matrix (FG-2 v1.1)

| AC | Requirement (summary) | TC_NO | Status |
|---|---|---|---|
| **B1** | Only the owner creates / rotates / revokes; ACTIVE row; URL returned; no email | _01, _10, _11 | ✅ Covered, pass |
| **B2** | Preview shows group name + creator; logged-in join → MEMBER/ACTIVE, `used_count` +1, link stays ACTIVE if not full | _03, _15, _22, _25 | ✅ Covered, pass (O1: preview shows owner, not creator) |
| **B3** | Expired → `JOIN_LINK_EXPIRED`; revoked/rotated → `JOIN_LINK_REVOKED`; no membership | _06, _07, _08, _21, _24 | ✅ Covered, pass |
| **B4** | Already-ACTIVE member → no-op, returns group, **does not consume `used_count`** | _05 | ✅ Covered, pass |
| **B5** | Guessed or tampered token → `JOIN_LINK_INVALID` | _12, _13 | ✅ Covered, pass |
| **B6** | `max_uses` reached → `JOIN_LINK_EXHAUSTED`; group full → `GROUP_MEMBER_LIMIT_REACHED` | _09, _16, _17 | ✅ Covered, pass (incl. DB-level + concurrency) |
| **B7** | Unauthenticated → login/register → resume join automatically | _04 | ⚠️ API half pass · resume flow NOT COVERED (FE) |
| **B8** | Rotate → old link dead immediately, new ACTIVE, activity `JOIN_LINK_ROTATED` | _08, _22 | ✅ Covered, pass |
| **B9** | Every ACTIVE member can view/copy the active link; non-member → `NOT_A_MEMBER`; member create/rotate/revoke → `NOT_GROUP_OWNER` | _18, _19, _11 | ❌ _18 **FAIL** (F1) · _19, _11 pass |
| **B10** | Member views with no ACTIVE link → `JOIN_LINK_NOT_FOUND`; UI says to ask the owner, with no create button | _20 | ❌ **FAIL** (F1) · UI half NOT COVERED (FE) |

Cases outside AC B1–B10:

| Source | Requirement | TC_NO | Status |
|---|---|---|---|
| SCR-FG2-001 §3 (new SRS) | Rate-limit join attempts per user/IP | _23 | ❌ **FAIL** (F2) |
| PYG-408 edge case | Two users joining at the same time on the last slot, enforced at SQL level | _16 | ✅ pass |
| PYG-408 edge case | Owner revokes while someone is on the preview page → fails gracefully, not a 500 | _21 | ✅ pass |
| SCR §7-1 (decision ก.) | Token storage / re-copy / exposure | _02, _14 | ⏸ BLOCKED |
| SCR §7-3 (decision ค.) | Removed member re-joins through the old link | _26 | ⏸ BLOCKED |

---

## 4. Product findings (not fixed)

### F1 — Amendment 1 (B9/B10) is not implemented: members can't view the group's join link · suggested severity: **High** (agreed AC missing; blocks the FE copy-link box for members)

- **What the AC says (PYG-408 Amendment 1, 2026-09-03):**
  - **B9:** every ACTIVE member, OWNER or MEMBER, can view and copy the group's active link.
  - **B10:** a member who views it when there is no ACTIVE link gets `JOIN_LINK_NOT_FOUND`.
  - The amendment notes that `groupJoinLink` must change from `@GroupRole('OWNER')` to `('MEMBER')`, and the service from `assertOwner` to an ACTIVE-member check. It says a follow-up PR is needed.
- **What the code does:** it is owner-only in **two places**:
  - `src/family-group/family-group.resolver.ts:169`: `@GroupRole(GROUP_ROLE.OWNER)` on `groupJoinLink`
  - `src/family-group/family-group.service.ts:811`: `await this.assertOwner(tx, groupId, userId)` inside `groupJoinLink`

  Fixing only the guard would still fail at the service.
- **Status of a fix:**
  - A local branch `feat/pyg-416-member-copy-link` exists but has no commits beyond `origin/dev` and still has `@GroupRole(OWNER)`.
  - It isn't on the remote.
  - No PR matches.
- **Repro** (as an ACTIVE non-owner member):
  ```graphql
  query { groupJoinLink(groupId: "<G>") { url } }
  # → errors[0].extensions.code = "NOT_GROUP_OWNER"
  #   B9 expects the URL (when an ACTIVE link exists); B10 expects JOIN_LINK_NOT_FOUND (when none exists)
  ```
- **Affects:** PYG-420_18, PYG-420_20
- **Unaffected:** non-members still get `NOT_A_MEMBER` (_19), and members are still denied create/rotate/revoke (_11). The fix only needs to widen the read path.

### F2 — No rate limiting on `joinGroupByLink` · suggested severity: **Medium** (spec'd control missing; practical brute-force risk is low)

- **What the spec says:** SCR-FG2-001 §3 adds a new SRS item: "จำกัดอัตราการเรียกเข้าร่วมต่อผู้ใช้/IP" (limit join attempts per user/IP). The PYG-420 comment lists "Rate limit ของ joinGroupByLink ทำงาน" as a test to add.
- **What the code does:** there's no limiter. `src/` and `package.json` have no `@nestjs/throttler` or any throttle/rate-limit code (the only hit is an Omise batching comment in `reconciliation.service.ts`).
- **Evidence:** 30 rapid sequential calls by one authenticated user with random tokens → `["200:JOIN_LINK_INVALID"]` ×30, 0 rejected.
- **Why the severity isn't higher:** tokens are 32 random bytes (TC_01), so guessing a valid token by brute force isn't practical. The missing control matters more for abuse and load (every attempt costs a DB lookup) and for traceability to the SRS.
- **Affects:** PYG-420_23

### Observations (not failures)

- **O1 — Preview shows the current owner, not the link creator.** B2 says "ชื่อกลุ่ม + ผู้สร้าง" (group name + creator), but `JoinLinkPreview` only exposes `ownerName`, the current OWNER. The two differ after `transferOwnership`, or if the creator has left. TC_03 passes because they're the same person in that scenario. Needs a spec clarification or a `creatorName` field.
- **O2 — Decision ก. is already implemented, but not formally decided.** `token_raw` is stored and `groupJoinLink` returns it (the service comment cites "ข้อตัดสินใจ ก. ของ SCR"), yet PYG-455 is still To Do. That's why _02 and _14 stay BLOCKED; I didn't pick a behaviour to assert.
- **O3 — What TC_16(a) alone can't prove:** in the API rounds, the losing request may be stopped by the service's pre-check rather than by the SQL UPDATE, and the test can't observe which. That's why part (b) tests the SQL itself: the conditional UPDATE blocks under a row lock and re-evaluates to 0 rows. The static check ties that SQL to the service code.
- **O4 — Context for decision ค.** (not asserted): the service header comment states that a re-joining former member is currently logged as `MEMBER_JOINED`, not `MEMBER_REJOINED`.

---

## 5. Config values read

| Setting | Value in this run | Source |
|---|---|---|
| `FAMILY_GROUP_MAX_MEMBERS` | **10** | **Default** in `family-group.constants.ts`. Env var unset in the test process |
| `max_uses` default (`FAMILY_JOIN_LINK_MAX_USES`) | **10** | **Default**; env var unset (`0` would mean unlimited) |
| Link TTL (`FAMILY_JOIN_LINK_TTL_HOURS`, fallback `FAMILY_INVITE_TTL_HOURS`) | **168 h = 7 days** | **Default**; both env vars unset. Asserted in _01 and _24 |
| Rate-limit threshold | **None — no limiter exists** | Code search (F2) |
| `APP_PUBLIC_BASE_URL` | `https://pyg420.test` | Set by the test harness (required to build link URLs) |

Production env values were **not** read, because that would mean touching the shared project.

---

## 6. Questions / assumptions

1. **Decision ก. (blocks _02, _14):** the code already keeps `token_raw`. Should PYG-455 be closed with "keep raw, readable by ACTIVE members (Amendment 1)"? Then _02 becomes "same token returned every time" and _14 becomes "`token_raw` readable only by ACTIVE members; never in the joiner response, activity metadata, or logs".
2. **Decision ค. (blocks _26):** confirm the proposed rule (re-join allowed, `MEMBER_REJOINED` activity, owner rotates to block). Current code logs `MEMBER_JOINED` (O4).
3. **B2 wording:** should the preview show the link **creator** or the current **owner** (O1)?
4. **F2:** what threshold is intended (per user? per IP? per window)? The spec names the control but no numbers.
5. **Sheet updates needed:** the sheet's _11 contradicts Amendment 1 (it expects link controls hidden from members). This suite uses the rewritten _11. Cases _16–_26 should be added to the sheet in house format.
6. **Assumptions:**
   - Extra members are inserted directly into `family_group_members` as preconditions, and expiry is set by updating `expires_at` directly.
   - Groups and links are always created through the API.
   - The RLS policies and Supabase schemas aren't in the test DB. The backend connects as the table owner, so API behaviour doesn't depend on them.

---

## 7. How to run

Same recipe as PYG-415 (`docs/qa/pyg-415-family-group-crud-report.md` §6, PR #56). The migration chain can't be replayed from empty (it stops at migration #7, `kyc_verified_at already exists`), so the schema is built from `schema.prisma`.

```bash
# 1. disposable Postgres (localhost only)
docker run -d --rm --name pyg420-qa-pg -e POSTGRES_USER=qa -e POSTGRES_PASSWORD=qa \
  -e POSTGRES_DB=pyg420 -p 127.0.0.1:5435:5432 postgres:17

# 2. schema from schema.prisma (renders SQL only; never connects to a DB)
DATABASE_URL="postgresql://u:p@localhost:5999/none" \
  npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > /tmp/pyg420-schema.sql
docker exec -i pyg420-qa-pg psql -U qa -d pyg420 -v ON_ERROR_STOP=1 -1 < /tmp/pyg420-schema.sql

# 3. hand-written family-group constraints (copied from migrations 20260824000000 + 20260902000000)
docker exec -i pyg420-qa-pg psql -U qa -d pyg420 -v ON_ERROR_STOP=1 -1 <<'SQL'
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

# 4. REQUIRED for _09/_10/_16: verify both DB-level guards exist before running (otherwise false passes)
docker exec pyg420-qa-pg psql -U qa -d pyg420 -tA \
  -c "select pg_get_constraintdef(oid) from pg_constraint where conname='family_group_join_links_used_count_check'" \
  -c "select indexdef from pg_indexes where indexname='family_group_join_links_one_active_key'"
# expected:
#   CHECK (((used_count >= 0) AND ((max_uses IS NULL) OR (used_count <= max_uses))))
#   CREATE UNIQUE INDEX family_group_join_links_one_active_key ON public.family_group_join_links USING btree (group_id) WHERE (status = 'ACTIVE'::text)

# 5. run both specs (DATABASE_URL deliberately unset)
env -u DATABASE_URL PYG420_DATABASE_URL="postgresql://qa:qa@127.0.0.1:5435/pyg420" \
  npx jest --config ./test/jest-e2e.json --runInBand --forceExit test/family-group-join-link

# 6. cleanup
docker stop pyg420-qa-pg
```

`--forceExit` is needed because `PrismaService` creates a `pg.Pool` that `$disconnect()` doesn't close.
