/**
 * PYG-583 · QA ของ S02 (PYG-557) — แอดมินกำหนด แก้ และแสดงระดับผู้ดูแล
 *
 * ยิง GraphQL เข้าแอปจริง (harness: test/support/qa-e2e.ts) ต่อ Postgres ทิ้งได้ใน Docker
 * TC_NO = PYG-557_NN · รายงานผล: docs/qa/pyg-583-care-level-report.md
 *
 * ต้นทางของ expected: story PYG-557 (R1–R7, E1–E9) + contract PYG-579 §4–§5 (error code / changed / needsReview)
 * ไม่ตัดสินว่าระดับที่แอดมินเลือกถูกหรือไม่ (เกณฑ์ยังไม่มี) — ตรวจเฉพาะกลไก
 *
 * ค่าเริ่มต้นจาก migration (AC6) จำลองด้วยแถวที่ care_level = 'basic', care_level_set_by = NULL
 * (DB ทิ้งได้สร้างจาก schema.prisma ไม่ได้ replay migration) — ข้อมูลจริงหลัง migration ตรวจบน production แยก
 */
import {
  bootstrap,
  codeOf,
  describeDb,
  GqlBody,
  Harness,
} from './support/qa-e2e';

type Level = 'BASIC' | 'INTERMEDIATE' | 'ADVANCED';
const LEVELS: Level[] = ['BASIC', 'INTERMEDIATE', 'ADVANCED'];
const DB_LEVEL: Record<Level, string> = {
  BASIC: 'basic',
  INTERMEDIATE: 'intermediate',
  ADVANCED: 'advanced',
};

type Info = {
  caregiverId: string;
  level: Level | null;
  setBy: string | null;
  setByName: string | null;
  setAt: string | null;
  needsReview: boolean;
};
type Change = {
  id: string;
  oldLevel: Level | null;
  newLevel: Level;
  changedBy: string | null;
  changedByName: string | null;
  reason: string | null;
  source: 'ADMIN_UPDATE' | 'KYC_APPROVAL' | 'MIGRATION_DEFAULT';
  createdAt: string;
};

const INFO = 'caregiverId level setBy setByName setAt needsReview';
const APPROVE = `mutation($id: ID!, $l: String) { approveKyc(caregiverId: $id, careLevel: $l) { id kycStatus careLevel } }`;
const REJECT = `mutation($i: RejectKycInput!) { rejectKyc(input: $i) { id kycStatus careLevel } }`;
const SET = `mutation($i: SetCaregiverCareLevelInput!) { setCaregiverCareLevel(input: $i) { changed careLevel { ${INFO} } } }`;
const HISTORY = `query($id: ID!) { caregiverCareLevelHistory(caregiverId: $id) { id oldLevel newLevel changedBy changedByName reason source createdAt } }`;
const DETAIL = `query($id: ID!) { adminKycDetail(caregiverId: $id) { careLevelInfo { ${INFO} } caregiver { id careLevel } } }`;
const LIST = `query($s: String) { adminKycList(input: { status: all, search: $s, limit: 50 }) { items { id careLevel careLevelNeedsReview } } }`;
const MINE = `query { myCaregiverProfile { id kycStatus careLevel } }`;

const dataOf = <T>(body: GqlBody, field: string): T =>
  (body.data as Record<string, unknown> | null)?.[field] as T;

