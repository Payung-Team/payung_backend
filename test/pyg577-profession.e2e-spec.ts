/**
 * PYG-577 · QA ของ S01 (PYG-556) — ระบุและแสดงวิชาชีพของผู้ดูแล
 *
 * ยิง GraphQL / REST เข้าแอปจริง (harness: test/support/qa-e2e.ts) ต่อ Postgres ทิ้งได้ใน Docker
 * TC_NO = PYG-556_NN · รายงานผล: docs/qa/pyg-577-profession-report.md
 * ต่างจาก test/pyg575-profession-graphql.e2e-spec.ts (mock Prisma · ตรวจ contract ชั้น HTTP) — ไฟล์นี้ต่อ DB จริงทั้งเส้นทาง
 *
 * ใบประกอบฯ (S03) เป็นเงื่อนไขของการเป็นพยาบาล/นักกายภาพ → สร้างแถว kyc_documents เป็น precondition
 * (การอัปโหลดไฟล์ผ่าน Supabase storage เป็นของ S03 ไม่ใช่เป้าของการ์ดนี้)
 */
import { randomUUID } from 'crypto';
import {
  bootstrap,
  codeOf,
  describeDb,
  futureDate,
  GqlBody,
  Harness,
  seedProductionMasterData,
  UNLOCKED_SKILLS,
} from './support/qa-e2e';

type Res = { status: number; body: unknown };
type Profession = 'general_caregiver' | 'nurse' | 'physiotherapist';
const PROFESSIONS: Profession[] = [
  'general_caregiver',
  'nurse',
  'physiotherapist',
];

const SUBMIT_KYC = `mutation($i: KycInput!) { submitKyc(input: $i) { id kycStatus profession } }`;
const REQUEST_CHANGE = `mutation($i: ProfessionChangeInput!) { requestProfessionChange(input: $i) { id status fromProfession toProfession } }`;
const APPROVE_CHANGE = `mutation($id: ID!) { approveProfessionChangeRequest(id: $id) { id status } }`;
const REJECT_CHANGE = `mutation($i: RejectProfessionChangeInput!) { rejectProfessionChangeRequest(input: $i) { id status } }`;
const SEARCH = `query($p: String) { searchCaregivers(input: { province: $p, limit: 50 }) { data { id profession } } }`;

const dataOf = <T>(body: GqlBody, field: string): T =>
  (body.data as Record<string, unknown> | null)?.[field] as T;

/** เลขบัตรประชาชนไทยที่ check digit ถูก (สุ่ม 12 หลักแรก) */
function thaiId(): string {
  const d = Array.from({ length: 12 }, (_, i) =>
    i === 0
      ? 1 + Math.floor(Math.random() * 8)
      : Math.floor(Math.random() * 10),
  );
  const sum = d.reduce((acc, n, i) => acc + n * (13 - i), 0);
  return [...d, (11 - (sum % 11)) % 10].join('');
}

