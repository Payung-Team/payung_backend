/**
 * E2E (GraphQL + REST) — PYG-440 · QR check-in / check-out: security & edge (การ์ดแม่ PYG-433)
 *
 * สเปก: PYG-433 (QR-lite) + PYG-434/435/436 (BE) + PYG-441 (config) + ข้อตัดสินใจ PYG-437 ที่อยู่ในโค้ด
 * ★ นอกขอบเขตโดยตั้งใจ (Sprint 9 ตาม PYG-433): anti-replay ของภาพหน้าจอ · offline queue · geofence
 *
 * guard chain จริง + MonitoringModule ตัวจริง + Prisma จริงกับ Postgres ทิ้งได้ (test/support/qr-e2e.ts)
 * เวลา: ClockService ถูกแทนด้วยนาฬิกาที่คุมเอง — ทุกเคสตั้งเวลาเองทุกครั้ง ไม่พึ่งนาฬิกาจริง
 * TC_15 (concurrency) อยู่แยกที่ qr-checkin-checkout.concurrency.e2e-spec.ts
 * วิธีรัน: docs/qa/pyg-440-qr-checkin-checkout-report.md หัวข้อ "How to run"
 */
import { createHash, randomBytes } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  QR_MIN_SECONDS_BETWEEN_ACTIONS,
  QR_SINGLE_USE_PER_ACTION,
  QR_VALID_FROM_OFFSET_MIN,
  QR_VALID_UNTIL_GRACE_MIN,
} from '../src/monitoring/qr/qr.constants';
import { MonitoringService } from '../src/monitoring/monitoring.service';
import { NoCheckoutSweeperService } from '../src/monitoring/no-checkout-sweeper.service';
import {
  at,
  bootstrap,
  codeOf,
  describeDb,
  END,
  Harness,
  START,
} from './support/qr-e2e';

jest.setTimeout(90_000);

const sha256 = (s: string) =>
  createHash('sha256').update(s, 'utf8').digest('hex');

