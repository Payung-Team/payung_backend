/**
 * PYG-594 · QA ของ S04 (PYG-559) — จำกัดประเภทงานตามวิชาชีพและใบประกอบฯ
 *
 * ยิง GraphQL เข้าแอปจริง (harness: test/support/qa-e2e.ts) ต่อ Postgres ทิ้งได้ใน Docker
 * TC_NO = PYG-559_NN · รายงานผล: docs/qa/pyg-594-job-type-report.md
 *
 * ต้นทางของ expected: ตารางจับคู่ที่เคาะแล้ว (PYG-590, Sammy 7 ต.ค. 2026)
 *   physiotherapy = นักกายภาพบำบัด + ใบประกอบฯ อนุมัติและยังไม่หมดอายุ
 *   medication (จัดยาตามแพทย์สั่ง ไม่รวมฉีดยา), general_care, bedridden_care, companion = ทุกวิชาชีพ
 * ใบประกอบฯ เป็น precondition (สร้างแถว kyc_documents ตรง) — การอัปโหลด/ตรวจใบเป็นของ S03 (PYG-589)
 * AC6 (data migration) ตรวจบน production แยก — ดูรายงาน
 */
import { randomUUID } from 'crypto';
import {
  bootstrap,
  codeOf,
  describeDb,
  GqlBody,
  Harness,
} from './support/qa-e2e';

type Profession = 'general_caregiver' | 'nurse' | 'physiotherapist';
type LicenseState = 'none' | 'pending' | 'approved' | 'rejected' | 'expired';
type Option = {
  jobType: string;
  selectable: boolean;
  blockedReason: string | null;
};

const NOW = new Date('2026-11-10T03:00:00Z');
const NEXT_YEAR = new Date('2027-11-10T16:59:59.999Z');
const LAST_MONTH = new Date('2026-10-10T16:59:59.999Z');
const UNBOUND = ['general_care', 'bedridden_care', 'companion', 'medication'];
const ALL = [...UNBOUND, 'physiotherapy'];

const OPTIONS = `query { myJobTypeOptions { jobType selectable blockedReason } }`;
const UPDATE = `mutation($i: UpdateWorkConditionInput!) { updateWorkCondition(input: $i) { jobTypes } }`;
const MINE = `query { myWorkCondition { jobTypes } }`;

const dataOf = <T>(body: GqlBody, field: string): T =>
  (body.data as Record<string, unknown> | null)?.[field] as T;
const extOf = (body: GqlBody) => body.errors?.[0]?.extensions ?? {};

jest.setTimeout(30_000);

