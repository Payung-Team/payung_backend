/**
 * PYG-621 · QA ของ S10 (PYG-565) — แจ้งโรคติดเชื้อ · การรับทราบก่อนรับงาน · สิทธิ์การมองเห็น
 *
 * ยิง REST / GraphQL เข้าแอปจริง (harness: test/support/qa-e2e.ts) ต่อ Postgres ทิ้งได้ใน Docker
 * TC_NO = PYG-565_NN · รายงานผล: docs/qa/pyg-621-infection-report.md
 *
 * - contract PYG-617 ยังไม่ได้เขียนเป็นเอกสาร/ตารางสิทธิ์ → expected มาจาก AC ของการ์ดและกติกาข้อมูลสุขภาพ
 *   ในการ์ด PYG-617 ("อยู่ได้ 2 ที่เท่านั้น") · ประเด็นที่ story ยังไม่เคาะ = BLOCKED ในรายงาน (บันทึกพฤติกรรมจริงไว้)
 * - ตรวจ response ดิบเสมอ (ไม่ใช่แค่ field ที่หน้าจอใช้)
 * - ญาติบันทึกผ่าน REST /api/v1/patient/care-recipients · ผู้ดูแลอ่านผ่าน caregiverBooking / caregiverBookings
 */
import {
  bootstrap,
  codeOf,
  describeDb,
  futureDate,
  GqlBody,
  Harness,
  seedProductionMasterData,
} from './support/qa-e2e';

type Res = { status: number; body: unknown };
type Disclosure = {
  hasInfectiousDisease: boolean | null;
  acknowledgedAt: string | null;
} | null;

const CG_BOOKING = `query($id: ID!) { caregiverBooking(id: $id) { id status infectionDisclosure { hasInfectiousDisease acknowledgedAt } } }`;
const CG_LIST = `query($s: BookingStatus!) { caregiverBookings(input: { status: $s, limit: 50 }) { data { id infectionDisclosure { hasInfectiousDisease acknowledgedAt } } } }`;
const ACCEPT = `mutation($id: ID!, $ack: Boolean) { acceptBooking(bookingId: $id, infectionAcknowledged: $ack) { id status infectionDisclosure { hasInfectiousDisease acknowledgedAt } } }`;
const DECLINE = `mutation($id: ID!) { declineBooking(input: { bookingId: $id, reason: "ไม่ว่าง (QA)" }) { id status } }`;

const dataOf = <T>(body: GqlBody, field: string): T =>
  (body.data as Record<string, unknown> | null)?.[field] as T;
const restBody = (res: Res) => res.body as Record<string, unknown>;
const INFECTION_WORDS = /hasInfectiousDisease|infectious|infection|ติดเชื้อ/i;

