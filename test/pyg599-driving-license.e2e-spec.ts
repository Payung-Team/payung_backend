/**
 * PYG-599 · QA ของ S06 (PYG-561) — อัปโหลด ตรวจ และบังคับใช้ใบขับขี่
 *
 * ยิง GraphQL / REST เข้าแอปจริง (harness: test/support/qa-e2e.ts) ต่อ Postgres ทิ้งได้ใน Docker
 * TC_NO = PYG-561_NN · รายงานผล: docs/qa/pyg-599-driving-license-report.md
 *
 * ต้นทางของ expected: story PYG-561 + contract PYG-596 + มติ 19 ต.ค. 2026 (คอมเมนต์ 10693 ใน PYG-561):
 *   - transport_mode 3 ค่า (SELF_DRIVE / HIRED_RIDE / NONE) · NULL = ยังไม่ตอบ
 *   - ผ่านการตรวจ (R5) = อนุมัติ และวันนี้ยังไม่เลยวันหมดอายุ (วันหมดอายุเองยังใช้ได้) · คำนวณตอนเรียก (R9)
 *   - ป้ายฝั่ง Elder (E2) = R5 และ (self_drive หรือ NULL)
 *   - AC5 (กันรับงานที่ต้องขับ) ย้ายไป S22 — ยังไม่ผูกกับ operation ใด → Blocked
 * "วันนี้" = ปฏิทินไทย คุมด้วย ClockService ปลอม · ไม่มีไฟล์จริง ไม่มีใบขับขี่ของบุคคลจริง
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import {
  bootstrap,
  codeOf,
  describeDb,
  GqlBody,
  Harness,
  seedProductionMasterData,
} from './support/qa-e2e';

type Seeded = Awaited<ReturnType<Harness['seedUser']>>;
type Mode = 'SELF_DRIVE' | 'HIRED_RIDE' | 'NONE';

/** 10 พ.ย. 2026 10:00 เวลาไทย */
const NOW = new Date('2026-11-10T03:00:00Z');
const bkk = (day: string) => new Date(`${day}T00:00:00+07:00`);
const endOfBkk = (day: string) => new Date(`${day}T23:59:59.999+07:00`);

const DL = `documentId status verified isExpired expiresAt rejectionReason fileName signedUrl`;
const UPLOAD = `mutation($i: UploadDocumentInput!) { uploadKycDocument(input: $i) { id docType expiresAt reviewStatus caregiverId } }`;
const SUBMIT = `mutation($i: KycInput!) { submitKyc(input: $i) { id kycStatus } }`;
const MINE = `query { kycStatus { transportMode drivingLicense { ${DL} } } }`;
const APPROVE = `mutation($id: ID!) { approveDrivingLicense(documentId: $id) { documentId status } }`;
const REJECT = `mutation($i: RejectLicenseInput!) { rejectDrivingLicense(input: $i) { documentId status } }`;
const DETAIL = `query($id: ID!) { adminKycDetail(caregiverId: $id) { drivingLicense { ${DL} } drivingLicenseReviews { action reason documentId } } }`;
const SET_MODE = `mutation($m: TransportMode!) { updateTransportMode(mode: $m) }`;

type DrivingLicense = {
  documentId: string | null;
  status: string;
  verified: boolean;
  isExpired: boolean;
  expiresAt: string | null;
  rejectionReason: string | null;
  fileName: string | null;
  signedUrl: string | null;
};

const dataOf = <T>(body: GqlBody, field: string): T =>
  (body.data as Record<string, unknown> | null)?.[field] as T;

function thaiId(): string {
  const d = Array.from({ length: 12 }, (_, i) =>
    i === 0
      ? 1 + Math.floor(Math.random() * 8)
      : Math.floor(Math.random() * 10),
  );
  const sum = d.reduce((acc, n, i) => acc + n * (13 - i), 0);
  return [...d, (11 - (sum % 11)) % 10].join('');
}

jest.setTimeout(30_000);