describeDb('PYG-577 · S01 caregiver profession (PYG-556)', () => {
  let h: Harness;
  let admin: Awaited<ReturnType<Harness['seedAdmin']>>;

  beforeAll(async () => {
    h = await bootstrap();
    // ทักษะกลาง (S03/S17) — KYC ตรวจว่าทักษะที่ส่งมาเป็นรหัสกลางที่วิชาชีพถือได้
    await seedProductionMasterData();
    await h.prisma.servicePriceCatalog.upsert({
      where: { serviceType: 'elderly_care' },
      create: { serviceType: 'elderly_care', pricePerHour: 300 },
      update: { isActive: true },
    });
    admin = await h.seedAdmin();
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  /** ใบประกอบฯ ที่อัปโหลดแล้ว (รอตรวจ) ของผู้ใช้ — precondition */
  async function license(userId: string, caregiverId: string | null = null) {
    const doc = await h.prisma.kycDocument.create({
      data: {
        userId,
        caregiverId,
        documentType: 'professional_license',
        fileUrl: '',
        fileName: 'license.jpg',
        fileSize: 1,
        mimeType: 'image/jpeg',
        reviewStatus: 'pending',
        licenseNumber: `QA-${randomUUID().slice(0, 6)}`,
        expiresAt: new Date(Date.now() + 365 * 86_400_000),
      },
    });
    return doc.id;
  }

  const kycInput = (
    profession: string | undefined,
    extra: Record<string, unknown> = {},
  ) => ({
    fullName: 'ผู้ดูแล ทดสอบ QA',
    idCardNumber: thaiId(),
    phone: `08${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
    experienceYears: 2,
    skills: ['bathing'],
    documentIds: [],
    ...(profession === undefined ? {} : { profession }),
    ...extra,
  });

  /** ผู้สมัครใหม่ (role ผู้ดูแล ยังไม่มีแถว caregivers) */
  const applicant = () => h.seedUser('applicant', 2);

  /** ผู้ดูแลที่อนุมัติแล้วและค้นหาได้ ในจังหวัดเฉพาะของเคส */
  async function approved(profession: Profession, province: string) {
    const cg = await h.seedCaregiver({
      profession,
      license:
        profession === 'general_caregiver'
          ? null
          : {
              status: 'approved',
              expiresAt: new Date(Date.now() + 365 * 86_400_000),
            },
    });
    await h.prisma.caregiver.update({
      where: { id: cg.caregiverId },
      data: { serviceAreaProvince: province },
    });
    return cg;
  }

  const publicProfession = async (caregiverId: string) =>
    (
      (
        await h
          .rest(admin.token)
          .get(`/api/v1/caregivers/${caregiverId}/public`)
      ).body as { profession?: string }
    ).profession;
  const listed = async (province: string) =>
    new Map(
      dataOf<{ data: { id: string; profession: string }[] }>(
        await h.gql(admin.token, SEARCH, { p: province }),
        'searchCaregivers',
      ).data.map((c) => [c.id, c.profession]),
    );

  // ───────────────────────────── AC1 ─────────────────────────────
  describe('AC1 · ต้องเลือกวิชาชีพ', () => {
    it('PYG-556_01 Verify that submitting KYC without a profession returns PROFESSION_REQUIRED and writes nothing', async () => {
      const u = await applicant();
      const body = await h.gql(u.token, SUBMIT_KYC, { i: kycInput(undefined) });
      expect(codeOf(body)).toBe('PROFESSION_REQUIRED');
      expect(await h.prisma.caregiver.count({ where: { userId: u.id } })).toBe(
        0,
      );
    });
  });

  // ───────────────────────────── AC2 ─────────────────────────────
  describe('AC2 · 3 ค่าเท่านั้น', () => {
    it('PYG-556_02 Verify that the profession enum offers exactly the 3 values', async () => {
      const body = await h.gql(
        admin.token,
        `query { __type(name: "CaregiverProfession") { enumValues { name } } }`,
      );
      const values = (
        body.data as { __type: { enumValues: { name: string }[] } }
      ).__type.enumValues
        .map((v) => v.name)
        .sort();
      expect(values).toEqual([...PROFESSIONS].sort());
    });

    it.each(PROFESSIONS)(
      'PYG-556_03 Verify that KYC with profession %s is saved correctly',
      async (profession) => {
        const u = await applicant();
        const docs =
          profession === 'general_caregiver' ? [] : [await license(u.id)];
        const skills =
          profession === 'physiotherapist'
            ? ['physiotherapy']
            : profession === 'nurse'
              ? ['injection']
              : ['bathing'];
        const body = await h.gql(u.token, SUBMIT_KYC, {
          i: kycInput(profession, { documentIds: docs, skills }),
        });
        expect(body.errors).toBeUndefined();
        expect(
          dataOf<{ profession: string; kycStatus: string }>(body, 'submitKyc'),
        ).toMatchObject({ profession, kycStatus: 'pending' });
        expect(
          (
            await h.prisma.caregiver.findFirstOrThrow({
              where: { userId: u.id },
            })
          ).profession,
        ).toBe(profession);
      },
    );

    it.each(['doctor', 'NURSE', 'พยาบาล', ''])(
      'PYG-556_04 Verify that profession "%s" returns PROFESSION_INVALID and writes nothing',
      async (value) => {
        const u = await applicant();
        const body = await h.gql(u.token, SUBMIT_KYC, { i: kycInput(value) });
        expect(['PROFESSION_INVALID', 'PROFESSION_REQUIRED']).toContain(
          codeOf(body),
        );
        if (value !== '') expect(codeOf(body)).toBe('PROFESSION_INVALID');
        expect(
          await h.prisma.caregiver.count({ where: { userId: u.id } }),
        ).toBe(0);
      },
    );
  });

  // ───────────────────────────── AC3 / AC4 ─────────────────────────────
  describe('AC3–AC4 · ฝั่ง Elder เห็นวิชาชีพ', () => {
    it('PYG-556_05 Verify that the Elder list (searchCaregivers) shows the profession of every caregiver, all 3 values', async () => {
      const province = `QA-577-${randomUUID().slice(0, 6)}`;
      const cgs = await Promise.all(
        PROFESSIONS.map((p) => approved(p, province)),
      );
      const list = await listed(province);
      expect(list.size).toBe(3);
      PROFESSIONS.forEach((p, i) =>
        expect(list.get(cgs[i].caregiverId)).toBe(p),
      );
    });

    it.each(PROFESSIONS)(
      'PYG-556_06 Verify that the Elder profile (GET /caregivers/:id/public) shows %s as saved',
      async (p) => {
        const cg = await approved(p, `QA-577-${randomUUID().slice(0, 6)}`);
        expect(await publicProfession(cg.caregiverId)).toBe(p);
      },
    );
  });

  // ───────────────────────────── AC6 · เปลี่ยนวิชาชีพหลังอนุมัติ ─────────────────────────────
  describe('AC6 · ขอเปลี่ยนวิชาชีพหลัง KYC อนุมัติ', () => {
    it('PYG-556_07 Verify that the Elder still sees the old profession while the change is pending, and the new one after approval (with edit logs)', async () => {
      const province = `QA-577-${randomUUID().slice(0, 6)}`;
      const cg = await approved('general_caregiver', province);
      const doc = await license(cg.id, cg.caregiverId);
      const req = await h.gql(cg.token, REQUEST_CHANGE, {
        i: { profession: 'nurse', licenseDocumentId: doc },
      });
      expect(req.errors).toBeUndefined();
      const reqId = dataOf<{ id: string; status: string }>(
        req,
        'requestProfessionChange',
      ).id;
      expect(await publicProfession(cg.caregiverId)).toBe('general_caregiver');
      expect((await listed(province)).get(cg.caregiverId)).toBe(
        'general_caregiver',
      );
      const ok = await h.gql(admin.token, APPROVE_CHANGE, { id: reqId });
      expect(ok.errors).toBeUndefined();
      expect(await publicProfession(cg.caregiverId)).toBe('nurse');
      expect((await listed(province)).get(cg.caregiverId)).toBe('nurse');
      const logs = await h.prisma.caregiver_edit_logs.findMany({
        where: { caregiver_id: cg.caregiverId },
        orderBy: { created_at: 'asc' },
      });
      // field_changes เก็บค่าเป็น JSON-stringified (กติกา computeFieldChanges) → แปลงก่อนเทียบ
      const parse = (v: unknown) =>
        typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
      const changes = logs.flatMap((l) =>
        (Array.isArray(l.field_changes)
          ? (l.field_changes as Record<string, unknown>[])
          : []
        ).map((c) => ({
          action: l.action,
          field: c.field,
          oldValue: parse(c.oldValue),
          newValue: parse(c.newValue),
        })),
      );
      expect(changes).toEqual([
        {
          action: 'profession_change_request',
          field: 'profession',
          oldValue: 'general_caregiver',
          newValue: 'nurse',
        },
        {
          action: 'profession_change_approve',
          field: 'profession',
          oldValue: 'general_caregiver',
          newValue: 'nurse',
        },
      ]);
      expect(logs.some((l) => l.action !== 'profession_change_request')).toBe(
        true,
      );
    });

    it('PYG-556_08 Verify that after the admin rejects the change the profession stays the same', async () => {
      const cg = await approved(
        'general_caregiver',
        `QA-577-${randomUUID().slice(0, 6)}`,
      );
      const doc = await license(cg.id, cg.caregiverId);
      const reqId = dataOf<{ id: string }>(
        await h.gql(cg.token, REQUEST_CHANGE, {
          i: { profession: 'physiotherapist', licenseDocumentId: doc },
        }),
        'requestProfessionChange',
      ).id;
      const no = await h.gql(admin.token, REJECT_CHANGE, {
        i: { id: reqId, reason: 'ใบไม่ชัด (QA)' },
      });
      expect(no.errors).toBeUndefined();
      expect(await publicProfession(cg.caregiverId)).toBe('general_caregiver');
      expect(
        (
          await h.prisma.caregiver.findUniqueOrThrow({
            where: { id: cg.caregiverId },
          })
        ).profession,
      ).toBe('general_caregiver');
    });
  });

  // ─────────────────────────── Edge cases ───────────────────────────
  describe('Edge cases', () => {
    it('PYG-556_09 (E2) Verify that a rejected KYC can be resubmitted with a different profession directly (no separate review queue)', async () => {
      const u = await applicant();
      expect(
        (await h.gql(u.token, SUBMIT_KYC, { i: kycInput('general_caregiver') }))
          .errors,
      ).toBeUndefined();
      await h.prisma.caregiver.update({
        where: { userId: u.id },
        data: { kycStatus: 'rejected' },
      });
      const doc = await license(u.id);
      const again = await h.gql(u.token, SUBMIT_KYC, {
        i: kycInput('physiotherapist', {
          documentIds: [doc],
          skills: ['physiotherapy'],
        }),
      });
      expect(again.errors).toBeUndefined();
      const cg = await h.prisma.caregiver.findFirstOrThrow({
        where: { userId: u.id },
      });
      expect([cg.profession, cg.kycStatus]).toEqual([
        'physiotherapist',
        'pending',
      ]);
      expect(
        await h.prisma.caregiver_edit_logs.count({
          where: { caregiver_id: cg.id, action: 'profession_change_request' },
        }),
      ).toBe(0);
    });

    it('PYG-556_10 (E1) Verify that a KYC draft submitted without choosing a profession is refused (same as AC1)', async () => {
      const u = await applicant();
      expect(
        codeOf(
          await h.gql(u.token, SUBMIT_KYC, {
            i: kycInput(undefined, { bio: 'กรอกค้างไว้ก่อน deploy' }),
          }),
        ),
      ).toBe('PROFESSION_REQUIRED');
    });

    it("PYG-556_11 Verify that caregiver A cannot approve/reject (or otherwise change) caregiver B's profession", async () => {
      const b = await approved(
        'general_caregiver',
        `QA-577-${randomUUID().slice(0, 6)}`,
      );
      const doc = await license(b.id, b.caregiverId);
      const reqId = dataOf<{ id: string }>(
        await h.gql(b.token, REQUEST_CHANGE, {
          i: { profession: 'nurse', licenseDocumentId: doc },
        }),
        'requestProfessionChange',
      ).id;
      const a = await approved(
        'general_caregiver',
        `QA-577-${randomUUID().slice(0, 6)}`,
      );
      expect(codeOf(await h.gql(a.token, APPROVE_CHANGE, { id: reqId }))).toBe(
        'FORBIDDEN',
      );
      expect(
        codeOf(
          await h.gql(a.token, REJECT_CHANGE, {
            i: { id: reqId, reason: 'x' },
          }),
        ),
      ).toBe('FORBIDDEN');
      expect(
        (
          await h.prisma.caregiver.findUniqueOrThrow({
            where: { id: b.caregiverId },
          })
        ).profession,
      ).toBe('general_caregiver');
      // requestProfessionChange ไม่มีช่องระบุผู้ดูแลอื่น — คำขอของ A เป็นของ A เท่านั้น
      const t = await h.gql(
        a.token,
        `query { __type(name: "ProfessionChangeInput") { inputFields { name } } }`,
      );
      expect(JSON.stringify(t)).not.toMatch(/caregiverId|userId/);
    });

    it('PYG-556_12 Verify that an Elder user cannot request or approve a profession change', async () => {
      const elder = await h.seedUser('elder');
      expect(
        codeOf(
          await h.gql(elder.token, REQUEST_CHANGE, {
            i: { profession: 'nurse' },
          }),
        ),
      ).toBe('FORBIDDEN');
      expect(
        codeOf(await h.gql(elder.token, APPROVE_CHANGE, { id: randomUUID() })),
      ).toBe('FORBIDDEN');
    });

    it('PYG-556_13 Verify that a change to a licensed profession without a license is refused', async () => {
      const cg = await approved(
        'general_caregiver',
        `QA-577-${randomUUID().slice(0, 6)}`,
      );
      const body = await h.gql(cg.token, REQUEST_CHANGE, {
        i: { profession: 'nurse' },
      });
      expect(body.errors).toBeDefined();
      expect(
        await h.prisma.caregiver_edit_logs.count({
          where: { caregiver_id: cg.caregiverId },
        }),
      ).toBe(0);
    });

    // บั๊ก PYG-667 (S18): ใบประกอบฯ ที่แนบกับคำขอเปลี่ยนวิชาชีพไม่ถูกนับเป็นหลักฐาน เพราะ matching เทียบค่า
    // JSON-stringified ('"nurse"') กับ caregivers.profession ('nurse') — แก้แล้วเปลี่ยน it.failing → it
    it.failing(
      'PYG-556_15 Verify that a caregiver who became a nurse through an approved change is eligible for an injection booking (S18)',
      async () => {
        const cg = await approved(
          'general_caregiver',
          `QA-577-${randomUUID().slice(0, 6)}`,
        );
        const doc = await license(cg.id, cg.caregiverId);
        const reqId = dataOf<{ id: string }>(
          await h.gql(cg.token, REQUEST_CHANGE, {
            i: { profession: 'nurse', licenseDocumentId: doc },
          }),
          'requestProfessionChange',
        ).id;
        expect(
          (await h.gql(admin.token, APPROVE_CHANGE, { id: reqId })).errors,
        ).toBeUndefined();
        await h.prisma.caregiver.update({
          where: { id: cg.caregiverId },
          data: { skills: [...UNLOCKED_SKILLS, 'injection'] },
        });
        const elder = await h.seedUser('elder');
        const rid = await h.seedAssessedRecipient(elder, {
          flags: ['injection'],
        });
        const res = (await h.rest(elder.token).post('/api/v1/bookings', {
          careRecipientId: rid,
          tasks: ['ดูแลทั่วไป'],
          serviceLocations: ['at_home'],
          serviceType: 'elderly_care',
          startTime: '09:00',
          endTime: '11:00',
          locationAddress: 'บ้านทดสอบ QA-577',
          bookingDate: futureDate(30),
        })) as Res;
        const bookingId = (res.body as { id: string }).id;
        const report = await h.gql(
          admin.token,
          `query($b: ID!) { bookingMatchReport(bookingId: $b) { results { caregiver { id } passed reasons { reason } } } }`,
          { b: bookingId },
        );
        const row = dataOf<{
          results: {
            caregiver: { id: string };
            passed: boolean;
            reasons: { reason: string }[];
          }[];
        }>(report, 'bookingMatchReport').results.find(
          (r) => r.caregiver.id === cg.caregiverId,
        );
        expect(row?.reasons).toEqual([]);
        expect(row?.passed).toBe(true);
      },
    );
  });
});