describeDb('PYG-621 · S10 infectious disease disclosure (PYG-565)', () => {
  let h: Harness;
  let day = 40;

  beforeAll(async () => {
    h = await bootstrap();
    await seedProductionMasterData();
    await h.prisma.servicePriceCatalog.upsert({
      where: { serviceType: 'elderly_care' },
      create: { serviceType: 'elderly_care', pricePerHour: 300 },
      update: { isActive: true },
    });
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  /** ญาติ + โปรไฟล์ (REST) + แบบประเมิน · infection: true/false = ระบุพร้อมรับทราบข้อความ · undefined = ยังไม่ได้ระบุ */
  async function relative(infection?: boolean) {
    const user = await h.seedUser('relative');
    const res: Res = await h
      .rest(user.token)
      .post('/api/v1/patient/care-recipients', {
        name: `ผู้สูงอายุทดสอบ ${user.id.slice(0, 4)}`,
        ...(infection === undefined
          ? {}
          : {
              hasInfectiousDisease: infection,
              disclosureNoticeAccepted: true,
            }),
      });
    expect(res.status).toBe(201);
    const recipientId = (res.body as { id: string }).id;
    await h.submitAssessment(user, recipientId);
    return { user, recipientId };
  }
  type Rel = Awaited<ReturnType<typeof relative>>;

  const setInfection = (r: Rel, value: boolean, accepted = true) =>
    h
      .rest(r.user.token)
      .put(`/api/v1/patient/care-recipients/${r.recipientId}`, {
        hasInfectiousDisease: value,
        disclosureNoticeAccepted: accepted,
      }) as Promise<Res>;

  async function profile(r: Rel) {
    const list = (
      await h.rest(r.user.token).get('/api/v1/patient/care-recipients')
    ).body as Record<string, unknown>[];
    return list.find((x) => x.id === r.recipientId);
  }

  /** จอง (unmatched) แล้วเลือกผู้ดูแล → pending */
  async function request(
    r: Rel,
    cg: Awaited<ReturnType<Harness['seedCaregiver']>>,
  ) {
    const res: Res = await h.rest(r.user.token).post('/api/v1/bookings', {
      careRecipientId: r.recipientId,
      tasks: ['ดูแลทั่วไป'],
      serviceLocations: ['at_home'],
      serviceType: 'elderly_care',
      startTime: '09:00',
      endTime: '11:00',
      locationAddress: 'บ้านทดสอบ QA-621',
      bookingDate: futureDate(day++),
    });
    expect(res.status).toBe(201);
    const id = (res.body as { id: string }).id;
    expect(
      (await h.selectCaregiver(r.user, id, cg.caregiverId)).errors,
    ).toBeUndefined();
    return id;
  }

  const view = async (cg: { token: string }, id: string) =>
    h.gql(cg.token, CG_BOOKING, { id });
  const disclosure = async (cg: { token: string }, id: string) =>
    dataOf<{ infectionDisclosure: Disclosure } | null>(
      await view(cg, id),
      'caregiverBooking',
    )?.infectionDisclosure ?? null;

  // ───────────────────────────── AC1 · ญาติระบุ ─────────────────────────────
  describe('AC1 · ญาติระบุ มี / ไม่มี', () => {
    it.each([true, false])(
      'PYG-565_01 Verify that the relative can save "%s" and sees it when reopening',
      async (value) => {
        const r = await relative();
        const res = await setInfection(r, value);
        expect(res.status).toBe(200);
        expect(restBody(res).hasInfectiousDisease).toBe(value);
        expect((await profile(r))?.hasInfectiousDisease).toBe(value);
      },
    );

    it('PYG-565_02 Verify that the relative can switch no → yes → no', async () => {
      const r = await relative(false);
      expect(restBody(await setInfection(r, true)).hasInfectiousDisease).toBe(
        true,
      );
      expect(restBody(await setInfection(r, false)).hasInfectiousDisease).toBe(
        false,
      );
      expect((await profile(r))?.hasInfectiousDisease).toBe(false);
    });

    it('PYG-565_03 Verify that a never-specified elder shows "not specified" (null), not "no" (false)', async () => {
      const r = await relative();
      const p = await profile(r);
      expect(p).toHaveProperty('hasInfectiousDisease', null);
      const row = await h.prisma.careRecipient.findUniqueOrThrow({
        where: { id: r.recipientId },
      });
      expect(row.has_infectious_disease).toBeNull();
    });
  });

  // ───────────────────────────── AC2 · ผู้ดูแลเห็นในคำขอ ─────────────────────────────
  describe('AC2 · ข้อมูลในคำขอรับงาน', () => {
    it.each<[string, boolean | undefined, boolean | null]>([
      ['yes', true, true],
      ['no', false, false],
      ['not specified', undefined, null],
    ])(
      'PYG-565_04 Verify that the requested caregiver sees the value (%s) in the pending request before accepting',
      async (_l, value, expected) => {
        const r = await relative(value);
        const cg = await h.seedCaregiver();
        const id = await request(r, cg);
        expect(await disclosure(cg, id)).toEqual({
          hasInfectiousDisease: expected,
          acknowledgedAt: null,
        });
        // รายการคำขอ (หน้ารายการงานของผู้ดูแล) ให้ค่าเดียวกัน
        const list = dataOf<{
          data: { id: string; infectionDisclosure: Disclosure }[];
        }>(
          await h.gql(cg.token, CG_LIST, { s: 'PENDING' }),
          'caregiverBookings',
        );
        expect(list.data.find((b) => b.id === id)?.infectionDisclosure).toEqual(
          { hasInfectiousDisease: expected, acknowledgedAt: null },
        );
      },
    );

    it('PYG-565_05 Verify that a change by the relative after the request is seen by the caregiver (latest value)', async () => {
      const r = await relative(false);
      const cg = await h.seedCaregiver();
      const id = await request(r, cg);
      await setInfection(r, true);
      expect((await disclosure(cg, id))?.hasInfectiousDisease).toBe(true);
    });
  });

  // ───────────────────────────── AC3 · รับทราบก่อนรับงาน ─────────────────────────────
  describe('AC3 · รับทราบก่อนรับงาน', () => {
    it('PYG-565_06 Verify that accepting a "yes" request without acknowledgement returns INFECTION_ACK_REQUIRED and the status stays pending', async () => {
      const r = await relative(true);
      const cg = await h.seedCaregiver();
      const id = await request(r, cg);
      for (const ack of [undefined, false]) {
        const body = await h.gql(cg.token, ACCEPT, {
          id,
          ...(ack === undefined ? {} : { ack }),
        });
        expect(codeOf(body)).toBe('INFECTION_ACK_REQUIRED');
      }
      const row = await h.prisma.booking.findUniqueOrThrow({ where: { id } });
      expect([row.status, row.infectionAckAt]).toEqual(['pending', null]);
    });

    it('PYG-565_07 Verify that accepting with acknowledgement succeeds and stores the acknowledgement time and caregiver', async () => {
      const r = await relative(true);
      const cg = await h.seedCaregiver();
      const id = await request(r, cg);
      const body = await h.gql(cg.token, ACCEPT, { id, ack: true });
      expect(body.errors).toBeUndefined();
      const out = dataOf<{ status: string; infectionDisclosure: Disclosure }>(
        body,
        'acceptBooking',
      );
      expect(out.status).toBe('accepted');
      expect(out.infectionDisclosure?.acknowledgedAt).toEqual(
        expect.any(String),
      );
      const row = await h.prisma.booking.findUniqueOrThrow({ where: { id } });
      expect(row.infectionAckAt).not.toBeNull();
      expect(row.infectionAckBy).toBe(cg.caregiverId);
    });

    it('PYG-565_08 Verify that a relative change after the caregiver acknowledged makes the acknowledgement stale (acknowledgedAt null again)', async () => {
      const r = await relative(true);
      const cg = await h.seedCaregiver();
      const id = await request(r, cg);
      await h.gql(cg.token, ACCEPT, { id, ack: true });
      await new Promise((x) => setTimeout(x, 10));
      await setInfection(r, false);
      await setInfection(r, true);
      expect(await disclosure(cg, id)).toEqual({
        hasInfectiousDisease: true,
        acknowledgedAt: null,
      });
    });

    it('PYG-565_09 Verify that two rapid accept calls store the acknowledgement once', async () => {
      const r = await relative(true);
      const cg = await h.seedCaregiver();
      const id = await request(r, cg);
      const [a, b] = await Promise.all([
        h.gql(cg.token, ACCEPT, { id, ack: true }),
        h.gql(cg.token, ACCEPT, { id, ack: true }),
      ]);
      expect([a, b].filter((x) => !x.errors)).toHaveLength(1);
      const row = await h.prisma.booking.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('accepted');
      expect(row.infectionAckBy).toBe(cg.caregiverId);
    });

    it.each<[string, boolean | undefined]>([
      ['no', false],
      ['not specified', undefined],
    ])(
      'PYG-565_10 [observed · undecided] Verify the current behaviour when accepting a "%s" request without acknowledgement',
      async (_l, value) => {
        const r = await relative(value);
        const cg = await h.seedCaregiver();
        const id = await request(r, cg);
        const body = await h.gql(cg.token, ACCEPT, { id });
        // พฤติกรรมปัจจุบัน (needsInfectionAck): ไม่บังคับ — story ยังไม่เคาะ "รับทราบทุกงานหรือเฉพาะ มี"
        expect(body.errors).toBeUndefined();
      },
    );
  });

  // ───────────────────────────── AC4 · สิทธิ์ ─────────────────────────────
  describe('AC4 · ใครเห็นได้', () => {
    it('PYG-565_11 Verify that another caregiver gets no data for the same request, with no hint whether data exists', async () => {
      const r = await relative(true);
      const cg = await h.seedCaregiver();
      const other = await h.seedCaregiver();
      const id = await request(r, cg);
      const withData = await view(other, id);
      const r2 = await relative();
      const id2 = await request(r2, cg);
      const withoutData = await view(other, id2);
      expect(dataOf<unknown>(withData, 'caregiverBooking') ?? null).toBeNull();
      expect(JSON.stringify(withData)).not.toMatch(
        /"hasInfectiousDisease":true/,
      );
      // ไม่มีข้อมูลกับมีข้อมูล ได้ผลรูปเดียวกัน
      expect(JSON.stringify(withData).replace(id, 'X')).toBe(
        JSON.stringify(withoutData).replace(id2, 'X'),
      );
      // ตอบรับงานแทนไม่ได้
      expect(
        (await h.gql(other.token, ACCEPT, { id, ack: true })).errors,
      ).toBeDefined();
    });

    it('PYG-565_12 Verify that calls without login are refused (caregiver API and relative API)', async () => {
      const r = await relative(true);
      const cg = await h.seedCaregiver();
      const id = await request(r, cg);
      expect(codeOf(await h.gql(null, CG_BOOKING, { id }))).toBe(
        'UNAUTHENTICATED',
      );
      expect(
        (await h.rest('no-such-token').get('/api/v1/patient/care-recipients'))
          .status,
      ).toBe(401);
    });

    it('PYG-565_13 Verify that the field exists only on the relative profile (REST) and CaregiverBookingSummary — no public, list, profile or admin type', async () => {
      const body = await h.gql(
        null,
        `query { __schema { types { name fields { name } } } }`,
      );
      const types = (
        body.data as {
          __schema: {
            types: { name: string; fields: { name: string }[] | null }[];
          };
        }
      ).__schema.types;
      const carrying = types
        .filter(
          (t) => !t.name.startsWith('__') && t.name !== 'InfectionDisclosure',
        )
        .filter((t) =>
          (t.fields ?? []).some((f) => INFECTION_WORDS.test(f.name)),
        )
        .map((t) => t.name);
      expect(carrying).toEqual(['CaregiverBookingSummary']);
    });

    it('PYG-565_14 Verify that the relative of another elder cannot read or write this value', async () => {
      const r = await relative(true);
      const a = await relative();
      const list = JSON.stringify(
        (await h.rest(a.user.token).get('/api/v1/patient/care-recipients'))
          .body,
      );
      expect(list).not.toContain(r.recipientId);
      const write: Res = await h
        .rest(a.user.token)
        .put(`/api/v1/patient/care-recipients/${r.recipientId}`, {
          hasInfectiousDisease: false,
          disclosureNoticeAccepted: true,
        });
      expect([403, 404]).toContain(write.status);
      expect(
        (
          await h.prisma.careRecipient.findUniqueOrThrow({
            where: { id: r.recipientId },
          })
        ).has_infectious_disease,
      ).toBe(true);
    });

    it('PYG-565_15 Verify that a caregiver role cannot save the value (relative API is patient-only)', async () => {
      const r = await relative(true);
      const cg = await h.seedCaregiver();
      const res: Res = await h
        .rest(cg.token)
        .put(`/api/v1/patient/care-recipients/${r.recipientId}`, {
          hasInfectiousDisease: false,
          disclosureNoticeAccepted: true,
        });
      expect([401, 403, 404]).toContain(res.status);
      expect(
        (
          await h.prisma.careRecipient.findUniqueOrThrow({
            where: { id: r.recipientId },
          })
        ).has_infectious_disease,
      ).toBe(true);
    });
  });

  // ───────────────────────────── AC5 · ข้อความแจ้งการเปิดเผย ─────────────────────────────
  describe('AC5 · ต้องรับทราบข้อความแจ้งก่อนบันทึก', () => {
    it.each<[string, Record<string, unknown>]>([
      ['first time (create, no notice)', { hasInfectiousDisease: true }],
      [
        'first time (create, notice = false)',
        { hasInfectiousDisease: true, disclosureNoticeAccepted: false },
      ],
    ])(
      'PYG-565_16 Verify that saving without accepting the notice returns 422 INFECTION_NOTICE_NOT_ACCEPTED (%s) and nothing is saved',
      async (_l, body) => {
        const user = await h.seedUser('relative');
        const before = await h.prisma.careRecipient.count({
          where: { patientId: user.id },
        });
        const res: Res = await h
          .rest(user.token)
          .post('/api/v1/patient/care-recipients', {
            name: 'ผู้สูงอายุ QA',
            ...body,
          });
        expect(res.status).toBe(422);
        expect(restBody(res)).toMatchObject({
          code: 'INFECTION_NOTICE_NOT_ACCEPTED',
        });
        expect(
          await h.prisma.careRecipient.count({ where: { patientId: user.id } }),
        ).toBe(before);
      },
    );

    it('PYG-565_17 Verify that editing without accepting the notice returns INFECTION_NOTICE_NOT_ACCEPTED and keeps the old value', async () => {
      const r = await relative(false);
      const res = await setInfection(r, true, false);
      expect(res.status).toBe(422);
      expect(restBody(res)).toMatchObject({
        code: 'INFECTION_NOTICE_NOT_ACCEPTED',
      });
      expect((await profile(r))?.hasInfectiousDisease).toBe(false);
    });

    it('PYG-565_18 Verify that the error message does not contain the health value', async () => {
      const r = await relative(false);
      const res = await setInfection(r, true, false);
      expect(JSON.stringify(res.body)).not.toMatch(
        /"hasInfectiousDisease"|true/,
      );
    });
  });

  // ─────────────────────────── Edge cases ───────────────────────────
  describe('Edge cases', () => {
    it.each<[string, string]>([
      ['declined', 'decline'],
      ['expired', 'expired'],
      ['cancelled', 'cancelled'],
    ])(
      'PYG-565_19 (E5) Verify that after the request is %s the caregiver no longer gets the data',
      async (_l, how) => {
        const r = await relative(true);
        const cg = await h.seedCaregiver();
        const id = await request(r, cg);
        if (how === 'decline')
          expect(
            (await h.gql(cg.token, DECLINE, { id })).errors,
          ).toBeUndefined();
        else
          await h.prisma.booking.update({
            where: { id },
            data: { status: how },
          });
        const body = await view(cg, id);
        expect(JSON.stringify(body)).not.toMatch(/"hasInfectiousDisease":true/);
        const d = dataOf<{ infectionDisclosure: Disclosure } | null>(
          body,
          'caregiverBooking',
        );
        expect(d?.infectionDisclosure ?? null).toBeNull();
      },
    );

    it('PYG-565_20 (E7) Verify that a caregiver guessing an unrelated booking id gets the same result as for a non-existent id', async () => {
      const r = await relative(true);
      const cg = await h.seedCaregiver();
      const id = await request(r, cg);
      const stranger = await h.seedCaregiver();
      const real = await view(stranger, id);
      const ghost = await view(
        stranger,
        '00000000-0000-4000-8000-000000000000',
      );
      expect(JSON.stringify(real.data)).toBe(JSON.stringify(ghost.data));
      expect(real.errors?.[0]?.extensions?.code).toBe(
        ghost.errors?.[0]?.extensions?.code,
      );
    });

    it('PYG-565_21 (E8) Verify that notifications created for the request and acceptance contain no infection data', async () => {
      const r = await relative(true);
      const cg = await h.seedCaregiver();
      const id = await request(r, cg);
      await h.gql(cg.token, ACCEPT, { id, ack: true });
      await new Promise((x) => setTimeout(x, 300));
      const rows = await h.prisma.notification.findMany({
        where: { userId: { in: [r.user.id, cg.id] } },
      });
      expect(rows.length).toBeGreaterThan(0);
      for (const n of rows)
        expect(JSON.stringify([n.title, n.body, n.data])).not.toMatch(
          INFECTION_WORDS,
        );
    });

    it('PYG-565_22 (E9) Verify that a job accepted before the feature continues (patient confirm) without forcing acknowledgement', async () => {
      const r = await relative();
      const cg = await h.seedCaregiver();
      const id = await request(r, cg);
      expect((await h.gql(cg.token, ACCEPT, { id })).errors).toBeUndefined();
      // หลังรับงานแล้ว ญาติเพิ่งระบุว่า "มี" → งานเดิมต้องเดินต่อได้
      await setInfection(r, true);
      const confirm = await h.gql(
        r.user.token,
        `mutation($id: ID!) { confirmBooking(bookingId: $id) { id status } }`,
        { id },
      );
      expect(confirm.errors).toBeUndefined();
      expect(dataOf<{ status: string }>(confirm, 'confirmBooking').status).toBe(
        'confirmed',
      );
    });

    it('PYG-565_23 [observed · E6 undecided] Verify the current behaviour for a completed job: the caregiver no longer gets the data', async () => {
      const r = await relative(true);
      const cg = await h.seedCaregiver();
      const id = await request(r, cg);
      await h.gql(cg.token, ACCEPT, { id, ack: true });
      await h.prisma.booking.update({
        where: { id },
        data: { status: 'completed' },
      });
      expect(await disclosure(cg, id)).toBeNull();
    });
  });
});