describeDb('PYG-440 · QR check-in / check-out (e2e, real DB)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await bootstrap();
  });

  afterAll(async () => {
    await h?.close();
  });

  /** เช็คอินให้เรียบร้อยที่เวลาเริ่มงาน แล้วคืน token ของเช็คเอาท์ */
  const checkedIn = async (job: Awaited<ReturnType<Harness['seedJob']>>) => {
    h.clock.set(START);
    const { r } = await h.scan(job.caregiver!.token, job.token);
    expect(r?.result).toBe('SUCCESS');
    return h.currentToken(job.patient.token, job.bookingId);
  };

  /** ตรวจเคสลบครบสามอย่าง: รหัส · สถานะไม่ขยับ · มีแถว log บันทึกการปฏิเสธ */
  const expectRejected = async (
    bookingId: string,
    before: Awaited<ReturnType<Harness['state']>>,
    r: Record<string, any> | undefined,
    code: string,
  ) => {
    const after = await h.state(bookingId);
    expect({
      ok: r?.ok,
      result: r?.result,
      sessionStatus: after.sessionStatus,
      bookingStatus: after.bookingStatus,
      events: after.events,
      newScanRows: after.scanRows - before.scanRows,
    }).toEqual({
      ok: false,
      result: code,
      sessionStatus: before.sessionStatus,
      bookingStatus: before.bookingStatus,
      events: before.events,
      newScanRows: 1,
    });
  };

  // ═══════════════════════════════════════════════════════════════════════
  //  Happy path
  // ═══════════════════════════════════════════════════════════════════════

  it("PYG-440_01 — the assigned caregiver's first scan checks in the job", async () => {
    const job = await h.seedJob();
    h.clock.set(START);

    const { r } = await h.scan(job.caregiver!.token, job.token);

    expect(r).toMatchObject({
      ok: true,
      result: 'SUCCESS',
      action: 'CHECK_IN',
      sessionStatus: 'CHECKED_IN',
    });
    const s = await h.state(job.bookingId);
    expect(s).toMatchObject({
      sessionStatus: 'CHECKED_IN',
      bookingStatus: 'in_progress',
      events: ['check_in:caregiver'],
      scanRows: 1,
    });
    const ev = await h.prisma.jobEvent.findFirstOrThrow({
      where: { bookingId: job.bookingId },
    });
    expect(ev.serverTs.toISOString()).toBe(START.toISOString()); // เวลาเซิร์ฟเวอร์ ไม่ใช่ของเครื่อง
    const row = await h.prisma.jobScanEvent.findFirstOrThrow({
      where: { bookingId: job.bookingId },
    });
    expect(row).toMatchObject({
      result: 'SUCCESS',
      action: 'CHECK_IN',
      scannedBy: job.caregiver!.id,
    });
  });

  it('PYG-440_02 — the second scan checks the job out (same QR, no new token issued)', async () => {
    const job = await h.seedJob();
    h.clock.set(START);
    await h.scan(job.caregiver!.token, job.token);

    h.clock.set(at(START, 120));
    const reuseCheckInToken = await h.scan(job.caregiver!.token, job.token);
    const checkOutToken = await h.currentToken(
      job.patient.token,
      job.bookingId,
    );
    const { r } = await h.scan(job.caregiver!.token, checkOutToken, {
      deviceTs: '2020-01-01T00:00:00.000Z',
    });

    expect(r).toMatchObject({
      ok: true,
      result: 'SUCCESS',
      action: 'CHECK_OUT',
      sessionStatus: 'CHECKED_OUT',
    });
    const s = await h.state(job.bookingId);
    expect(s.events).toEqual(['check_in:caregiver', 'check_out:caregiver']);
    const out = await h.prisma.jobEvent.findFirstOrThrow({
      where: { bookingId: job.bookingId, eventType: 'check_out' },
    });
    expect(out.serverTs.toISOString()).toBe(at(START, 120).toISOString()); // ไม่ใช่ deviceTs ปี 2020

    // ชีต: "Same QR, no new token issued"
    expect({
      sessionRows: await h.prisma.jobSession.count({
        where: { bookingId: job.bookingId },
      }),
      checkInTokenStillAccepted: reuseCheckInToken.r?.result,
      sameTokenForCheckOut: checkOutToken === job.token,
    }).toEqual({
      sessionRows: 1,
      checkInTokenStillAccepted: 'SUCCESS',
      sameTokenForCheckOut: true,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  Binding / authorization
  // ═══════════════════════════════════════════════════════════════════════

  it('PYG-440_03 — a QR cannot be applied to another booking (the booking is bound to the token)', async () => {
    const caregiver = await h.seedCaregiver();
    const b1 = await h.seedJob({ caregiver });
    const b2 = await h.seedJob({ caregiver });
    h.clock.set(START);
    const before1 = await h.state(b1.bookingId);
    const before2 = await h.state(b2.bookingId);

    // พยายามระบุ booking เอง พร้อม token ของ B2 → schema ไม่มี argument นี้
    const spoof = await h.gql(
      caregiver.token,
      `mutation($input: ScanJobQrInput!) { scanJobQr(input: $input) { ok result } }`,
      {
        input: { token: b2.token, bookingId: b1.bookingId },
      },
    );

    expect(codeOf(spoof)).toBe('BAD_USER_INPUT'); // ScanJobQrInput ไม่มีฟิลด์ bookingId — GraphQL ปฏิเสธก่อนถึง resolver
    expect(await h.state(b1.bookingId)).toEqual(before1);
    expect(await h.state(b2.bookingId)).toEqual(before2);
  });

  it('PYG-440_04 — a caregiver who is not assigned to the booking cannot scan', async () => {
    const job = await h.seedJob();
    const d = await h.seedCaregiver();
    h.clock.set(START);
    const before = await h.state(job.bookingId);

    const { r } = await h.scan(d.token, job.token);

    await expectRejected(job.bookingId, before, r, 'WRONG_CAREGIVER');
    const row = (await h.scanRowsBy(d.id))[0];
    expect(row).toMatchObject({
      scannedBy: d.id,
      caregiverId: d.caregiverId,
      bookingId: job.bookingId,
      result: 'WRONG_CAREGIVER',
    });
  });

  it('PYG-440_05 — the action is derived from state; a client cannot choose it', async () => {
    const job = await h.seedJob();
    h.clock.set(START);
    const before = await h.state(job.bookingId);

    // 1) ขอเช็คเอาท์ตรง ๆ ผ่าน scan input → ไม่มีฟิลด์ action ให้ส่ง
    const withAction = await h.gql(
      job.caregiver!.token,
      `mutation($input: ScanJobQrInput!) { scanJobQr(input: $input) { ok result } }`,
      {
        input: { token: job.token, action: 'CHECK_OUT' },
      },
    );
    // 2) เรียก mutation เช็คเอาท์แบบเดิมโดยไม่สแกน → ประตู assertScanned
    const legacyCheckOut = await h.gql(
      job.caregiver!.token,
      `mutation($input: CheckOutInput!) { checkOutBooking(input: $input) { id } }`,
      {
        input: { bookingId: job.bookingId },
      },
    );
    expect(await h.state(job.bookingId)).toEqual(before);

    // 3) สแกนปกติ → server ตัดสินให้เป็น CHECK_IN เอง
    const { r } = await h.scan(job.caregiver!.token, job.token);

    expect({
      clientActionField: codeOf(withAction),
      legacyCheckOutWithoutScan: legacyCheckOut.errors?.[0]?.message,
      derivedAction: r?.action,
      sessionAfter: (await h.state(job.bookingId)).sessionStatus,
    }).toEqual({
      clientActionField: 'BAD_USER_INPUT',
      legacyCheckOutWithoutScan:
        'งานนี้ต้องสแกน QR ของผู้รับบริการก่อนจึงจะเริ่มหรือจบงานได้',
      derivedAction: 'CHECK_IN',
      sessionAfter: 'CHECKED_IN',
    });
  });

  it('PYG-440_06 — a third scan after check-out is rejected (ALREADY_COMPLETED)', async () => {
    const job = await h.seedJob();
    const outToken = await checkedIn(job);
    h.clock.set(at(START, 120));
    expect((await h.scan(job.caregiver!.token, outToken)).r?.result).toBe(
      'SUCCESS',
    );

    h.clock.set(at(START, 125));
    const before = await h.state(job.bookingId);
    const { r } = await h.scan(job.caregiver!.token, outToken);

    await expectRejected(job.bookingId, before, r, 'ALREADY_COMPLETED');
    expect((await h.state(job.bookingId)).events).toHaveLength(2);
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  Time window
  // ═══════════════════════════════════════════════════════════════════════

  it('PYG-440_07 — a scan before validFrom is rejected (OUT_OF_WINDOW)', async () => {
    const job = await h.seedJob();
    h.clock.set(new Date(job.validFrom.getTime() - 60_000));
    const before = await h.state(job.bookingId);

    const { r } = await h.scan(job.caregiver!.token, job.token);

    await expectRejected(job.bookingId, before, r, 'OUT_OF_WINDOW');
    expect(job.validFrom.toISOString()).toBe(
      at(START, -QR_VALID_FROM_OFFSET_MIN).toISOString(),
    );
  });

  it('PYG-440_08 — a scan after validUntil (which already includes the grace) is rejected', async () => {
    const job = await h.seedJob();
    expect(job.validUntil.toISOString()).toBe(
      at(END, QR_VALID_UNTIL_GRACE_MIN).toISOString(),
    );
    h.clock.set(new Date(job.validUntil.getTime() + 1_000));
    const before = await h.state(job.bookingId);

    const { r } = await h.scan(job.caregiver!.token, job.token);

    await expectRejected(job.bookingId, before, r, 'OUT_OF_WINDOW');
  });

  it('PYG-440_09 — window boundaries: validFrom and validUntil are both inclusive (1 ms outside is rejected)', async () => {
    const exactly = await h.seedJob();
    h.clock.set(exactly.validFrom);
    const inAtFrom = await h.scan(exactly.caregiver!.token, exactly.token);
    const outToken = await h.currentToken(
      exactly.patient.token,
      exactly.bookingId,
    );
    h.clock.set(exactly.validUntil);
    const outAtUntil = await h.scan(exactly.caregiver!.token, outToken);

    const early = await h.seedJob();
    h.clock.set(new Date(early.validFrom.getTime() - 1));
    const oneMsBefore = await h.scan(early.caregiver!.token, early.token);

    const late = await h.seedJob();
    h.clock.set(new Date(late.validUntil.getTime() + 1));
    const oneMsAfter = await h.scan(late.caregiver!.token, late.token);

    expect({
      atValidFrom: inAtFrom.r?.result,
      atValidUntil: outAtUntil.r?.result,
      oneMsBeforeValidFrom: oneMsBefore.r?.result,
      oneMsAfterValidUntil: oneMsAfter.r?.result,
    }).toEqual({
      atValidFrom: 'SUCCESS',
      atValidUntil: 'SUCCESS',
      oneMsBeforeValidFrom: 'OUT_OF_WINDOW',
      oneMsAfterValidUntil: 'OUT_OF_WINDOW',
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  Booking lifecycle
  // ═══════════════════════════════════════════════════════════════════════

  it('PYG-440_10 — scanning a booking cancelled after the QR was issued is rejected (BOOKING_INACTIVE)', async () => {
    const job = await h.seedJob();
    await h.prisma.booking.update({
      where: { id: job.bookingId },
      data: { status: 'cancelled' },
    });
    h.clock.set(START);
    const before = await h.state(job.bookingId);

    const { r } = await h.scan(job.caregiver!.token, job.token);

    await expectRejected(job.bookingId, before, r, 'BOOKING_INACTIVE');
  });

  it('PYG-440_11 — scanning a booking moved to expired is rejected and never checks in', async () => {
    const job = await h.seedJob();
    await h.prisma.booking.update({
      where: { id: job.bookingId },
      data: { status: 'expired' },
    });
    h.clock.set(START);
    const before = await h.state(job.bookingId);

    const { r } = await h.scan(job.caregiver!.token, job.token);

    // expired ไม่อยู่ใน QR_DEAD_BOOKING_STATUSES → ตกด่าน "สถานะต้อง confirmed" ของ checkInBooking แทน
    await expectRejected(job.bookingId, before, r, 'JOB_NOT_READY');
  });

  it('PYG-440_12 — scanning a booking returned to unmatched is rejected; the stale assignment grants nothing', async () => {
    const job = await h.seedJob();
    // เส้นทางเดียวกับ booking.service.ts (ผู้ดูแลไม่ตอบทันเวลา): status=unmatched, caregiver_id=null
    await h.prisma.booking.update({
      where: { id: job.bookingId },
      data: { status: 'unmatched', caregiverId: null },
    });
    h.clock.set(START);
    const before = await h.state(job.bookingId);

    const { r } = await h.scan(job.caregiver!.token, job.token);

    await expectRejected(job.bookingId, before, r, 'WRONG_CAREGIVER');
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  Token security
  // ═══════════════════════════════════════════════════════════════════════

  it('PYG-440_13 — the raw QR token is never persisted (session table, scan events, logs)', async () => {
    const logsBefore = h.logs.length;
    const job = await h.seedJob();
    const d = await h.seedCaregiver();
    h.clock.set(START);
    await h.scan(d.token, job.token); // แถวล้มเหลว
    await h.scan(job.caregiver!.token, job.token); // แถวสำเร็จ
    const outToken = await h.currentToken(job.patient.token, job.bookingId);

    const sessionRow = await h.prisma.$queryRawUnsafe<
      Record<string, unknown>[]
    >(`select * from job_sessions where booking_id = $1::uuid`, job.bookingId);
    const scanRows = await h.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `select * from job_scan_events where booking_id = $1::uuid`,
      job.bookingId,
    );
    const everything = JSON.stringify([sessionRow, scanRows]);
    const logText = JSON.stringify(h.logs.slice(logsBefore));

    expect(sessionRow[0].token_hash).toBe(sha256(outToken));
    expect(scanRows.map((r) => r.token_hash)).toEqual([
      sha256(job.token),
      sha256(job.token),
    ]);
    expect({
      rawCheckInTokenInDb: everything.includes(job.token),
      rawCheckOutTokenInDb: everything.includes(outToken),
      rawCheckInTokenInLogs: logText.includes(job.token),
      rawCheckOutTokenInLogs: logText.includes(outToken),
      tokenHashInLogs: logText.includes(sha256(job.token)),
    }).toEqual({
      rawCheckInTokenInDb: false,
      rawCheckOutTokenInDb: false,
      rawCheckInTokenInLogs: false,
      rawCheckOutTokenInLogs: false,
      tokenHashInLogs: false,
    });
  });

  it('PYG-440_14 — guessed, truncated, empty and one-char-tampered tokens are rejected and logged', async () => {
    const job = await h.seedJob();
    const caregiver = job.caregiver!;
    h.clock.set(START);
    const before = await h.state(job.bookingId);
    const last = job.token.slice(-1) === 'A' ? 'B' : 'A';
    const variants: Record<string, string> = {
      random: randomBytes(32).toString('base64url'),
      truncated: job.token.slice(0, -5),
      empty: '',
      oneCharChanged: job.token.slice(0, -1) + last,
    };

    const observed: Record<
      string,
      { code: string; loggedRows: number; leaksBooking: boolean }
    > = {};
    for (const [name, token] of Object.entries(variants)) {
      const rowsBefore = (await h.scanRowsBy(caregiver.id)).length;
      const { body, r } = await h.scan(caregiver.token, token);
      observed[name] = {
        code: r?.result ?? String(codeOf(body)),
        loggedRows: (await h.scanRowsBy(caregiver.id)).length - rowsBefore,
        leaksBooking: JSON.stringify(body).includes(job.bookingId),
      };
    }

    expect(await h.state(job.bookingId)).toEqual(before);
    expect(observed).toEqual(
      Object.fromEntries(
        Object.keys(variants).map((k) => [
          k,
          { code: 'TOKEN_NOT_FOUND', loggedRows: 1, leaksBooking: false },
        ]),
      ),
    );
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  Integration: care log · escrow gate
  // ═══════════════════════════════════════════════════════════════════════

  it('PYG-440_16 — check-in records the server_ts the care log deviceTs lower bound depends on', async () => {
    const job = await h.seedJob();
    await checkedIn(job);
    const checkIn = await h.prisma.jobEvent.findFirstOrThrow({
      where: { bookingId: job.bookingId, eventType: 'check_in' },
    });
    expect(checkIn.serverTs.toISOString()).toBe(START.toISOString());

    h.clock.set(at(START, 10));
    const logsBefore = h.logs.length;
    const res = await request(h.app.getHttpServer() as App)
      .post(`/api/v1/monitoring/bookings/${job.bookingId}/care-logs`)
      .set('Authorization', `Bearer ${job.caregiver!.token}`)
      .field('category', 'food')
      .field('body', 'ทานข้าวได้')
      .field('deviceTs', at(START, 1).toISOString()); // หลังเช็คอิน 1 นาที = อยู่ในขอบล่างที่อิงแถวเช็คอิน

    expect(res.status).toBe(201);
    const missing = h.logs
      .slice(logsBefore)
      .filter((l) =>
        JSON.stringify(l).includes('care_log.missing_check_in_event'),
      );
    expect(missing).toEqual([]);
  });

  it('PYG-440_17 — a clean check-out by the assigned caregiver yields the escrow gate inputs for a valid verdict', async () => {
    const job = await h.seedJob();
    const outToken = await checkedIn(job);
    h.clock.set(at(START, 120));
    const { r } = await h.scan(job.caregiver!.token, outToken, {
      deviceTs: at(START, 90).toISOString(),
    });
    expect(r?.result).toBe('SUCCESS');

    const booking = await h.prisma.booking.findUniqueOrThrow({
      where: { id: job.bookingId },
      select: { status: true, reviewReasons: true, disputeStatus: true },
    });
    const proof = await h.app
      .get(MonitoringService)
      .proofOfWorkForSystem(job.bookingId);

    expect({
      checkOutSource: proof.checkOut?.source,
      checkOutServerTs: proof.checkOut?.serverTs.toISOString(),
      reviewReasons: booking.reviewReasons,
      disputeStatus: booking.disputeStatus,
      verdict: proof.verdict,
      bookingStatus: booking.status,
    }).toEqual({
      checkOutSource: 'caregiver',
      checkOutServerTs: at(START, 120).toISOString(), // ไม่ใช่ deviceTs ที่ client ส่งมา
      reviewReasons: [],
      disputeStatus: 'none',
      verdict: 'valid',
      bookingStatus: 'awaiting_release',
    });
  });

  it('PYG-440_18 — a check-out not made by the assigned caregiver cannot yield a valid verdict', async () => {
    const job = await h.seedJob();
    await checkedIn(job);

    // (ก) ผู้ดูแลที่รับงานพยายามปิดงานโดยไม่สแกน → ถูกประตู assertScanned ตีกลับ
    h.clock.set(at(START, 120));
    const bypass = await h.gql(
      job.caregiver!.token,
      `mutation($input: CheckOutInput!) { checkOutBooking(input: $input) { id } }`,
      {
        input: { bookingId: job.bookingId },
      },
    );
    // (ข) ผู้ดูแลคนอื่นสแกน token ของเช็คเอาท์
    const outToken = await h.currentToken(job.patient.token, job.bookingId);
    const other = await h.seedCaregiver();
    const otherScan = await h.scan(other.token, outToken);
    // (ค) ระบบปิดงานให้ (no-checkout sweeper) เมื่อเลย end + CHECKOUT_SWEEP_HOURS
    h.clock.set(at(END, 6 * 60 + 1));
    await h.app.get(NoCheckoutSweeperService).run();

    const booking = await h.prisma.booking.findUniqueOrThrow({
      where: { id: job.bookingId },
      select: { status: true, reviewReasons: true },
    });
    const proof = await h.app
      .get(MonitoringService)
      .proofOfWorkForSystem(job.bookingId);

    expect({
      bypassWithoutScan: bypass.errors?.[0]?.message,
      otherCaregiverScan: otherScan.r?.result,
      checkOutSource: proof.checkOut?.source,
      verdict: proof.verdict,
      bookingStatus: booking.status,
      reviewReasons: booking.reviewReasons,
    }).toEqual({
      bypassWithoutScan:
        'งานนี้ต้องสแกน QR ของผู้รับบริการก่อนจึงจะเริ่มหรือจบงานได้',
      otherCaregiverScan: 'WRONG_CAREGIVER',
      checkOutSource: 'system',
      verdict: 'needs_review',
      bookingStatus: 'needs_review',
      reviewReasons: ['no_checkout'],
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  Audit / authz / leak / config / business rule / lifecycle
  // ═══════════════════════════════════════════════════════════════════════

  it('PYG-440_19 — every scan attempt is logged with actor, booking, outcome and a distinguishable reason', async () => {
    const job = await h.seedJob();
    const c = job.caregiver!;
    const d = await h.seedCaregiver();

    h.clock.set(START);
    await h.scan(c.token, randomBytes(32).toString('base64url')); // TOKEN_NOT_FOUND
    await h.scan(d.token, job.token); // WRONG_CAREGIVER
    h.clock.set(at(job.validFrom, -5));
    await h.scan(c.token, job.token); // OUT_OF_WINDOW
    h.clock.set(START);
    await h.scan(c.token, job.token); // SUCCESS

    const rows = [...(await h.scanRowsBy(c.id)), ...(await h.scanRowsBy(d.id))];
    const summary = rows
      .map((r) => ({
        result: r.result,
        by: r.scannedBy === c.id ? 'C' : 'D',
        booking: r.bookingId === job.bookingId,
        reason: r.reason,
      }))
      .sort((a, b) => a.result.localeCompare(b.result));

    expect(
      summary.map(({ result, by, booking }) => ({ result, by, booking })),
    ).toEqual([
      { result: 'OUT_OF_WINDOW', by: 'C', booking: true },
      { result: 'SUCCESS', by: 'C', booking: true },
      { result: 'TOKEN_NOT_FOUND', by: 'C', booking: false },
      { result: 'WRONG_CAREGIVER', by: 'D', booking: true },
    ]);
    expect(new Set(summary.map((s) => s.reason)).size).toBe(4);
    expect(
      summary.every((s) => typeof s.reason === 'string' && s.reason.length > 0),
    ).toBe(true);
  });

  it('PYG-440_20 — a patient cannot scan to advance their own job (rejected and logged)', async () => {
    const job = await h.seedJob();
    h.clock.set(START);
    const before = await h.state(job.bookingId);

    const { body } = await h.scan(job.patient.token, job.token);
    const after = await h.state(job.bookingId);

    expect({
      code: codeOf(body),
      sessionStatus: after.sessionStatus,
      events: after.events,
      rejectionLogged: after.scanRows - before.scanRows,
    }).toEqual({
      code: 'FORBIDDEN',
      sessionStatus: 'PENDING',
      events: [],
      rejectionLogged: 1,
    });
  });

  it('PYG-440_21 — the scan response does not return raw storage paths (expected FAIL, evidence for PYG-470)', async () => {
    const job = await h.seedJob();
    const outToken = await checkedIn(job);
    h.clock.set(at(START, 120));
    const path = `${job.bookingId}/check-out-1.jpg`;

    const { body, r } = await h.scan(job.caregiver!.token, outToken, {
      photoUrl: path,
    });

    expect({
      result: r?.result ?? codeOf(body),
      photoUrl: r?.jobEvent?.photoUrl,
    }).toEqual({
      result: 'SUCCESS',
      photoUrl: expect.stringMatching(/^https:\/\/.+token=/),
    });
  });

  it('PYG-440_22 — QR window, single-use and min-interval settings come from configuration', async () => {
    // ค่าที่ใช้อยู่จริงในรอบรันนี้ (env ไม่ได้ตั้ง = ค่า default)
    expect({
      QR_VALID_FROM_OFFSET_MIN,
      QR_VALID_UNTIL_GRACE_MIN,
      QR_SINGLE_USE_PER_ACTION,
      QR_MIN_SECONDS_BETWEEN_ACTIONS,
      envSet: [
        'QR_VALID_FROM_OFFSET_MIN',
        'QR_VALID_UNTIL_GRACE_MIN',
        'QR_SINGLE_USE_PER_ACTION',
        'QR_MIN_SECONDS_BETWEEN_ACTIONS',
      ].filter((k) => process.env[k] !== undefined),
    }).toEqual({
      QR_VALID_FROM_OFFSET_MIN: 60,
      QR_VALID_UNTIL_GRACE_MIN: 120,
      QR_SINGLE_USE_PER_ACTION: true,
      QR_MIN_SECONDS_BETWEEN_ACTIONS: 60,
      envSet: [],
    });

    // เปลี่ยนค่า → พฤติกรรมตาม: โหลดโมดูลใหม่ในรีจิสทรีแยก แล้วให้ JobQrService ตัวจริงคำนวณช่วงเวลา
    const saved = { ...process.env };
    process.env.QR_VALID_FROM_OFFSET_MIN = '15';
    process.env.QR_VALID_UNTIL_GRACE_MIN = '5';
    process.env.QR_SINGLE_USE_PER_ACTION = 'false';
    let window: { validFrom: Date; validUntil: Date } | undefined;
    let singleUse: boolean | undefined;
    try {
      let svc:
        | { createForBooking: (tx: unknown, booking: unknown) => Promise<void> }
        | undefined;
      jest.isolateModules(() => {
        // โหลดใหม่ในรีจิสทรีแยก → ค่าคงที่ถูกอ่านจาก env ที่เพิ่งตั้ง
        /* eslint-disable @typescript-eslint/no-require-imports */
        const constants = require('../src/monitoring/qr/qr.constants') as {
          QR_SINGLE_USE_PER_ACTION: boolean;
        };
        const { JobQrService } =
          require('../src/monitoring/qr/job-qr.service') as {
            JobQrService: new (prisma: unknown, clock: unknown) => typeof svc;
          };
        /* eslint-enable @typescript-eslint/no-require-imports */
        singleUse = constants.QR_SINGLE_USE_PER_ACTION;
        svc = new JobQrService({}, { now: () => START });
      });
      const tx = {
        jobSession: {
          create: ({
            data,
          }: {
            data: { validFrom: Date; validUntil: Date };
          }) => {
            window = { validFrom: data.validFrom, validUntil: data.validUntil };
            return Promise.resolve({});
          },
        },
      };
      await svc!.createForBooking(tx, {
        id: '00000000-0000-4000-8000-000000000000',
        bookingDate: new Date('2026-10-01'),
        startTime: new Date('1970-01-01T10:00:00.000Z'),
        durationHours: 2,
      });
    } finally {
      process.env = saved;
    }

    expect({
      validFrom: window?.validFrom.toISOString(),
      validUntil: window?.validUntil.toISOString(),
      singleUse,
    }).toEqual({
      validFrom: at(START, -15).toISOString(),
      validUntil: at(END, 5).toISOString(),
      singleUse: false,
    });
  });

  it('PYG-440_23 — one QR serves the whole job and is not reissued per action', async () => {
    const job = await h.seedJob();
    const issued = job.token;
    h.clock.set(START);
    const checkIn = await h.scan(job.caregiver!.token, issued);
    h.clock.set(at(START, 120));
    const checkOutWithSameToken = await h.scan(job.caregiver!.token, issued);

    expect({
      checkIn: checkIn.r?.result,
      checkOutWithIssuedToken: checkOutWithSameToken.r?.result,
      sessionRows: await h.prisma.jobSession.count({
        where: { bookingId: job.bookingId },
      }),
    }).toEqual({
      checkIn: 'SUCCESS',
      checkOutWithIssuedToken: 'SUCCESS',
      sessionRows: 1,
    });
  });

  it('PYG-440_24 — a booking with no accepted caregiver has no usable QR (scan rejected)', async () => {
    const job = await h.seedJob({
      caregiver: null,
      status: 'pending',
      paymentStatus: null,
    });
    const c = await h.seedCaregiver();
    h.clock.set(START);
    const before = await h.state(job.bookingId);

    const { r } = await h.scan(c.token, job.token);

    await expectRejected(job.bookingId, before, r, 'WRONG_CAREGIVER');
    const qr = await h.gql(
      job.patient.token,
      `query($b: ID!) { jobQr(bookingId: $b) { isActive } }`,
      { b: job.bookingId },
    );
    // บันทึกไว้เป็นหลักฐาน: ผู้รับบริการยังดึง QR ของงานที่ยังไม่มีผู้ดูแลได้ และ isActive ตามช่วงเวลา
    expect(qr.errors).toBeUndefined();
  });
});