describeDb('PYG-594 · S04 job type restriction (PYG-559)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await bootstrap();
  }, 60_000);
  beforeEach(() => h.clock.set(NOW));
  afterAll(async () => {
    h?.clock.reset();
    await h?.close();
  });

  /** ผู้ดูแล verified ตามวิชาชีพ + สถานะใบประกอบฯ ที่ต้องการ */
  function caregiver(profession: Profession, license: LicenseState = 'none') {
    const map: Record<
      LicenseState,
      { status: string; expiresAt: Date | null } | null
    > = {
      none: null,
      pending: { status: 'pending', expiresAt: NEXT_YEAR },
      approved: { status: 'approved', expiresAt: NEXT_YEAR },
      rejected: { status: 'rejected', expiresAt: NEXT_YEAR },
      expired: { status: 'expired', expiresAt: LAST_MONTH },
    };
    return h.seedCaregiver({ profession, license: map[license] });
  }

  const options = async (token: string) => {
    const body = await h.gql(token, OPTIONS);
    if (body.errors) throw new Error(JSON.stringify(body.errors));
    return dataOf<Option[]>(body, 'myJobTypeOptions');
  };
  const optionOf = async (token: string, jobType: string) =>
    (await options(token)).find((o) => o.jobType === jobType)!;
  const save = (token: string, jobTypes: string[]) =>
    h.gql(token, UPDATE, { i: { jobTypes } });
  const stored = async (caregiverId: string) =>
    (
      await h.prisma.caregiverJobType.findMany({
        where: { caregiverId },
        select: { jobType: true },
      })
    )
      .map((r) => r.jobType as string)
      .sort();

  // ─── AC1 · ผู้ดูแลทั่วไป ─────────────────────────────────────────────────

  it('PYG-559_01 (AC1) Verify that the options list has all 5 job types and physiotherapy is blocked for a general caregiver with a reason', async () => {
    const cg = await caregiver('general_caregiver');
    const list = await options(cg.token);
    expect(list.map((o) => o.jobType)).toEqual([
      'general_care',
      'bedridden_care',
      'companion',
      'medication',
      'physiotherapy',
    ]);
    expect(list.find((o) => o.jobType === 'physiotherapy')).toEqual({
      jobType: 'physiotherapy',
      selectable: false,
      blockedReason: 'PROFESSION_MISMATCH',
    });
    for (const t of UNBOUND)
      expect(list.find((o) => o.jobType === t)).toEqual({
        jobType: t,
        selectable: true,
        blockedReason: null,
      });
  });

  it('PYG-559_02 (AC1) Verify that a general caregiver can save all 4 unbound job types including medication', async () => {
    const cg = await caregiver('general_caregiver');
    const body = await save(cg.token, UNBOUND);
    expect(body.errors).toBeUndefined();
    expect(await stored(cg.caregiverId)).toEqual([...UNBOUND].sort());
  });

  // ─── AC2 · นักกายภาพฯ ใบผ่าน / พยาบาล ────────────────────────────────────

  it('PYG-559_03 (AC2) Verify that a physiotherapist with an approved license can select and save physiotherapy', async () => {
    const cg = await caregiver('physiotherapist', 'approved');
    expect(await optionOf(cg.token, 'physiotherapy')).toMatchObject({
      selectable: true,
      blockedReason: null,
    });
    expect((await save(cg.token, ALL)).errors).toBeUndefined();
    expect(await stored(cg.caregiverId)).toEqual([...ALL].sort());
  });

  it('PYG-559_04 (AC2) Verify that a nurse with an approved license cannot select physiotherapy', async () => {
    const cg = await caregiver('nurse', 'approved');
    expect(await optionOf(cg.token, 'physiotherapy')).toMatchObject({
      selectable: false,
      blockedReason: 'PROFESSION_MISMATCH',
    });
  });

  // ─── AC3 · ให้ยา ไม่ผูกวิชาชีพ ───────────────────────────────────────────

  it.each<[Profession, LicenseState]>([
    ['general_caregiver', 'none'],
    ['nurse', 'approved'],
    ['nurse', 'none'],
    ['nurse', 'expired'],
    ['physiotherapist', 'approved'],
    ['physiotherapist', 'none'],
    ['physiotherapist', 'expired'],
  ])(
    'PYG-559_05 (AC3) Verify that a %s with license %s can select and save medication',
    async (profession, license) => {
      const cg = await caregiver(profession, license);
      expect(await optionOf(cg.token, 'medication')).toMatchObject({
        selectable: true,
      });
      expect((await save(cg.token, ['medication'])).errors).toBeUndefined();
      expect(await stored(cg.caregiverId)).toEqual(['medication']);
    },
  );

  // ─── AC4 · นักกายภาพฯ ใบไม่ผ่าน ────────────────────────────────────────

  it.each<[LicenseState, string]>([
    ['pending', 'LICENSE_NOT_APPROVED'],
    ['rejected', 'LICENSE_NOT_APPROVED'],
    ['none', 'LICENSE_NOT_APPROVED'],
    ['expired', 'LICENSE_EXPIRED'],
  ])(
    'PYG-559_06 (AC4) Verify that a physiotherapist whose license is %s cannot select physiotherapy (reason %s)',
    async (license, reason) => {
      const cg = await caregiver('physiotherapist', license);
      expect(await optionOf(cg.token, 'physiotherapy')).toEqual({
        jobType: 'physiotherapy',
        selectable: false,
        blockedReason: reason,
      });
    },
  );

  it('PYG-559_07 (AC4 · edge) Verify that an approved license past its expiry is blocked before the daily job flips the status', async () => {
    const cg = await caregiver('physiotherapist', 'approved');
    // ใบยังเป็น approved ใน DB แต่วันหมดอายุผ่านไปแล้ว
    h.clock.set(new Date('2027-11-11T09:00:00+07:00'));
    expect(await optionOf(cg.token, 'physiotherapy')).toMatchObject({
      selectable: false,
      blockedReason: 'LICENSE_EXPIRED',
    });
    const body = await save(cg.token, ['physiotherapy']);
    expect(codeOf(body)).toBe('JOB_TYPE_NOT_ALLOWED');
    expect(await stored(cg.caregiverId)).toEqual([]);
  });

  it('PYG-559_08 (AC4) Verify that a new pending license after an expired one reports LICENSE_NOT_APPROVED (latest license decides)', async () => {
    const cg = await caregiver('physiotherapist', 'expired');
    await h.prisma.kycDocument.create({
      data: {
        caregiverId: cg.caregiverId,
        userId: cg.id,
        documentType: 'professional_license',
        fileUrl: '',
        fileName: 'new.jpg',
        fileSize: 1,
        mimeType: 'image/jpeg',
        reviewStatus: 'pending',
        expiresAt: NEXT_YEAR,
        licenseNumber: `QA-${randomUUID().slice(0, 6)}`,
      },
    });
    expect(await optionOf(cg.token, 'physiotherapy')).toMatchObject({
      selectable: false,
      blockedReason: 'LICENSE_NOT_APPROVED',
    });
  });

  // ─── AC5 · API ตรง ─────────────────────────────────────────────────────

  it.each<[Profession, LicenseState, string]>([
    ['general_caregiver', 'none', 'PROFESSION_MISMATCH'],
    ['nurse', 'approved', 'PROFESSION_MISMATCH'],
    ['physiotherapist', 'pending', 'LICENSE_NOT_APPROVED'],
    ['physiotherapist', 'rejected', 'LICENSE_NOT_APPROVED'],
    ['physiotherapist', 'none', 'LICENSE_NOT_APPROVED'],
    ['physiotherapist', 'expired', 'LICENSE_EXPIRED'],
  ])(
    'PYG-559_09 (AC5) Verify that a %s (license %s) saving physiotherapy directly gets JOB_TYPE_NOT_ALLOWED and nothing is written',
    async (profession, license, reason) => {
      const cg = await caregiver(profession, license);
      await h.prisma.caregiverJobType.create({
        data: { caregiverId: cg.caregiverId, jobType: 'companion' },
      });
      const body = await save(cg.token, ['physiotherapy']);
      expect(codeOf(body)).toBe('JOB_TYPE_NOT_ALLOWED');
      expect(extOf(body)).toMatchObject({
        statusCode: 422,
        blocked: [{ jobType: 'physiotherapy', blockedReason: reason }],
      });
      // ของเดิมไม่ถูกลบ (replace-all ไม่เกิด)
      expect(await stored(cg.caregiverId)).toEqual(['companion']);
    },
  );

  it('PYG-559_10 (AC5/E4) Verify that a request mixing allowed and blocked types is rejected as a whole, including other sections', async () => {
    const cg = await caregiver('general_caregiver');
    await h.prisma.caregiverJobType.create({
      data: { caregiverId: cg.caregiverId, jobType: 'general_care' },
    });
    const body = await h.gql(cg.token, UPDATE, {
      i: {
        jobTypes: ['medication', 'companion', 'physiotherapy'],
        serviceLocations: ['accompany_outside'],
        serviceArea: { province: 'QA-จังหวัดใหม่' },
      },
    });
    expect(codeOf(body)).toBe('JOB_TYPE_NOT_ALLOWED');
    expect(extOf(body).blocked).toEqual([
      { jobType: 'physiotherapy', blockedReason: 'PROFESSION_MISMATCH' },
    ]);
    expect(await stored(cg.caregiverId)).toEqual(['general_care']);
    expect(
      await h.prisma.caregiverServiceLocation.count({
        where: { caregiverId: cg.caregiverId },
      }),
    ).toBe(0);
    expect(
      (
        await h.prisma.caregiver.findUniqueOrThrow({
          where: { id: cg.caregiverId },
          select: { serviceAreaProvince: true },
        })
      ).serviceAreaProvince,
    ).not.toBe('QA-จังหวัดใหม่');
  });

  it.each<Profession>(['general_caregiver', 'nurse', 'physiotherapist'])(
    'PYG-559_11 (AC5) Verify that a %s saving medication directly succeeds',
    async (profession) => {
      const cg = await caregiver(profession);
      const body = await save(cg.token, ['medication']);
      expect(body.errors).toBeUndefined();
      expect(
        dataOf<{ jobTypes: string[] }>(body, 'updateWorkCondition').jobTypes,
      ).toEqual(['medication']);
    },
  );

  it('PYG-559_12 (AC5) Verify that duplicate job types are saved once, and unknown or padded values are rejected without writing', async () => {
    const cg = await caregiver('general_caregiver');
    const ok = await save(cg.token, ['medication', 'medication', 'companion']);
    expect(ok.errors).toBeUndefined();
    expect(await stored(cg.caregiverId)).toEqual(['companion', 'medication']);
    // ค่าที่ไม่อยู่ในรายการ (รวมค่าที่มีช่องว่าง) ถูก DTO ปฏิเสธเป็น BAD_REQUEST ก่อนถึงตัวตรวจกฎ — ไม่มีการเขียน
    for (const bad of [[' medication '], [' physiotherapy '], ['surgery']]) {
      const body = await save(cg.token, bad);
      expect(codeOf(body)).toBe('BAD_REQUEST');
      expect(await stored(cg.caregiverId)).toEqual(['companion', 'medication']);
    }
  });

  // ─── Edge cases ─────────────────────────────────────────────────────────

  it('PYG-559_13 (E5) Verify that a caregiver with a leftover blocked type can save other sections, but must drop it to save job types', async () => {
    const cg = await caregiver('general_caregiver');
    // ค้างจากก่อน data migration
    await h.prisma.caregiverJobType.createMany({
      data: [
        { caregiverId: cg.caregiverId, jobType: 'physiotherapy' },
        { caregiverId: cg.caregiverId, jobType: 'companion' },
      ],
    });
    // บันทึก section อื่นโดยไม่ส่ง jobTypes — ไม่ถูกตรวจ ไม่แตะประเภทงาน
    const other = await h.gql(cg.token, UPDATE, {
      i: { serviceLocations: ['at_home'] },
    });
    expect(other.errors).toBeUndefined();
    expect(await stored(cg.caregiverId)).toEqual([
      'companion',
      'physiotherapy',
    ]);
    // ส่งรายการเดิมทั้งหมดกลับไป (แบบที่หน้าจอทำ) — ถูกปฏิเสธจนกว่าจะเอาออก
    expect(codeOf(await save(cg.token, ['physiotherapy', 'companion']))).toBe(
      'JOB_TYPE_NOT_ALLOWED',
    );
    expect((await save(cg.token, ['companion'])).errors).toBeUndefined();
    expect(await stored(cg.caregiverId)).toEqual(['companion']);
  });

  it('PYG-559_14 (E7) Verify that a caregiver with no job types left can still open their work conditions and options', async () => {
    const cg = await caregiver('general_caregiver');
    const mine = await h.gql(cg.token, MINE);
    expect(mine.errors).toBeUndefined();
    expect(
      dataOf<{ jobTypes: string[] }>(mine, 'myWorkCondition').jobTypes,
    ).toEqual([]);
    expect(await options(cg.token)).toHaveLength(5);
    expect((await save(cg.token, [])).errors).toBeUndefined();
  });

  it('PYG-559_15 Verify that a pending profession change does not unlock physiotherapy (current approved profession decides)', async () => {
    const cg = await caregiver('general_caregiver');
    // ใบนักกายภาพฯ ที่แนบมากับคำขอ — อนุมัติแล้วในตัวเอกสาร แต่คำขอเปลี่ยนวิชาชีพยังรอแอดมิน
    const doc = await h.prisma.kycDocument.create({
      data: {
        userId: cg.id,
        documentType: 'professional_license',
        fileUrl: '',
        fileName: 'physio.jpg',
        fileSize: 1,
        mimeType: 'image/jpeg',
        reviewStatus: 'pending',
        expiresAt: NEXT_YEAR,
        licenseNumber: `QA-${randomUUID().slice(0, 6)}`,
      },
    });
    const req = await h.gql(
      cg.token,
      `mutation($i: ProfessionChangeInput!) { requestProfessionChange(input: $i) { id status } }`,
      { i: { profession: 'physiotherapist', licenseDocumentId: doc.id } },
    );
    expect(req.errors).toBeUndefined();
    expect(await optionOf(cg.token, 'physiotherapy')).toMatchObject({
      selectable: false,
      blockedReason: 'PROFESSION_MISMATCH',
    });
    expect(codeOf(await save(cg.token, ['physiotherapy']))).toBe(
      'JOB_TYPE_NOT_ALLOWED',
    );
  });

  it('PYG-559_16 Verify that a caregiver whose KYC is not verified cannot save job types', async () => {
    const cg = await h.seedCaregiver({ kycStatus: 'pending', careLevel: null });
    const body = await save(cg.token, ['medication']);
    expect(body.errors).toBeDefined();
    expect(await stored(cg.caregiverId)).toEqual([]);
  });

  // ─── สิทธิ์ ──────────────────────────────────────────────────────────────

  it("PYG-559_17 Verify that caregiver A's save only ever touches A's own job types (no way to target B)", async () => {
    const a = await caregiver('general_caregiver');
    const b = await caregiver('physiotherapist', 'approved');
    await h.prisma.caregiverJobType.create({
      data: { caregiverId: b.caregiverId, jobType: 'physiotherapy' },
    });
    // input ไม่มีช่อง caregiverId — ส่งมาเองถูก GraphQL ปฏิเสธ
    const forged = await h.gql(a.token, UPDATE, {
      i: { jobTypes: ['companion'], caregiverId: b.caregiverId },
    });
    expect(forged.errors).toBeDefined();
    expect((await save(a.token, ['companion'])).errors).toBeUndefined();
    expect(await stored(b.caregiverId)).toEqual(['physiotherapy']);
    expect(await stored(a.caregiverId)).toEqual(['companion']);
  });

  it('PYG-559_18 Verify that an Elder user and an admin cannot save job types or read job type options', async () => {
    const elder = await h.seedUser('elder');
    const admin = await h.seedAdmin();
    for (const u of [elder, admin]) {
      expect(codeOf(await save(u.token, ['medication']))).toBe('FORBIDDEN');
      expect(codeOf(await h.gql(u.token, OPTIONS))).toBe('FORBIDDEN');
    }
  });

  it('PYG-559_19 Verify that saving or reading job types without logging in is rejected', async () => {
    expect(codeOf(await save('', ['medication']))).toBe('UNAUTHENTICATED');
    expect(codeOf(await h.gql(null, OPTIONS))).toBe('UNAUTHENTICATED');
  });

  it('PYG-559_20 Verify that the admin caregiver edit input has no job type field (no admin path to bypass the rule)', async () => {
    const admin = await h.seedAdmin();
    const body = await h.gql(
      admin.token,
      `query { __type(name: "AdminUpdateCaregiverInfoInput") { inputFields { name } } }`,
    );
    const fields = (
      body.data as { __type: { inputFields: { name: string }[] } | null }
    ).__type?.inputFields.map((f) => f.name);
    expect(fields?.length).toBeGreaterThan(0);
    expect(fields).not.toEqual(expect.arrayContaining(['jobTypes']));
  });
});
