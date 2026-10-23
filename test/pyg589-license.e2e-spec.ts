/**
 * PYG-589 · QA ของ S03 (PYG-558) — ใบประกอบวิชาชีพใน KYC วันหมดอายุ และการหมดอายุ
 *
 * ยิง GraphQL เข้าแอปจริง (harness: test/support/qa-e2e.ts) ต่อ Postgres ทิ้งได้ใน Docker
 * TC_NO = PYG-558_NN · รายงานผล: docs/qa/pyg-589-license-report.md
 *
 * ต้นทางของ expected: story PYG-558 (R1–R7, E1–E11) + contract PYG-585 (error code 422)
 * "วันนี้" = ปฏิทินไทย (E4) — นาฬิกาเซิร์ฟเวอร์ตั้งด้วย h.clock (ไม่แก้นาฬิกาเครื่อง)
 * งานหมดอายุรายวันเรียก LicenseExpiryCron.run() ตรง ๆ หลังเลื่อนนาฬิกา (ไม่รอข้ามวันจริง)
 * ไฟล์: แค่ storage path ในโฟลเดอร์ของผู้ใช้ (ไม่มีไฟล์จริง · ไม่มีเอกสารของบุคคลจริง)
 */
import { randomUUID } from 'crypto';
import {
  bootstrap,
  codeOf,
  describeDb,
  GqlBody,
  Harness,
  seedProductionMasterData,
} from './support/qa-e2e';
import { LicenseExpiryCron } from '../src/identity/kyc/license/license-expiry.cron';

type Seeded = Awaited<ReturnType<Harness['seedUser']>>;
type Licensed = 'nurse' | 'physiotherapist';

/** 10 พ.ย. 2026 10:00 เวลาไทย */
const NOW = new Date('2026-11-10T03:00:00Z');
/** เที่ยงคืนเวลาไทยของวันที่ระบุ ('2026-11-11' → 2026-11-10T17:00Z) */
const bkk = (day: string) => new Date(`${day}T00:00:00+07:00`);
/** สิ้นวันเวลาไทย — ค่าที่ระบบเก็บใน expires_at */
const endOfBkk = (day: string) => new Date(`${day}T23:59:59.999+07:00`);

const UPLOAD = `mutation($i: UploadDocumentInput!) { uploadKycDocument(input: $i) { id docType licenseNumber expiresAt reviewStatus caregiverId } }`;
const SUBMIT = `mutation($i: KycInput!) { submitKyc(input: $i) { id kycStatus profession } }`;
const RESUBMIT = `mutation($i: KycInput!) { resubmitKyc(input: $i) { id kycStatus profession } }`;
const REJECT_KYC = `mutation($i: RejectKycInput!) { rejectKyc(input: $i) { id kycStatus } }`;
const APPROVE = `mutation($id: ID!) { approveLicense(documentId: $id) { documentId caregiverId status reviewedAt } }`;
const REJECT = `mutation($i: RejectLicenseInput!) { rejectLicense(input: $i) { documentId status } }`;
const LICENSE = `documentId licenseNumber fileName signedUrl expiresAt status rejectionReason isExpired`;
const DETAIL = `query($id: ID!) { adminKycDetail(caregiverId: $id) { profession license { ${LICENSE} } } }`;
const MINE = `query { kycStatus { profession license { ${LICENSE} } } }`;

type License = {
  documentId: string;
  licenseNumber: string | null;
  fileName: string;
  signedUrl: string | null;
  expiresAt: string | null;
  status: string;
  rejectionReason: string | null;
  isExpired: boolean;
};

const dataOf = <T>(body: GqlBody, field: string): T =>
  (body.data as Record<string, unknown> | null)?.[field] as T;
const extOf = (body: GqlBody) => body.errors?.[0]?.extensions ?? {};

/** เลขบัตรประชาชนไทยที่ check digit ถูก */
function thaiId(): string {
  const d = Array.from({ length: 12 }, (_, i) =>
    i === 0
      ? 1 + Math.floor(Math.random() * 8)
      : Math.floor(Math.random() * 10),
  );
  const sum = d.reduce((acc, n, i) => acc + n * (13 - i), 0);
  return [...d, (11 - (sum % 11)) % 10].join('');
}

// คำขอแรกของชุดช้า (แอปเพิ่งบูต) — 5 วินาทีของ jest ไม่พอ
jest.setTimeout(30_000);