describeDb('PYG-583 · S02 caregiver care level (PYG-557)', () => {
  let h: Harness;
  let admin: Awaited<ReturnType<Harness['seedAdmin']>>;
  let admin2: Awaited<ReturnType<Harness['seedAdmin']>>;

  beforeAll(async () => {
    h = await bootstrap();
    admin = await h.seedAdmin();
    admin2 = await h.seedAdmin();
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  /** ผู้ดูแลที่ส่ง KYC แล้ว รอตรวจ ยังไม่มีระดับ (story R7) */
  const pending = () =>
    h.seedCaregiver({ kycStatus: 'pending', careLevel: null });

  /** ผู้ดูแลที่แอดมินอนุมัติผ่าน API จริงพร้อมระดับ */
  async function approvedAt(level: Level, by = admin) {
    const cg = await pending();
    const body = await h.gql(by.token, APPROVE, {
      id: cg.caregiverId,
      l: level,
    });
    if (body.errors) throw new Error(JSON.stringify(body.errors));
    return cg;
  }

  /** ผู้ดูแลเดิมหลัง migration: verified + ระดับ ต้น + ไม่มีผู้กำหนด (story R6) */
  async function migrationDefault() {
    // เหมือน migration 20261007010000: care_level = 'basic', set_at = now() ของ migration, set_by = NULL
    // migration รันไปก่อนแล้ว — ตั้งเวลาชัด ๆ ไม่พึ่ง now() ของ Prisma (นาฬิกาเครื่อง ≠ นาฬิกา DB)
    const migratedAt = new Date('2026-10-18T00:00:00Z');
    const cg = await h.seedCaregiver({ careLevel: 'basic' });
    await h.prisma.caregiver.update({
      where: { id: cg.caregiverId },
      data: { careLevelSetAt: migratedAt },
    });
    await h.prisma.caregiver_care_level_logs.create({
      data: {
        caregiver_id: cg.caregiverId,
        old_level: null,
        new_level: 'basic',
        changed_by: null,
        reason: 'migration_default',
        created_at: migratedAt,
      },
    });
    return cg;
  }

  const row = (id: string) =>
    h.prisma.caregiver.findUniqueOrThrow({
      where: { id },
      select: {
        kycStatus: true,
        careLevel: true,
        careLevelSetBy: true,
        careLevelSetAt: true,
      },
    });
  const logCount = (id: string) =>
    h.prisma.caregiver_care_level_logs.count({ where: { caregiver_id: id } });
  /**
   * เวลาของ DB — ระบบบันทึกเวลาระดับด้วย clock_timestamp() ของ DB
   * ห้ามเทียบกับ Date.now(): นาฬิกา Postgres ใน Docker เคยช้ากว่าเครื่อง ~15 วินาที
   */
  const dbNow = async () =>
    (
      await h.prisma.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
    )[0].now.getTime();
  const history = async (id: string, by = admin) =>
    dataOf<Change[]>(
      await h.gql(by.token, HISTORY, { id }),
      'caregiverCareLevelHistory',
    );
  const set = (
    caregiverId: string,
    level: string | null,
    reason: string | null = 'QA ทบทวนระดับ',
    by: { token: string } = admin,
  ) => h.gql(by.token, SET, { i: { caregiverId, level, reason } });

  // ─── AC1 ────────────────────────────────────────────────────────────────

  it.each(LEVELS)(
    'PYG-557_01 (AC1) Verify that approving KYC with level %s saves that level',
    async (level) => {
      const cg = await pending();
      const body = await h.gql(admin.token, APPROVE, {
        id: cg.caregiverId,
        l: level,
      });
      expect(body.errors).toBeUndefined();
      expect(dataOf(body, 'approveKyc')).toMatchObject({
        kycStatus: 'verified',
        careLevel: level,
      });
      expect(await row(cg.caregiverId)).toMatchObject({
        kycStatus: 'verified',
        careLevel: DB_LEVEL[level],
      });
      const [first] = await history(cg.caregiverId);
      expect(first).toMatchObject({
        oldLevel: null,
        newLevel: level,
        changedBy: admin.id,
        source: 'KYC_APPROVAL',
        reason: null,
      });
    },
  );

  it('PYG-557_02 (AC1) Verify that the CareLevel options are exactly BASIC, INTERMEDIATE and ADVANCED', async () => {
    const body = await h.gql(
      admin.token,
      `query { __type(name: "CareLevel") { enumValues { name } } }`,
    );
    const values = (
      body.data as { __type: { enumValues: { name: string }[] } }
    ).__type.enumValues.map((v) => v.name);
    expect(values.sort()).toEqual([...LEVELS].sort());
  });

  it.each(['EXPERT', 'basic', 'ต้น', 'toString'])(
    'PYG-557_03 (AC1/E9) Verify that approving with level %p returns CARE_LEVEL_INVALID and writes nothing',
    async (bad) => {
      const cg = await pending();
      const body = await h.gql(admin.token, APPROVE, {
        id: cg.caregiverId,
        l: bad,
      });
      expect(codeOf(body)).toBe('CARE_LEVEL_INVALID');
      expect(body.errors?.[0]?.extensions).toMatchObject({
        allowed: LEVELS,
        received: bad,
      });
      expect(await row(cg.caregiverId)).toMatchObject({
        kycStatus: 'pending',
        careLevel: null,
        careLevelSetBy: null,
      });
      expect(await logCount(cg.caregiverId)).toBe(0);
      expect(
        await h.prisma.kycReview.count({
          where: { caregiverId: cg.caregiverId },
        }),
      ).toBe(0);
    },
  );

  it('PYG-557_04 (AC1/E9) Verify that changing to a level outside the list returns CARE_LEVEL_INVALID and keeps the old level', async () => {
    const cg = await approvedAt('INTERMEDIATE');
    const before = await logCount(cg.caregiverId);
    expect(codeOf(await set(cg.caregiverId, 'EXPERT'))).toBe(
      'CARE_LEVEL_INVALID',
    );
    expect((await row(cg.caregiverId)).careLevel).toBe('intermediate');
    expect(await logCount(cg.caregiverId)).toBe(before);
  });

  // ─── AC2 ────────────────────────────────────────────────────────────────

  it.each([
    ['omitted', undefined],
    ['null', null],
    ['empty', ''],
    ['blank', '   '],
  ])(
    'PYG-557_05 (AC2/E1) Verify that approving with the level %s returns CARE_LEVEL_REQUIRED and kyc_status stays pending',
    async (_label, level) => {
      const cg = await pending();
      const vars: Record<string, unknown> = { id: cg.caregiverId };
      if (level !== undefined) vars.l = level;
      const body = await h.gql(admin.token, APPROVE, vars);
      expect(codeOf(body)).toBe('CARE_LEVEL_REQUIRED');
      expect(await row(cg.caregiverId)).toMatchObject({
        kycStatus: 'pending',
        careLevel: null,
      });
      expect(await logCount(cg.caregiverId)).toBe(0);
      expect(
        await h.prisma.kycReview.count({
          where: { caregiverId: cg.caregiverId },
        }),
      ).toBe(0);
    },
  );

  it('PYG-557_06 (AC2/E2) Verify that an admin can reject KYC without choosing a level', async () => {
    const cg = await pending();
    const body = await h.gql(admin.token, REJECT, {
      i: {
        caregiverId: cg.caregiverId,
        reasons: [{ title: 'เอกสารไม่ชัดเจน' }],
      },
    });
    expect(body.errors).toBeUndefined();
    expect(dataOf(body, 'rejectKyc')).toMatchObject({ kycStatus: 'rejected' });
    expect(await row(cg.caregiverId)).toMatchObject({
      kycStatus: 'rejected',
      careLevel: null,
    });
    expect(await logCount(cg.caregiverId)).toBe(0);
  });

  // ─── AC3 ────────────────────────────────────────────────────────────────

  it('PYG-557_07 (AC3) Verify that the level is stored with the logged-in admin and the time of approval, and the KYC review shows them', async () => {
    const cg = await pending();
    const t0 = await dbNow();
    const body = await h.gql(admin.token, APPROVE, {
      id: cg.caregiverId,
      l: 'ADVANCED',
    });
    const t1 = await dbNow();
    expect(body.errors).toBeUndefined();

    const saved = await row(cg.caregiverId);
    expect(saved.careLevelSetBy).toBe(admin.id);
    expect(saved.careLevelSetAt!.getTime()).toBeGreaterThanOrEqual(t0);
    expect(saved.careLevelSetAt!.getTime()).toBeLessThanOrEqual(t1);

    const detail = dataOf<{
      careLevelInfo: Info;
      caregiver: { careLevel: Level };
    }>(
      await h.gql(admin.token, DETAIL, { id: cg.caregiverId }),
      'adminKycDetail',
    );
    expect(detail.careLevelInfo).toEqual({
      caregiverId: cg.caregiverId,
      level: 'ADVANCED',
      setBy: admin.id,
      setByName: admin.displayName,
      setAt: saved.careLevelSetAt!.toISOString(),
      needsReview: false,
    });
    expect(detail.caregiver.careLevel).toBe('ADVANCED');
  });

  // ─── AC4 ────────────────────────────────────────────────────────────────

  it('PYG-557_08 (AC4) Verify that an admin can change the level of a verified caregiver and a history row records old, new, who, reason and when', async () => {
    const cg = await approvedAt('BASIC');
    const t0 = await dbNow();
    const body = await set(
      cg.caregiverId,
      'INTERMEDIATE',
      'ผ่านอบรมเพิ่ม',
      admin2,
    );
    expect(body.errors).toBeUndefined();
    expect(dataOf(body, 'setCaregiverCareLevel')).toMatchObject({
      changed: true,
      careLevel: {
        level: 'INTERMEDIATE',
        setBy: admin2.id,
        setByName: admin2.displayName,
        needsReview: false,
      },
    });
    expect(await row(cg.caregiverId)).toMatchObject({
      careLevel: 'intermediate',
      careLevelSetBy: admin2.id,
    });
    const [latest] = await history(cg.caregiverId);
    expect(latest).toMatchObject({
      oldLevel: 'BASIC',
      newLevel: 'INTERMEDIATE',
      changedBy: admin2.id,
      changedByName: admin2.displayName,
      reason: 'ผ่านอบรมเพิ่ม',
      source: 'ADMIN_UPDATE',
    });
    expect(new Date(latest.createdAt).getTime()).toBeGreaterThanOrEqual(t0);
  });

  it('PYG-557_09 (AC4) Verify that several changes are listed newest first and each old level is the previous new level', async () => {
    const cg = await approvedAt('BASIC');
    for (const level of ['ADVANCED', 'INTERMEDIATE', 'BASIC'] as Level[]) {
      expect((await set(cg.caregiverId, level)).errors).toBeUndefined();
    }
    const rows = await history(cg.caregiverId);
    expect(rows.map((r) => [r.oldLevel, r.newLevel, r.source])).toEqual([
      ['INTERMEDIATE', 'BASIC', 'ADMIN_UPDATE'],
      ['ADVANCED', 'INTERMEDIATE', 'ADMIN_UPDATE'],
      ['BASIC', 'ADVANCED', 'ADMIN_UPDATE'],
      [null, 'BASIC', 'KYC_APPROVAL'],
    ]);
    const times = rows.map((r) => new Date(r.createdAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(new Set(times).size).toBe(times.length);
  });

  it.each([null, '', '   '])(
    'PYG-557_10 (AC4) Verify that changing the level with reason %p returns CARE_LEVEL_REASON_REQUIRED and changes nothing',
    async (reason) => {
      const cg = await approvedAt('BASIC');
      const before = await logCount(cg.caregiverId);
      expect(codeOf(await set(cg.caregiverId, 'ADVANCED', reason))).toBe(
        'CARE_LEVEL_REASON_REQUIRED',
      );
      expect((await row(cg.caregiverId)).careLevel).toBe('basic');
      expect(await logCount(cg.caregiverId)).toBe(before);
    },
  );

  // ─── AC5 ────────────────────────────────────────────────────────────────

  it.each(LEVELS)(
    'PYG-557_11 (AC5) Verify that the caregiver sees their own level %s in their profile',
    async (level) => {
      const cg = await approvedAt(level);
      const body = await h.gql(cg.token, MINE);
      expect(body.errors).toBeUndefined();
      expect(dataOf(body, 'myCaregiverProfile')).toMatchObject({
        id: cg.caregiverId,
        careLevel: level,
      });
    },
  );

  it('PYG-557_12 (AC5) Verify that the caregiver sees the new level right after an admin changes it', async () => {
    const cg = await approvedAt('ADVANCED');
    expect((await set(cg.caregiverId, 'BASIC')).errors).toBeUndefined();
    expect(
      dataOf<{ careLevel: Level }>(
        await h.gql(cg.token, MINE),
        'myCaregiverProfile',
      ).careLevel,
    ).toBe('BASIC');
  });

  // ─── AC6 ────────────────────────────────────────────────────────────────

  it('PYG-557_13 (AC6/E3) Verify that a migration-default caregiver is flagged as not reviewed in the KYC list and detail', async () => {
    const cg = await migrationDefault();
    const items = dataOf<{
      items: { id: string; careLevel: Level; careLevelNeedsReview: boolean }[];
    }>(
      await h.gql(admin.token, LIST, { s: cg.displayName }),
      'adminKycList',
    ).items;
    expect(items.find((i) => i.id === cg.caregiverId)).toEqual({
      id: cg.caregiverId,
      careLevel: 'BASIC',
      careLevelNeedsReview: true,
    });
    const info = dataOf<{ careLevelInfo: Info }>(
      await h.gql(admin.token, DETAIL, { id: cg.caregiverId }),
      'adminKycDetail',
    ).careLevelInfo;
    expect(info).toMatchObject({
      level: 'BASIC',
      setBy: null,
      setByName: null,
      setAt: '2026-10-18T00:00:00.000Z',
      needsReview: true,
    });
    const [backfill] = await history(cg.caregiverId);
    expect(backfill).toMatchObject({
      oldLevel: null,
      newLevel: 'BASIC',
      changedBy: null,
      reason: null,
      source: 'MIGRATION_DEFAULT',
    });
  });

  it('PYG-557_14 (AC6) Verify that after an admin reviews a migration default (same level) the flag clears and the admin is recorded', async () => {
    const cg = await migrationDefault();
    const body = await set(
      cg.caregiverId,
      'BASIC',
      'ทบทวนแล้ว ระดับต้นถูกต้อง',
    );
    expect(body.errors).toBeUndefined();
    expect(dataOf(body, 'setCaregiverCareLevel')).toMatchObject({
      changed: true,
      careLevel: { level: 'BASIC', setBy: admin.id, needsReview: false },
    });
    const items = dataOf<{
      items: { id: string; careLevelNeedsReview: boolean }[];
    }>(
      await h.gql(admin.token, LIST, { s: cg.displayName }),
      'adminKycList',
    ).items;
    expect(
      items.find((i) => i.id === cg.caregiverId)?.careLevelNeedsReview,
    ).toBe(false);
    const [latest] = await history(cg.caregiverId);
    expect(latest).toMatchObject({
      oldLevel: 'BASIC',
      newLevel: 'BASIC',
      changedBy: admin.id,
      source: 'ADMIN_UPDATE',
    });
  });

  // ─── Edge cases ─────────────────────────────────────────────────────────

  it('PYG-557_15 (E4) Verify that saving the same level an admin already set adds no history row and keeps the original setter', async () => {
    const cg = await approvedAt('INTERMEDIATE');
    const before = await row(cg.caregiverId);
    const count = await logCount(cg.caregiverId);
    const body = await set(cg.caregiverId, 'INTERMEDIATE', null, admin2);
    expect(body.errors).toBeUndefined();
    expect(dataOf(body, 'setCaregiverCareLevel')).toMatchObject({
      changed: false,
      careLevel: { level: 'INTERMEDIATE', setBy: admin.id },
    });
    expect(await logCount(cg.caregiverId)).toBe(count);
    expect(await row(cg.caregiverId)).toEqual(before);
  });

  it.each([
    ['pending', 'pending'],
    ['never submitted', 'none'],
    ['rejected', 'rejected'],
  ])(
    'PYG-557_16 (E5) Verify that a %s caregiver opens their profile and sees no level without an error',
    async (_l, kycStatus) => {
      const cg = await h.seedCaregiver({ kycStatus, careLevel: null });
      const body = await h.gql(cg.token, MINE);
      expect(body.errors).toBeUndefined();
      expect(dataOf(body, 'myCaregiverProfile')).toMatchObject({
        kycStatus,
        careLevel: null,
      });
    },
  );

  it('PYG-557_17 (E6) Verify that two admins changing the same caregiver at once both land in history and the latest wins', async () => {
    const cg = await approvedAt('BASIC');
    const [a, b] = await Promise.all([
      set(cg.caregiverId, 'INTERMEDIATE', 'แอดมิน 1', admin),
      set(cg.caregiverId, 'ADVANCED', 'แอดมิน 2', admin2),
    ]);
    expect(a.errors).toBeUndefined();
    expect(b.errors).toBeUndefined();
    const rows = (await history(cg.caregiverId)).filter(
      (r) => r.source === 'ADMIN_UPDATE',
    );
    expect(rows).toHaveLength(2);
    const [latest, earlier] = rows;
    // แถวหลังต้องเห็นค่าที่แถวแรกเพิ่งเขียนเป็นค่าเดิม (ไม่ใช่ BASIC ทั้งคู่)
    expect(earlier.oldLevel).toBe('BASIC');
    expect(latest.oldLevel).toBe(earlier.newLevel);
    expect((await row(cg.caregiverId)).careLevel).toBe(
      DB_LEVEL[latest.newLevel],
    );
    expect((await row(cg.caregiverId)).careLevelSetBy).toBe(latest.changedBy);
  });

  it.each(['pending', 'rejected', 'none'])(
    'PYG-557_18 (R7) Verify that setCaregiverCareLevel on a %s caregiver returns CARE_LEVEL_KYC_NOT_VERIFIED and gives no level',
    async (kycStatus) => {
      const cg = await h.seedCaregiver({ kycStatus, careLevel: null });
      const body = await set(cg.caregiverId, 'ADVANCED');
      expect(codeOf(body)).toBe('CARE_LEVEL_KYC_NOT_VERIFIED');
      expect(body.errors?.[0]?.extensions).toMatchObject({ kycStatus });
      expect((await row(cg.caregiverId)).careLevel).toBeNull();
      expect(await logCount(cg.caregiverId)).toBe(0);
    },
  );

  // ─── สิทธิ์ ──────────────────────────────────────────────────────────────

  it('PYG-557_19 (R3) Verify that a caregiver cannot set their own level, approve themselves, or send a level through KYC input', async () => {
    const cg = await approvedAt('BASIC');
    expect(codeOf(await set(cg.caregiverId, 'ADVANCED', 'ขอเอง', cg))).toBe(
      'FORBIDDEN',
    );
    const self = await pending();
    expect(
      codeOf(
        await h.gql(self.token, APPROVE, {
          id: self.caregiverId,
          l: 'ADVANCED',
        }),
      ),
    ).toBe('FORBIDDEN');
    expect((await row(cg.caregiverId)).careLevel).toBe('basic');
    expect(await row(self.caregiverId)).toMatchObject({
      kycStatus: 'pending',
      careLevel: null,
    });
    // ไม่มีช่องทางให้ผู้ดูแลส่งระดับมาเอง: input ฝั่งผู้ดูแลไม่มี field careLevel
    for (const input of [
      'KycInput',
      'UpdateCaregiverInput',
      // UpdateProfileInput (AuthModule) ไม่อยู่ใน harness — ตรวจจาก DTO แทน (รายงาน §3)
    ]) {
      const body = await h.gql(
        cg.token,
        `query($n: String!) { __type(name: $n) { inputFields { name } } }`,
        { n: input },
      );
      const fields = (
        body.data as { __type: { inputFields: { name: string }[] } | null }
      ).__type?.inputFields.map((f) => f.name);
      // input ต้องมีจริง (ไม่งั้น not.toContain ผ่านเปล่า ๆ เพราะได้ [])
      expect(fields?.length).toBeGreaterThan(0);
      expect(fields).not.toContain('careLevel');
    }
  });

  it('PYG-557_20 Verify that caregiver A cannot set or read the level or history of caregiver B', async () => {
    const a = await approvedAt('BASIC');
    const b = await approvedAt('INTERMEDIATE');
    expect(codeOf(await set(b.caregiverId, 'BASIC', 'x', a))).toBe('FORBIDDEN');
    expect(codeOf(await h.gql(a.token, HISTORY, { id: b.caregiverId }))).toBe(
      'FORBIDDEN',
    );
    const detail = await h.gql(a.token, DETAIL, { id: b.caregiverId });
    expect(codeOf(detail)).toBe('FORBIDDEN');
    expect(detail.data).toBeNull();
    expect((await row(b.caregiverId)).careLevel).toBe('intermediate');
  });

  it('PYG-557_21 Verify that an Elder user cannot set a level or read the history', async () => {
    const cg = await approvedAt('BASIC');
    const elder = await h.seedUser('elder');
    expect(codeOf(await set(cg.caregiverId, 'ADVANCED', 'x', elder))).toBe(
      'FORBIDDEN',
    );
    expect(
      codeOf(await h.gql(elder.token, HISTORY, { id: cg.caregiverId })),
    ).toBe('FORBIDDEN');
    expect((await row(cg.caregiverId)).careLevel).toBe('basic');
  });

  it('PYG-557_22 Verify that calling set level, history or approve without logging in is rejected', async () => {
    const cg = await approvedAt('BASIC');
    const p = await pending();
    expect(
      codeOf(
        await h.gql(null, SET, {
          i: { caregiverId: cg.caregiverId, level: 'ADVANCED', reason: 'x' },
        }),
      ),
    ).toBe('UNAUTHENTICATED');
    expect(codeOf(await h.gql(null, HISTORY, { id: cg.caregiverId }))).toBe(
      'UNAUTHENTICATED',
    );
    expect(
      codeOf(await h.gql(null, APPROVE, { id: p.caregiverId, l: 'ADVANCED' })),
    ).toBe('UNAUTHENTICATED');
    expect((await row(cg.caregiverId)).careLevel).toBe('basic');
    expect((await row(p.caregiverId)).kycStatus).toBe('pending');
  });

  it('PYG-557_23 Verify that a Super Admin (role 4) can change a level', async () => {
    const superAdmin = await h.seedUser('superadmin', 4);
    const cg = await approvedAt('BASIC');
    const body = await set(
      cg.caregiverId,
      'ADVANCED',
      'super admin',
      superAdmin,
    );
    expect(body.errors).toBeUndefined();
    expect((await row(cg.caregiverId)).careLevelSetBy).toBe(superAdmin.id);
  });
});