describeDb('PYG-599 · S06 driving license (PYG-561)', () => {
  let h: Harness;
  let admin: Seeded;

  beforeAll(async () => {
    h = await bootstrap();
    h.enableStorage();
    // ทักษะกลาง — KYC บังคับทักษะอย่างน้อย 1 รายการที่เป็นรหัสกลาง
    await seedProductionMasterData();
    admin = await h.seedAdmin();
  }, 60_000);
  beforeEach(() => h.clock.set(NOW));
  afterAll(async () => {
    h?.clock.reset();
    await h?.close();
  });

  const applicant = () => h.seedUser('applicant', 2);
  const uidOf = async (u: Seeded) =>
    (
      await h.prisma.user.findUniqueOrThrow({
        where: { id: u.id },
        select: { supabaseUid: true },
      })
    ).supabaseUid;

  async function upload(
    u: Seeded,
    expiry: Date | string | null = bkk('2027-11-10'),
    folderOf: Seeded = u,
  ) {
    const input: Record<string, unknown> = {
      docType: 'driving_license',
      fileUrl: `${await uidOf(folderOf)}/dl-${randomUUID().slice(0, 8)}.jpg`,
      fileName: 'driving-qa.jpg',
      fileSize: 1024,
      mimeType: 'image/jpeg',
    };
    if (expiry !== null)
      input.expiresAt = expiry instanceof Date ? expiry.toISOString() : expiry;
    return h.gql(u.token, UPLOAD, { i: input });
  }
  async function uploaded(u: Seeded, expiry?: Date | string) {
    const body = await upload(u, expiry);
    if (body.errors) throw new Error(JSON.stringify(body.errors));
    return dataOf<{ id: string }>(body, 'uploadKycDocument').id;
  }

  const kycInput = (
    transport: Record<string, unknown>,
    documentIds: string[] = [],
  ) => ({
    fullName: 'ผู้ดูแล ทดสอบ QA',
    idCardNumber: thaiId(),
    phone: `08${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
    experienceYears: 2,
    skills: ['bathing'],
    documentIds,
    profession: 'general_caregiver',
    ...transport,
  });
  const submit = (
    u: Seeded,
    transport: Record<string, unknown>,
    documentIds: string[] = [],
  ) => h.gql(u.token, SUBMIT, { i: kycInput(transport, documentIds) });

  const caregiverOf = (u: Seeded) =>
    h.prisma.caregiver.findUnique({
      where: { userId: u.id },
      select: { id: true, kycStatus: true, transportMode: true },
    });
  const mine = async (u: Seeded) => {
    const body = await h.gql(u.token, MINE);
    if (body.errors) throw new Error(JSON.stringify(body.errors));
    return dataOf<{
      transportMode: Mode | null;
      drivingLicense: DrivingLicense;
    }>(body, 'kycStatus');
  };
  const detail = async (caregiverId: string) => {
    const body = await h.gql(admin.token, DETAIL, { id: caregiverId });
    if (body.errors) throw new Error(JSON.stringify(body.errors));
    return dataOf<{
      drivingLicense: DrivingLicense;
      drivingLicenseReviews: {
        action: string;
        reason: string | null;
        documentId: string;
      }[];
    }>(body, 'adminKycDetail');
  };
  /** โปรไฟล์ฝั่ง Elder — endpoint public ไม่ต้องล็อกอิน */
  const publicProfile = async (caregiverId: string) => {
    const res = await request(h.app.getHttpServer()).get(
      `/api/v1/caregivers/${caregiverId}/public`,
    );
    return {
      status: res.status,
      body: res.body as { driving_license_verified: boolean } & Record<
        string,
        unknown
      >,
    };
  };

  /** ผู้ดูแลที่อนุมัติ KYC แล้ว (ค้นหาได้) + ใบขับขี่ตามสถานะ · transport ตามที่ระบุ */
  async function driver(
    licence: 'none' | 'pending' | 'approved' | 'rejected',
    opts: {
      mode?: 'self_drive' | 'hired_ride' | 'none' | null;
      expiresAt?: Date;
    } = {},
  ) {
    const cg = await h.seedCaregiver();
    await h.prisma.caregiver.update({
      where: { id: cg.caregiverId },
      data: {
        transportMode: opts.mode === undefined ? 'self_drive' : opts.mode,
      },
    });
    let docId: string | null = null;
    if (licence !== 'none') {
      const doc = await h.prisma.kycDocument.create({
        data: {
          caregiverId: cg.caregiverId,
          userId: cg.id,
          documentType: 'driving_license',
          fileUrl: `${await uidOf(cg)}/dl.jpg`,
          fileName: 'dl.jpg',
          fileSize: 1,
          mimeType: 'image/jpeg',
          reviewStatus: licence,
          expiresAt: opts.expiresAt ?? endOfBkk('2027-11-10'),
        },
      });
      docId = doc.id;
    }
    return { ...cg, docId };
  }

  // ─── AC1 · ขับเองต้องมีใบขับขี่ ─────────────────────────────────────────

  it('PYG-561_01 (AC1) Verify that submitting KYC as SELF_DRIVE without a driving license gets DRIVING_LICENSE_REQUIRED and writes nothing', async () => {
    const u = await applicant();
    const body = await submit(u, { transportMode: 'SELF_DRIVE' });
    expect(codeOf(body)).toBe('DRIVING_LICENSE_REQUIRED');
    expect(body.errors?.[0]?.extensions).toMatchObject({ statusCode: 422 });
    expect(await caregiverOf(u)).toBeNull();
  });

  it('PYG-561_02 (AC1) Verify that the legacy selfDriveTransport=true without a license is rejected the same way', async () => {
    const u = await applicant();
    expect(codeOf(await submit(u, { selfDriveTransport: true }))).toBe(
      'DRIVING_LICENSE_REQUIRED',
    );
    expect(await caregiverOf(u)).toBeNull();
  });

  it('PYG-561_03 Verify that contradicting transportMode and selfDriveTransport gets TRANSPORT_MODE_CONFLICT', async () => {
    const u = await applicant();
    const docId = await uploaded(u);
    const body = await submit(
      u,
      { transportMode: 'NONE', selfDriveTransport: true },
      [docId],
    );
    expect(codeOf(body)).toBe('TRANSPORT_MODE_CONFLICT');
    expect(await caregiverOf(u)).toBeNull();
  });

  it('PYG-561_04 (AC1) Verify that SELF_DRIVE with an uploaded license submits, stores self_drive and queues the license for review', async () => {
    const u = await applicant();
    const docId = await uploaded(u);
    const body = await submit(u, { transportMode: 'SELF_DRIVE' }, [docId]);
    expect(body.errors).toBeUndefined();
    const cg = (await caregiverOf(u))!;
    expect(cg).toMatchObject({
      kycStatus: 'pending',
      transportMode: 'self_drive',
    });
    const me = await mine(u);
    expect(me.transportMode).toBe('SELF_DRIVE');
    expect(me.drivingLicense).toMatchObject({
      documentId: docId,
      status: 'pending',
      verified: false,
      isExpired: false,
    });
    expect((await detail(cg.id)).drivingLicense).toMatchObject({
      documentId: docId,
      status: 'pending',
    });
  });

  // ─── AC2 · ไม่ขับไม่ถูกบังคับ ───────────────────────────────────────────

  it.each<Mode>(['NONE', 'HIRED_RIDE'])(
    'PYG-561_05 (AC2) Verify that %s submits KYC without a driving license',
    async (mode) => {
      const u = await applicant();
      const body = await submit(u, { transportMode: mode });
      expect(body.errors).toBeUndefined();
      expect((await caregiverOf(u))?.transportMode).toBe(mode.toLowerCase());
      const me = await mine(u);
      expect(me.transportMode).toBe(mode);
      expect(me.drivingLicense).toMatchObject({
        status: 'none',
        verified: false,
      });
    },
  );

  // บั๊ก PYG-671 (Low): getState หาใบด้วย caregiver_id OR user_id → ใบที่อัปโหลดทิ้งไว้ยังนับเป็นใบล่าสุด
  // — แก้แล้วเปลี่ยน it.failing → it
  it.failing(
    'PYG-561_06 (AC2) Verify that a caregiver who uploaded a license then switched to NONE before submitting has no driving license on record',
    async () => {
      const u = await applicant();
      // FE ตัดเอกสารใบขับขี่ออกจาก documentIds เมื่อไม่ได้เลือกขับเอง (KycStep4) — ส่งแบบเดียวกัน
      await uploaded(u);
      const body = await submit(u, { transportMode: 'NONE' });
      expect(body.errors).toBeUndefined();
      const cg = (await caregiverOf(u))!;
      expect((await mine(u)).drivingLicense.status).toBe('none');
      expect((await detail(cg.id)).drivingLicense.status).toBe('none');
    },
  );

  // ─── AC3 · วันหมดอายุ ──────────────────────────────────────────────────

  it('PYG-561_07 (AC3) Verify that uploading a driving license without expiry gets DRIVING_LICENSE_EXPIRY_REQUIRED', async () => {
    const u = await applicant();
    expect(codeOf(await upload(u, null))).toBe(
      'DRIVING_LICENSE_EXPIRY_REQUIRED',
    );
    expect(await h.prisma.kycDocument.count({ where: { userId: u.id } })).toBe(
      0,
    );
  });

  it.each([
    ['yesterday', bkk('2026-11-09')],
    ['today', bkk('2026-11-10')],
  ])(
    'PYG-561_08 (AC3) Verify that an expiry of %s at upload gets DRIVING_LICENSE_EXPIRED',
    async (_l, expiry) => {
      const u = await applicant();
      expect(codeOf(await upload(u, expiry))).toBe('DRIVING_LICENSE_EXPIRED');
      expect(
        await h.prisma.kycDocument.count({ where: { userId: u.id } }),
      ).toBe(0);
    },
  );

  it('PYG-561_09 (AC3) Verify that tomorrow is accepted and the stored expiry matches the date entered (end of that Thai day)', async () => {
    const u = await applicant();
    const id = await uploaded(u, '2026-11-11');
    expect(
      (await h.prisma.kycDocument.findUniqueOrThrow({ where: { id } }))
        .expiresAt,
    ).toEqual(endOfBkk('2026-11-11'));
  });

  // ─── AC4 · แอดมินตรวจ ──────────────────────────────────────────────────

  it('PYG-561_10 (AC4) Verify that approving sets approved, records the review and the caregiver sees it as verified', async () => {
    const c = await driver('pending');
    const body = await h.gql(admin.token, APPROVE, { id: c.docId });
    expect(body.errors).toBeUndefined();
    expect(dataOf(body, 'approveDrivingLicense')).toMatchObject({
      status: 'approved',
    });
    expect((await mine(c)).drivingLicense).toMatchObject({
      documentId: c.docId,
      status: 'approved',
      verified: true,
    });
    expect((await detail(c.caregiverId)).drivingLicenseReviews).toEqual([
      { action: 'driving_license_approved', reason: null, documentId: c.docId },
    ]);
  });

  it('PYG-561_11 (AC4) Verify that rejecting with a reason stores it and the caregiver sees the reason', async () => {
    const c = await driver('pending');
    const body = await h.gql(admin.token, REJECT, {
      i: { documentId: c.docId, reason: '  รูปไม่ชัด  ' },
    });
    expect(body.errors).toBeUndefined();
    expect((await mine(c)).drivingLicense).toMatchObject({
      status: 'rejected',
      verified: false,
      rejectionReason: 'รูปไม่ชัด',
    });
    expect((await detail(c.caregiverId)).drivingLicenseReviews).toEqual([
      {
        action: 'driving_license_rejected',
        reason: 'รูปไม่ชัด',
        documentId: c.docId,
      },
    ]);
  });

  it.each([null, '', '   '])(
    'PYG-561_12 (AC4) Verify that rejecting with reason %p gets REJECT_REASON_REQUIRED and the status stays pending',
    async (reason) => {
      const c = await driver('pending');
      const body = await h.gql(admin.token, REJECT, {
        i: { documentId: c.docId, reason },
      });
      expect(codeOf(body)).toBe('REJECT_REASON_REQUIRED');
      expect(
        (
          await h.prisma.kycDocument.findUniqueOrThrow({
            where: { id: c.docId! },
          })
        ).reviewStatus,
      ).toBe('pending');
      expect(
        await h.prisma.kycReview.count({ where: { documentId: c.docId } }),
      ).toBe(0);
    },
  );

  it('PYG-561_13 Verify that a license that passed its expiry day while pending cannot be approved (DRIVING_LICENSE_EXPIRED)', async () => {
    const c = await driver('pending', { expiresAt: endOfBkk('2026-11-12') });
    // วันหมดอายุเองยังอนุมัติได้
    h.clock.set(new Date('2026-11-12T20:00:00+07:00'));
    const sameDay = await driver('pending', {
      expiresAt: endOfBkk('2026-11-12'),
    });
    expect(
      (await h.gql(admin.token, APPROVE, { id: sameDay.docId })).errors,
    ).toBeUndefined();
    // วันถัดไปอนุมัติไม่ได้
    h.clock.set(new Date('2026-11-13T08:00:00+07:00'));
    expect(codeOf(await h.gql(admin.token, APPROVE, { id: c.docId }))).toBe(
      'DRIVING_LICENSE_EXPIRED',
    );
    expect(
      (
        await h.prisma.kycDocument.findUniqueOrThrow({
          where: { id: c.docId! },
        })
      ).reviewStatus,
    ).toBe('pending');
  });

  // ─── AC6 · ป้ายฝั่ง Elder ───────────────────────────────────────────────

  it('PYG-561_14 (AC6) Verify that the Elder-facing profile shows the badge for an approved, unexpired self-driver and leaks no license details', async () => {
    const c = await driver('approved');
    const res = await publicProfile(c.caregiverId);
    expect(res.status).toBe(200);
    expect(res.body.driving_license_verified).toBe(true);
    // response ดิบ: ไม่มีรูป วันหมดอายุ เหตุผล หรือ id เอกสารใบขับขี่
    const raw = JSON.stringify(res.body);
    for (const leak of [
      'expires',
      'signedUrl',
      'rejection',
      'driving-qa',
      'dl.jpg',
      c.docId!,
      'documentId',
    ])
      expect(raw).not.toContain(leak);
  });

  it.each<[string, Parameters<typeof driver>[0], Parameters<typeof driver>[1]]>(
    [
      ['pending', 'pending', {}],
      ['rejected', 'rejected', {}],
      ['never uploaded', 'none', {}],
      [
        'approved but expired yesterday',
        'approved',
        { expiresAt: endOfBkk('2026-11-09') },
      ],
      ['approved but now HIRED_RIDE (E2)', 'approved', { mode: 'hired_ride' }],
      ['approved but now NONE (E2)', 'approved', { mode: 'none' }],
    ],
  )(
    'PYG-561_15 (AC6) Verify that there is no badge when the license is %s',
    async (_l, licence, opts) => {
      const c = await driver(licence, opts);
      const res = await publicProfile(c.caregiverId);
      expect(res.status).toBe(200);
      expect(res.body.driving_license_verified).toBe(false);
    },
  );

  it('PYG-561_16 (AC6 · E2) Verify that a caregiver who never answered the transport question (NULL) keeps the badge from an approved license', async () => {
    const c = await driver('approved', { mode: null });
    expect(
      (await publicProfile(c.caregiverId)).body.driving_license_verified,
    ).toBe(true);
  });

  // ─── Edge cases ─────────────────────────────────────────────────────────

  it('PYG-561_17 (E1) Verify that a verified caregiver switching to SELF_DRIVE stays verified, gets no badge until a new license is approved', async () => {
    const c = await driver('none', { mode: 'none' });
    const set = await h.gql(c.token, SET_MODE, { m: 'SELF_DRIVE' });
    expect(set.errors).toBeUndefined();
    expect(await caregiverOf(c)).toMatchObject({
      kycStatus: 'verified',
      transportMode: 'self_drive',
    });
    expect(
      (await publicProfile(c.caregiverId)).body.driving_license_verified,
    ).toBe(false);
    // อัปโหลดใบ → ผูกกับผู้ดูแลทันที (ผู้ดูแล verified ส่ง KYC ซ้ำไม่ได้) → แอดมินเห็นและอนุมัติได้
    const docId = await uploaded(c);
    expect(
      (await h.prisma.kycDocument.findUniqueOrThrow({ where: { id: docId } }))
        .caregiverId,
    ).toBe(c.caregiverId);
    expect((await detail(c.caregiverId)).drivingLicense).toMatchObject({
      documentId: docId,
      status: 'pending',
    });
    expect(
      (await h.gql(admin.token, APPROVE, { id: docId })).errors,
    ).toBeUndefined();
    expect(
      (await publicProfile(c.caregiverId)).body.driving_license_verified,
    ).toBe(true);
  });

  it('PYG-561_18 (E3/R9) Verify that an approved license stays valid through its expiry day and lapses the next day with no data change', async () => {
    const c = await driver('approved', { expiresAt: endOfBkk('2026-11-15') });
    h.clock.set(new Date('2026-11-15T23:30:00+07:00'));
    expect((await mine(c)).drivingLicense).toMatchObject({
      verified: true,
      isExpired: false,
    });
    expect(
      (await publicProfile(c.caregiverId)).body.driving_license_verified,
    ).toBe(true);
    h.clock.set(new Date('2026-11-16T00:10:00+07:00'));
    expect((await mine(c)).drivingLicense).toMatchObject({
      status: 'approved',
      verified: false,
      isExpired: true,
    });
    expect(
      (await publicProfile(c.caregiverId)).body.driving_license_verified,
    ).toBe(false);
    expect(
      (
        await h.prisma.kycDocument.findUniqueOrThrow({
          where: { id: c.docId! },
        })
      ).reviewStatus,
    ).toBe('approved');
  });

  it('PYG-561_19 (E7) Verify that after a rejection a new upload goes back to review and the earlier reason stays in history', async () => {
    const c = await driver('pending');
    await h.gql(admin.token, REJECT, {
      i: { documentId: c.docId, reason: 'ใบเป็นของคนอื่น' },
    });
    const fresh = await uploaded(c);
    const d = await detail(c.caregiverId);
    expect(d.drivingLicense).toMatchObject({
      documentId: fresh,
      status: 'pending',
    });
    expect(d.drivingLicenseReviews).toEqual([
      {
        action: 'driving_license_rejected',
        reason: 'ใบเป็นของคนอื่น',
        documentId: c.docId,
      },
    ]);
    expect((await mine(c)).drivingLicense).toMatchObject({
      documentId: fresh,
      status: 'pending',
    });
  });

  it('PYG-561_20 (E8 · มติ) Verify that the old approved license stays valid while a renewal is pending', async () => {
    const c = await driver('approved', { expiresAt: endOfBkk('2026-12-31') });
    const fresh = await uploaded(c, '2031-12-31');
    const me = await mine(c);
    expect(me.drivingLicense).toMatchObject({
      documentId: fresh,
      status: 'pending',
      verified: true,
    });
    expect(
      (await publicProfile(c.caregiverId)).body.driving_license_verified,
    ).toBe(true);
  });

  it('PYG-561_21 Verify that a caregiver whose KYC is not verified cannot change transport mode after the fact', async () => {
    const cg = await h.seedCaregiver({ kycStatus: 'pending', careLevel: null });
    expect(
      (await h.gql(cg.token, SET_MODE, { m: 'SELF_DRIVE' })).errors,
    ).toBeDefined();
  });

  // ─── สิทธิ์ ──────────────────────────────────────────────────────────────

  it("PYG-561_22 Verify that caregiver A cannot register a file in B's folder or read B's driving license", async () => {
    const a = await applicant();
    const b = await driver('pending');
    const body = await upload(a, bkk('2027-01-01'), b);
    expect(body.errors).toBeDefined();
    expect(await h.prisma.kycDocument.count({ where: { userId: a.id } })).toBe(
      0,
    );
    const peek = await h.gql(a.token, DETAIL, { id: b.caregiverId });
    expect(codeOf(peek)).toBe('FORBIDDEN');
    expect(peek.data).toBeNull();
  });

  it('PYG-561_23 Verify that a caregiver (even the owner) and an Elder cannot approve or reject a driving license', async () => {
    const c = await driver('pending');
    const elder = await h.seedUser('elder');
    for (const u of [c, elder]) {
      expect(codeOf(await h.gql(u.token, APPROVE, { id: c.docId }))).toBe(
        'FORBIDDEN',
      );
      expect(
        codeOf(
          await h.gql(u.token, REJECT, {
            i: { documentId: c.docId, reason: 'x' },
          }),
        ),
      ).toBe('FORBIDDEN');
    }
    expect(
      (
        await h.prisma.kycDocument.findUniqueOrThrow({
          where: { id: c.docId! },
        })
      ).reviewStatus,
    ).toBe('pending');
  });

  it('PYG-561_24 Verify that approving, uploading or changing transport mode without logging in is rejected', async () => {
    const c = await driver('pending');
    expect(codeOf(await h.gql(null, APPROVE, { id: c.docId }))).toBe(
      'UNAUTHENTICATED',
    );
    expect(codeOf(await h.gql(null, SET_MODE, { m: 'SELF_DRIVE' }))).toBe(
      'UNAUTHENTICATED',
    );
    expect(
      codeOf(
        await h.gql(null, UPLOAD, {
          i: {
            docType: 'driving_license',
            fileUrl: 'x/y.jpg',
            fileName: 'y.jpg',
            fileSize: 1,
            mimeType: 'image/jpeg',
            expiresAt: '2027-01-01',
          },
        }),
      ),
    ).toBe('UNAUTHENTICATED');
  });
});