describeDb('PYG-589 · S03 professional license in KYC (PYG-558)', () => {
  let h: Harness;
  let admin: Seeded;
  let cron: LicenseExpiryCron;

  beforeAll(async () => {
    h = await bootstrap();
    h.enableStorage();
    await seedProductionMasterData();
    admin = await h.seedAdmin();
    cron = h.app.get(LicenseExpiryCron);
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

  /** อัปโหลดเอกสาร (ไฟล์อยู่ใน storage ของผู้ใช้แล้ว) → ลงทะเบียนผ่าน API จริง */
  async function upload(
    u: Seeded,
    opts: {
      number?: string | null;
      expiry?: Date | string | null;
      docType?: string;
      folderOf?: Seeded;
    } = {},
  ) {
    const folder = await uidOf(opts.folderOf ?? u);
    const input: Record<string, unknown> = {
      docType: opts.docType ?? 'professional_license',
      fileUrl: `${folder}/license-${randomUUID().slice(0, 8)}.jpg`,
      fileName: 'license-qa.jpg',
      fileSize: 1024,
      mimeType: 'image/jpeg',
    };
    if (opts.number !== undefined && opts.number !== null)
      input.licenseNumber = opts.number;
    if (opts.expiry !== undefined && opts.expiry !== null)
      input.expiresAt =
        opts.expiry instanceof Date ? opts.expiry.toISOString() : opts.expiry;
    return h.gql(u.token, UPLOAD, { i: input });
  }

  /** ใบที่อัปโหลดสำเร็จ — เลข + วันหมดอายุพรุ่งนี้ปีหน้า */
  async function validLicense(u: Seeded, expiry = bkk('2027-11-10')) {
    const body = await upload(u, {
      number: `ว.${randomUUID().slice(0, 6)}`,
      expiry,
    });
    if (body.errors) throw new Error(JSON.stringify(body.errors));
    return dataOf<{ id: string }>(body, 'uploadKycDocument').id;
  }

  const kycInput = (profession: string, documentIds: string[] = []) => ({
    fullName: 'ผู้ดูแล ทดสอบ QA',
    idCardNumber: thaiId(),
    phone: `08${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
    experienceYears: 2,
    skills: ['bathing'],
    documentIds,
    profession,
  });
  const submit = (u: Seeded, profession: string, documentIds: string[] = []) =>
    h.gql(u.token, SUBMIT, { i: kycInput(profession, documentIds) });

  const caregiverOf = (u: Seeded) =>
    h.prisma.caregiver.findUnique({
      where: { userId: u.id },
      select: { id: true, kycStatus: true, profession: true },
    });
  const doc = (id: string) =>
    h.prisma.kycDocument.findUniqueOrThrow({ where: { id } });
  const notificationsOf = (userId: string, type?: string) =>
    h.prisma.notification.findMany({
      where: { userId, ...(type ? { type: type as never } : {}) },
      orderBy: { createdAt: 'asc' },
    });

  /** ผู้ดูแลที่ส่ง KYC พร้อมใบประกอบฯ แล้ว (รอตรวจ) */
  async function submitted(profession: Licensed, expiry?: Date) {
    const u = await applicant();
    const docId = await validLicense(u, expiry);
    const body = await submit(u, profession, [docId]);
    if (body.errors) throw new Error(JSON.stringify(body.errors));
    const cg = (await caregiverOf(u))!;
    return { u, docId, caregiverId: cg.id };
  }

  // ─── AC1 · ต้องมีเลขและไฟล์ ─────────────────────────────────────────────

  describe('AC1 · nurse / physiotherapist must have number and file', () => {
    it.each<Licensed>(['nurse', 'physiotherapist'])(
      'PYG-558_01 (AC1/E10) Verify that a %s submitting KYC with no license file gets LICENSE_FILE_REQUIRED and no caregiver row',
      async (profession) => {
        const u = await applicant();
        const body = await submit(u, profession);
        expect(codeOf(body)).toBe('LICENSE_FILE_REQUIRED');
        expect(extOf(body)).toMatchObject({ statusCode: 422 });
        expect(await caregiverOf(u)).toBeNull();
      },
    );

    it.each<[string, string | null]>([
      ['missing', null],
      ['empty', ''],
      ['spaces only (E5)', '    '],
    ])(
      'PYG-558_02 (AC1/E5) Verify that uploading a license with the number %s gets LICENSE_NUMBER_REQUIRED and stores nothing',
      async (_l, number) => {
        const u = await applicant();
        const body = await upload(u, { number, expiry: bkk('2027-01-01') });
        expect(codeOf(body)).toBe('LICENSE_NUMBER_REQUIRED');
        expect(extOf(body)).toMatchObject({ statusCode: 422 });
        expect(
          await h.prisma.kycDocument.count({ where: { userId: u.id } }),
        ).toBe(0);
      },
    );

    it.each<Licensed>(['nurse', 'physiotherapist'])(
      'PYG-558_03 (AC1) Verify that a %s with number, file and future expiry can submit KYC and the license is linked',
      async (profession) => {
        const { u, docId, caregiverId } = await submitted(profession);
        expect(await caregiverOf(u)).toMatchObject({
          kycStatus: 'pending',
          profession,
        });
        expect(await doc(docId)).toMatchObject({
          caregiverId,
          reviewStatus: 'pending',
        });
      },
    );

    it('PYG-558_04 (AC1/E10) Verify that a stored license row with no number or expiry (old client) cannot be used to submit KYC', async () => {
      const u = await applicant();
      const folder = await uidOf(u);
      const old = await h.prisma.kycDocument.create({
        data: {
          userId: u.id,
          documentType: 'professional_license',
          fileUrl: `${folder}/old-client.jpg`,
          fileName: 'old.jpg',
          fileSize: 1,
          mimeType: 'image/jpeg',
          reviewStatus: 'pending',
        },
      });
      const body = await submit(u, 'nurse', [old.id]);
      expect(codeOf(body)).toBe('LICENSE_NUMBER_REQUIRED');
      expect(extOf(body).codes).toEqual([
        'LICENSE_NUMBER_REQUIRED',
        'LICENSE_EXPIRY_REQUIRED',
      ]);
      expect(await caregiverOf(u)).toBeNull();
    });
  });

  // ─── AC2 · ผู้ดูแลทั่วไปไม่ถูกบังคับ ──────────────────────────────────────

  it('PYG-558_05 (AC2/E11) Verify that a general caregiver submits KYC without any license and has no license section', async () => {
    const u = await applicant();
    const body = await submit(u, 'general_caregiver');
    expect(body.errors).toBeUndefined();
    expect(await caregiverOf(u)).toMatchObject({
      kycStatus: 'pending',
      profession: 'general_caregiver',
    });
    const mine = dataOf<{ license: License | null }>(
      await h.gql(u.token, MINE),
      'kycStatus',
    );
    expect(mine.license).toBeNull();
  });

  // ─── AC3 · วันหมดอายุ ──────────────────────────────────────────────────

  describe('AC3 · expiry date', () => {
    it('PYG-558_06 (AC3) Verify that uploading a license with no expiry gets LICENSE_EXPIRY_REQUIRED', async () => {
      const u = await applicant();
      const body = await upload(u, { number: 'ว.12345' });
      expect(codeOf(body)).toBe('LICENSE_EXPIRY_REQUIRED');
      expect(
        await h.prisma.kycDocument.count({ where: { userId: u.id } }),
      ).toBe(0);
    });

    it.each([
      ['yesterday', bkk('2026-11-09')],
      ['today', bkk('2026-11-10')],
      ['today, late evening', new Date('2026-11-10T23:30:00+07:00')],
    ])(
      'PYG-558_07 (AC3/E3) Verify that an expiry of %s is rejected with LICENSE_EXPIRY_NOT_FUTURE',
      async (_l, expiry) => {
        const u = await applicant();
        const body = await upload(u, { number: 'ว.12345', expiry });
        expect(codeOf(body)).toBe('LICENSE_EXPIRY_NOT_FUTURE');
        expect(
          await h.prisma.kycDocument.count({ where: { userId: u.id } }),
        ).toBe(0);
      },
    );

    it.each([
      ['an ISO timestamp', bkk('2026-11-11')],
      ['a date-only string', '2026-11-11'],
    ])(
      'PYG-558_08 (AC3) Verify that tomorrow sent as %s is accepted and stored as the end of that Thai day',
      async (_l, expiry) => {
        const u = await applicant();
        const body = await upload(u, { number: 'ว.12345', expiry });
        expect(body.errors).toBeUndefined();
        const id = dataOf<{ id: string }>(body, 'uploadKycDocument').id;
        expect((await doc(id)).expiresAt).toEqual(endOfBkk('2026-11-11'));
      },
    );

    it('PYG-558_09 (AC3) Verify that missing number and past expiry are reported together', async () => {
      const u = await applicant();
      const body = await upload(u, { number: ' ', expiry: bkk('2026-01-01') });
      expect(codeOf(body)).toBe('LICENSE_NUMBER_REQUIRED');
      expect(extOf(body).codes).toEqual([
        'LICENSE_NUMBER_REQUIRED',
        'LICENSE_EXPIRY_NOT_FUTURE',
      ]);
    });

    it('PYG-558_10 (E4) Verify that "today" follows Thai time just after midnight Bangkok (still the previous day in UTC)', async () => {
      // 11 พ.ย. 00:30 เวลาไทย = 10 พ.ย. 17:30 UTC
      h.clock.set(new Date('2026-11-11T00:30:00+07:00'));
      const u = await applicant();
      const today = await upload(u, { number: 'ว.1', expiry: '2026-11-11' });
      expect(codeOf(today)).toBe('LICENSE_EXPIRY_NOT_FUTURE');
      const tomorrow = await upload(u, { number: 'ว.1', expiry: '2026-11-12' });
      expect(tomorrow.errors).toBeUndefined();
    });

    it('PYG-558_11 (E4) Verify that "today" follows Thai time just before midnight Bangkok', async () => {
      // 10 พ.ย. 23:50 เวลาไทย — พรุ่งนี้ = 11 พ.ย.
      h.clock.set(new Date('2026-11-10T23:50:00+07:00'));
      const u = await applicant();
      expect(
        (await upload(u, { number: 'ว.1', expiry: '2026-11-11' })).errors,
      ).toBeUndefined();
    });

    it('PYG-558_12 (E5) Verify that leading and trailing spaces are trimmed before saving', async () => {
      const u = await applicant();
      const body = await upload(u, {
        number: '  ว.98765  ',
        expiry: bkk('2027-01-01'),
      });
      expect(dataOf(body, 'uploadKycDocument')).toMatchObject({
        licenseNumber: 'ว.98765',
      });
    });
  });

  // ─── AC4 · หน้า KYC review ─────────────────────────────────────────────

  it.each<Licensed>(['nurse', 'physiotherapist'])(
    'PYG-558_13 (AC4) Verify that the admin KYC review shows profession, number, a signed file link and expiry for a %s',
    async (profession) => {
      const u = await applicant();
      const body = await upload(u, {
        number: '  ว.55555 ',
        expiry: '2027-06-30',
      });
      const docId = dataOf<{ id: string }>(body, 'uploadKycDocument').id;
      expect((await submit(u, profession, [docId])).errors).toBeUndefined();
      const cg = (await caregiverOf(u))!;
      const before = h.signedUrlCalls.length;

      const detail = dataOf<{ profession: string; license: License }>(
        await h.gql(admin.token, DETAIL, { id: cg.id }),
        'adminKycDetail',
      );
      expect(detail.profession).toBe(profession);
      expect(detail.license).toMatchObject({
        documentId: docId,
        licenseNumber: 'ว.55555',
        fileName: 'license-qa.jpg',
        expiresAt: endOfBkk('2027-06-30').toISOString(),
        status: 'pending',
        isExpired: false,
      });
      // ลิงก์เซ็นจาก bucket KYC ตาม path ของเจ้าของเท่านั้น
      const stored = (await doc(docId)).fileUrl;
      expect(detail.license.signedUrl).toContain(`/kyc-documents/${stored}`);
      expect(
        h.signedUrlCalls.slice(before).some((c) => c.path === stored),
      ).toBe(true);
    },
  );

  // ─── AC5 + AC6 · อนุมัติ / ปฏิเสธ และแจ้งเตือน ───────────────────────────

  describe('AC5 + AC6 · review and notifications', () => {
    it('PYG-558_14 (AC5/AC6) Verify that approving sets the license to approved, records the review and notifies only that caregiver', async () => {
      const other = await submitted('nurse');
      const { u, docId, caregiverId } = await submitted('nurse');
      const body = await h.gql(admin.token, APPROVE, { id: docId });
      expect(body.errors).toBeUndefined();
      expect(dataOf(body, 'approveLicense')).toMatchObject({
        documentId: docId,
        caregiverId,
        status: 'approved',
      });
      expect(await doc(docId)).toMatchObject({ reviewStatus: 'approved' });
      expect(
        await h.prisma.kycReview.findMany({
          where: { documentId: docId },
          select: { action: true, reviewerId: true },
        }),
      ).toEqual([{ action: 'license_approved', reviewerId: admin.id }]);

      const notes = await notificationsOf(u.id, 'license_approved');
      expect(notes).toHaveLength(1);
      expect(notes[0].data).toMatchObject({ documentId: docId, caregiverId });
      expect(await notificationsOf(other.u.id)).toEqual(
        expect.not.arrayContaining([
          expect.objectContaining({ type: 'license_approved' }),
        ]),
      );
    });

    it('PYG-558_15 (AC5/AC6) Verify that rejecting with a reason stores the reason and notifies the caregiver with it', async () => {
      const other = await submitted('physiotherapist');
      const { u, docId } = await submitted('physiotherapist');
      const body = await h.gql(admin.token, REJECT, {
        i: { documentId: docId, reason: '  ภาพไม่ชัด  ' },
      });
      expect(body.errors).toBeUndefined();
      expect(await doc(docId)).toMatchObject({ reviewStatus: 'rejected' });
      expect(
        await h.prisma.kycReview.findMany({
          where: { documentId: docId },
          select: { action: true, reason: true },
        }),
      ).toEqual([{ action: 'license_rejected', reason: 'ภาพไม่ชัด' }]);

      const notes = await notificationsOf(u.id, 'license_rejected');
      expect(notes).toHaveLength(1);
      expect(notes[0].body).toContain('ภาพไม่ชัด');
      expect(notes[0].data).toMatchObject({ reason: 'ภาพไม่ชัด' });
      expect(
        await notificationsOf(other.u.id, 'license_rejected'),
      ).toHaveLength(0);

      const mine = dataOf<{ license: License }>(
        await h.gql(u.token, MINE),
        'kycStatus',
      );
      expect(mine.license).toMatchObject({
        status: 'rejected',
        rejectionReason: 'ภาพไม่ชัด',
      });
    });

    it.each([null, '', '   '])(
      'PYG-558_16 (AC5) Verify that rejecting with reason %p gets LICENSE_REJECT_REASON_REQUIRED and changes nothing',
      async (reason) => {
        const { u, docId } = await submitted('nurse');
        const body = await h.gql(admin.token, REJECT, {
          i: { documentId: docId, reason },
        });
        expect(codeOf(body)).toBe('LICENSE_REJECT_REASON_REQUIRED');
        expect(await doc(docId)).toMatchObject({ reviewStatus: 'pending' });
        expect(
          await h.prisma.kycReview.count({ where: { documentId: docId } }),
        ).toBe(0);
        expect(await notificationsOf(u.id, 'license_rejected')).toHaveLength(0);
      },
    );

    it('PYG-558_17 Verify that a license already decided cannot be decided again', async () => {
      const { docId } = await submitted('nurse');
      expect(
        (await h.gql(admin.token, APPROVE, { id: docId })).errors,
      ).toBeUndefined();
      const again = await h.gql(admin.token, REJECT, {
        i: { documentId: docId, reason: 'เปลี่ยนใจ' },
      });
      expect(again.errors).toBeDefined();
      expect(await doc(docId)).toMatchObject({ reviewStatus: 'approved' });
    });
  });

  // ─── AC7 · หมดอายุ ─────────────────────────────────────────────────────

  describe('AC7 · daily expiry job', () => {
    it('PYG-558_18 (AC7/E8) Verify that the job expires due licenses once, notifies once, and leaves others alone', async () => {
      const due = await submitted('nurse', bkk('2026-11-20'));
      const approved = await submitted('physiotherapist', bkk('2026-11-20'));
      await h.gql(admin.token, APPROVE, { id: approved.docId });
      const later = await submitted('nurse', bkk('2026-11-21'));
      const rejected = await submitted('nurse', bkk('2026-11-20'));
      await h.gql(admin.token, REJECT, {
        i: { documentId: rejected.docId, reason: 'ไม่ชัด' },
      });

      // 21 พ.ย. 00:05 เวลาไทย — ใบที่หมด 20 พ.ย. ถึงกำหนด ใบที่หมด 21 พ.ย. ยังไม่ถึง
      h.clock.set(new Date('2026-11-21T00:05:00+07:00'));
      await cron.run();
      await cron.run(); // E8: รันซ้ำวันเดียวกัน

      expect((await doc(due.docId)).reviewStatus).toBe('expired');
      expect((await doc(approved.docId)).reviewStatus).toBe('expired');
      expect((await doc(later.docId)).reviewStatus).toBe('pending');
      expect((await doc(rejected.docId)).reviewStatus).toBe('rejected');

      for (const c of [due, approved]) {
        const notes = await notificationsOf(c.u.id, 'license_expired');
        expect(notes).toHaveLength(1);
        expect(notes[0].data).toMatchObject({ documentId: c.docId });
      }
      expect(await notificationsOf(later.u.id, 'license_expired')).toHaveLength(
        0,
      );
      expect(
        await notificationsOf(rejected.u.id, 'license_expired'),
      ).toHaveLength(0);

      const mine = dataOf<{ license: License }>(
        await h.gql(due.u.token, MINE),
        'kycStatus',
      );
      expect(mine.license).toMatchObject({
        status: 'expired',
        isExpired: true,
      });
    });

    it('PYG-558_19 (E8) Verify that a run missed for several days still expires the licenses from the skipped days', async () => {
      const a = await submitted('nurse', bkk('2026-11-22'));
      const b = await submitted('nurse', bkk('2026-11-24'));
      h.clock.set(new Date('2026-11-26T09:00:00+07:00'));
      await cron.run();
      expect((await doc(a.docId)).reviewStatus).toBe('expired');
      expect((await doc(b.docId)).reviewStatus).toBe('expired');
    });

    it('PYG-558_20 Verify that the job does not touch a license of a caregiver whose profession no longer requires one', async () => {
      const c = await submitted('nurse', bkk('2026-11-23'));
      await h.prisma.caregiver.update({
        where: { id: c.caregiverId },
        data: { profession: 'general_caregiver' },
      });
      h.clock.set(new Date('2026-11-24T09:00:00+07:00'));
      await cron.run();
      expect((await doc(c.docId)).reviewStatus).toBe('pending');
      expect(await notificationsOf(c.u.id, 'license_expired')).toHaveLength(0);
    });

    // เคยเป็นบั๊ก PYG-669 (High · แก้แล้ว): ใบที่ผู้ดูแล verified อัปโหลดใหม่ไม่ถูกผูก caregiver_id
    // → ไม่โผล่ทั้ง kycStatus และหน้า review · ตอนนี้ผูกตอนอัปโหลด
    it('PYG-558_21 (AC7/R7) Verify that a verified caregiver whose license expired can upload a new one and it goes back to review', async () => {
      const c = await submitted('nurse', bkk('2026-11-25'));
      await h.gql(admin.token, APPROVE, { id: c.docId });
      await h.prisma.caregiver.update({
        where: { id: c.caregiverId },
        data: { kycStatus: 'verified', careLevel: 'basic' },
      });
      h.clock.set(new Date('2026-11-26T09:00:00+07:00'));
      await cron.run();
      expect((await doc(c.docId)).reviewStatus).toBe('expired');

      const fresh = await upload(c.u, {
        number: 'ว.ใหม่-1',
        expiry: '2028-11-25',
      });
      expect(fresh.errors).toBeUndefined();
      const freshId = dataOf<{ id: string }>(fresh, 'uploadKycDocument').id;

      // ผู้ดูแลเห็นใบใหม่รอตรวจ และแอดมินเห็นใบใหม่ในหน้า review เพื่ออนุมัติได้
      const mine = dataOf<{ license: License }>(
        await h.gql(c.u.token, MINE),
        'kycStatus',
      );
      expect(mine.license).toMatchObject({
        documentId: freshId,
        status: 'pending',
      });
      const detail = dataOf<{ license: License }>(
        await h.gql(admin.token, DETAIL, { id: c.caregiverId }),
        'adminKycDetail',
      );
      expect(detail.license).toMatchObject({
        documentId: freshId,
        status: 'pending',
      });

      // แอดมินอนุมัติใบใหม่ได้ → ผู้ดูแลกลับมามีใบที่ใช้ได้
      expect(
        (await h.gql(admin.token, APPROVE, { id: freshId })).errors,
      ).toBeUndefined();
      const after = dataOf<{ license: License }>(
        await h.gql(c.u.token, MINE),
        'kycStatus',
      );
      expect(after.license).toMatchObject({
        documentId: freshId,
        status: 'approved',
        isExpired: false,
      });
    });

    it('PYG-558_32 (AC7) Verify that the profession-change route rejects a same-profession request, so renewal goes through upload', async () => {
      // คำขอเปลี่ยนวิชาชีพเดิมถูกปฏิเสธ — การต่ออายุจึงเป็นทางอัปโหลด (PYG-669) ซึ่งผูกใบให้ผู้ดูแล verified แล้ว
      const c = await submitted('nurse');
      await h.prisma.caregiver.update({
        where: { id: c.caregiverId },
        data: { kycStatus: 'verified', careLevel: 'basic' },
      });
      const freshId = await validLicense(c.u);
      const body = await h.gql(
        c.u.token,
        `mutation($i: ProfessionChangeInput!) { requestProfessionChange(input: $i) { id } }`,
        { i: { profession: 'nurse', licenseDocumentId: freshId } },
      );
      expect(codeOf(body)).toBe('PROFESSION_UNCHANGED');
      expect((await doc(freshId)).caregiverId).toBe(c.caregiverId);
    });
  });

  // ─── Edge cases ─────────────────────────────────────────────────────────

  describe('Edge cases', () => {
    it('PYG-558_22 (E1) Verify that switching to general caregiver after filling in a license still submits', async () => {
      const u = await applicant();
      const docId = await validLicense(u);
      const body = await submit(u, 'general_caregiver', [docId]);
      expect(body.errors).toBeUndefined();
      expect(await caregiverOf(u)).toMatchObject({
        profession: 'general_caregiver',
      });
      // ผลต่อใบที่กรอกค้าง (ทิ้ง/เก็บ) ยังไม่เคาะ — บันทึกพฤติกรรมจริงไว้ในรายงาน
      // พฤติกรรมปัจจุบัน (ยังไม่เคาะว่าเก็บหรือทิ้ง): ใบถูกผูกกับผู้ดูแลและยังรอตรวจ — ผู้ดูแลทั่วไปเห็นใบนี้ใน kycStatus
      const cg = await caregiverOf(u);
      expect(await doc(docId)).toMatchObject({
        caregiverId: cg?.id,
        reviewStatus: 'pending',
      });
    });

    // เคยเป็นบั๊ก PYG-670 (Medium · แก้แล้ว): resubmit สลับพยาบาล ↔ นักกายภาพฯ ด้วยใบเดิมเคยผ่าน
    it('PYG-558_23 (E2) Verify that a nurse license cannot be reused when resubmitting as a physiotherapist, and a new one is accepted', async () => {
      const { u, docId, caregiverId } = await submitted('nurse');
      await h.gql(admin.token, REJECT_KYC, {
        i: { caregiverId, reasons: [{ title: 'ข้อมูลไม่ตรงกัน' }] },
      });
      const body = await h.gql(u.token, RESUBMIT, {
        i: kycInput('physiotherapist', [docId]),
      });
      expect(codeOf(body)).toBe('LICENSE_FILE_REQUIRED');
      expect((await caregiverOf(u))?.profession).toBe('nurse');

      // แนบใบใหม่แล้วส่งได้ · ใบเดิมถูกปลดจากรอบนี้
      const freshId = await validLicense(u);
      const ok = await h.gql(u.token, RESUBMIT, {
        i: kycInput('physiotherapist', [freshId]),
      });
      expect(ok.errors).toBeUndefined();
      expect(await caregiverOf(u)).toMatchObject({
        kycStatus: 'pending',
        profession: 'physiotherapist',
      });
      expect(await doc(freshId)).toMatchObject({ caregiverId });
      expect((await doc(docId)).caregiverId).toBeNull();
    });

    it('PYG-558_24 (E6) Verify that after a rejection the old license cannot be resubmitted, a new one queues for review, and the rejection history stays', async () => {
      const { u, docId, caregiverId } = await submitted('nurse');
      await h.gql(admin.token, REJECT, {
        i: { documentId: docId, reason: 'หมดอายุในเอกสาร' },
      });
      await h.gql(admin.token, REJECT_KYC, {
        i: { caregiverId, reasons: [{ title: 'ใบประกอบฯ ไม่ผ่าน' }] },
      });

      const reuse = await h.gql(u.token, RESUBMIT, {
        i: kycInput('nurse', [docId]),
      });
      expect(codeOf(reuse)).toBe('LICENSE_FILE_REQUIRED');

      const freshId = await validLicense(u);
      const ok = await h.gql(u.token, RESUBMIT, {
        i: kycInput('nurse', [freshId]),
      });
      expect(ok.errors).toBeUndefined();
      expect(await doc(freshId)).toMatchObject({
        reviewStatus: 'pending',
        caregiverId,
      });
      expect(await doc(docId)).toMatchObject({ reviewStatus: 'rejected' });
      expect(
        await h.prisma.kycReview.findMany({
          where: { documentId: docId },
          select: { action: true, reason: true },
        }),
      ).toEqual([{ action: 'license_rejected', reason: 'หมดอายุในเอกสาร' }]);
      const detail = dataOf<{ license: License }>(
        await h.gql(admin.token, DETAIL, { id: caregiverId }),
        'adminKycDetail',
      );
      expect(detail.license).toMatchObject({
        documentId: freshId,
        status: 'pending',
      });
    });

    it('PYG-558_25 (E7) Verify that a license that expires while waiting cannot be approved (LICENSE_EXPIRED)', async () => {
      const { u, docId } = await submitted('nurse', bkk('2026-11-12'));
      h.clock.set(new Date('2026-11-13T08:00:00+07:00'));
      const body = await h.gql(admin.token, APPROVE, { id: docId });
      expect(codeOf(body)).toBe('LICENSE_EXPIRED');
      expect(await doc(docId)).toMatchObject({ reviewStatus: 'pending' });
      expect(await notificationsOf(u.id, 'license_approved')).toHaveLength(0);
      const detail = dataOf<{ license: License }>(
        await h.gql(admin.token, DETAIL, { id: (await caregiverOf(u))!.id }),
        'adminKycDetail',
      );
      expect(detail.license.isExpired).toBe(true);
    });

    it('PYG-558_26 (E9) Verify what happens when a general caregiver sends license data through the API', async () => {
      const u = await applicant();
      const docId = await validLicense(u);
      const body = await submit(u, 'general_caregiver', [docId]);
      expect(body.errors).toBeUndefined();
      // story ยังไม่เคาะว่ารับเก็บหรือปฏิเสธ — บันทึกพฤติกรรมจริง
      const stored = await doc(docId);
      expect(stored.reviewStatus).toBe('pending');
    });
  });

  // ─── สิทธิ์ ──────────────────────────────────────────────────────────────

  describe('Permissions', () => {
    it("PYG-558_27 Verify that caregiver A cannot register a file in caregiver B's storage folder", async () => {
      const a = await applicant();
      const b = await applicant();
      const body = await upload(a, {
        number: 'ว.1',
        expiry: '2027-01-01',
        folderOf: b,
      });
      expect(body.errors).toBeDefined();
      expect(
        await h.prisma.kycDocument.count({ where: { userId: a.id } }),
      ).toBe(0);
    });

    it("PYG-558_28 Verify that caregiver A cannot submit KYC with caregiver B's license or read B's license", async () => {
      const b = await submitted('nurse');
      const a = await applicant();
      const body = await submit(a, 'nurse', [b.docId]);
      // ด่าน "เอกสารต้องเป็นของผู้ส่ง" ตอบ NotFound (404) ก่อนถึงการตรวจใบ — Nest NotFoundException
      // ใน GraphQL ของ repo นี้ออกเป็น code INTERNAL_SERVER_ERROR + extensions.status 404
      expect(extOf(body)).toMatchObject({ status: 404 });
      expect(body.errors?.[0]?.message).toContain('not owned by user');
      expect(await caregiverOf(a)).toBeNull();
      expect(await doc(b.docId)).toMatchObject({ caregiverId: b.caregiverId });
      const detail = await h.gql(a.token, DETAIL, { id: b.caregiverId });
      expect(codeOf(detail)).toBe('FORBIDDEN');
      expect(detail.data).toBeNull();
    });

    it('PYG-558_29 Verify that a caregiver cannot approve or reject their own license', async () => {
      const { u, docId } = await submitted('nurse');
      expect(codeOf(await h.gql(u.token, APPROVE, { id: docId }))).toBe(
        'FORBIDDEN',
      );
      expect(
        codeOf(
          await h.gql(u.token, REJECT, {
            i: { documentId: docId, reason: 'x' },
          }),
        ),
      ).toBe('FORBIDDEN');
      expect(await doc(docId)).toMatchObject({ reviewStatus: 'pending' });
    });

    it('PYG-558_30 Verify that an Elder user cannot review a license or open the KYC review', async () => {
      const { docId, caregiverId } = await submitted('nurse');
      const elder = await h.seedUser('elder');
      expect(codeOf(await h.gql(elder.token, APPROVE, { id: docId }))).toBe(
        'FORBIDDEN',
      );
      expect(
        codeOf(
          await h.gql(elder.token, REJECT, {
            i: { documentId: docId, reason: 'x' },
          }),
        ),
      ).toBe('FORBIDDEN');
      expect(
        codeOf(await h.gql(elder.token, DETAIL, { id: caregiverId })),
      ).toBe('FORBIDDEN');
      expect(await doc(docId)).toMatchObject({ reviewStatus: 'pending' });
    });

    it('PYG-558_31 Verify that reviewing, uploading or reading without logging in is rejected', async () => {
      const { docId, caregiverId } = await submitted('nurse');
      expect(codeOf(await h.gql(null, APPROVE, { id: docId }))).toBe(
        'UNAUTHENTICATED',
      );
      expect(codeOf(await h.gql(null, DETAIL, { id: caregiverId }))).toBe(
        'UNAUTHENTICATED',
      );
      expect(
        codeOf(
          await h.gql(null, UPLOAD, {
            i: {
              docType: 'professional_license',
              fileUrl: 'x/y.jpg',
              fileName: 'y.jpg',
              fileSize: 1,
              mimeType: 'image/jpeg',
              licenseNumber: 'ว.1',
              expiresAt: '2027-01-01',
            },
          }),
        ),
      ).toBe('UNAUTHENTICATED');
    });
  });
});
