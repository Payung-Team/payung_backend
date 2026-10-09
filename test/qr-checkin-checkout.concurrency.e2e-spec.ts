/**
 * E2E concurrency — PYG-440_15 · สแกนพร้อมกันสองครั้งต้องขยับงานได้ครั้งเดียว
 *
 * (ก) ผ่าน API จริง: ยิง scanJobQr คู่ขนาน 10 รอบสำหรับเช็คอิน และ 10 รอบสำหรับเช็คเอาท์
 * (ข) ระดับ SQL: สอง connection จริงพิสูจน์ว่า
 *     - compare-and-swap บน job_sessions (UPDATE ... WHERE status = <เดิม>) ให้ผู้ชนะคนเดียว
 *     - UNIQUE (booking_id, event_type) บน job_events กันแถวเช็คอินซ้ำ แม้ service จะพลาด
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import {
  at,
  bootstrap,
  DB_URL,
  describeDb,
  Harness,
  START,
} from './support/qr-e2e';

jest.setTimeout(180_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeDb('PYG-440_15 · QR scan concurrency (e2e, real DB)', () => {
  let h: Harness;
  let pool: Pool;

  beforeAll(async () => {
    h = await bootstrap();
    pool = new Pool({ connectionString: DB_URL, max: 4 });
  });

  afterAll(async () => {
    await pool?.end();
    await h?.close();
  });

  it('PYG-440_15 — two simultaneous scans advance the job exactly once (check-in and check-out)', async () => {
    const rounds = 10;
    // ผลของคำขอ: รหัสจาก scanJobQr ถ้ามี ไม่งั้นเป็นรหัส error ของ GraphQL (เช่น INTERNAL_SERVER_ERROR)
    const outcome = (x: Awaited<ReturnType<Harness['scan']>>) =>
      x.r?.result ?? `ERR:${String(x.body.errors?.[0]?.extensions?.code)}`;
    const perRound: {
      checkIn: string[];
      checkOut: string[];
      checkInEvents: number;
      checkOutEvents: number;
      sessionStatus: string | undefined;
      scanRowsLogged: number;
    }[] = [];

    for (let i = 0; i < rounds; i++) {
      const job = await h.seedJob();
      const c = job.caregiver!;

      // ── เช็คอินพร้อมกัน ──
      h.clock.set(START);
      const ins = await Promise.all([
        h.scan(c.token, job.token),
        h.scan(c.token, job.token),
      ]);

      // ── เช็คเอาท์พร้อมกัน ──
      h.clock.set(at(START, 120));
      const outToken = await h.currentToken(job.patient.token, job.bookingId);
      const outs = await Promise.all([
        h.scan(c.token, outToken),
        h.scan(c.token, outToken),
      ]);

      perRound.push({
        checkIn: ins.map(outcome).sort(),
        checkOut: outs.map(outcome).sort(),
        checkInEvents: await h.prisma.jobEvent.count({
          where: { bookingId: job.bookingId, eventType: 'check_in' },
        }),
        checkOutEvents: await h.prisma.jobEvent.count({
          where: { bookingId: job.bookingId, eventType: 'check_out' },
        }),
        sessionStatus: (await h.state(job.bookingId)).sessionStatus,
        // นับตามคนสแกน ไม่ใช่ booking_id (แถว TOKEN_NOT_FOUND มี booking_id เป็น null โดยตั้งใจ)
        scanRowsLogged: await h.prisma.jobScanEvent.count({
          where: { scannedBy: c.id },
        }),
      });
    }

    // ★ invariant ด้านเงิน: ไม่ว่ารอบไหน ต้องมีแถวเช็คอิน 1 และเช็คเอาท์ 1 เท่านั้น
    expect(
      perRound.map((r) => [r.checkInEvents, r.checkOutEvents, r.sessionStatus]),
    ).toEqual(Array(rounds).fill([1, 1, 'CHECKED_OUT']));

    // ต่อรอบ: SUCCESS เดียว อีกตัวต้องเป็นผลที่ "ไม่ขยับงาน" และถูกบันทึก (4 แถวต่อรอบ)
    const nonAdvancing = ['DUPLICATE', 'TOKEN_NOT_FOUND', 'ALREADY_COMPLETED'];
    const violations = perRound
      .map((r, i) => ({ round: i + 1, ...r }))
      .filter(
        (r) =>
          r.checkIn.filter((x) => x === 'SUCCESS').length !== 1 ||
          r.checkOut.filter((x) => x === 'SUCCESS').length !== 1 ||
          !nonAdvancing.includes(
            r.checkIn.find((x) => x !== 'SUCCESS') ?? '',
          ) ||
          !nonAdvancing.includes(
            r.checkOut.find((x) => x !== 'SUCCESS') ?? '',
          ) ||
          r.scanRowsLogged !== 4,
      );
    expect(violations).toEqual([]);

    // ── (ข) ระดับ SQL ──
    const service = readFileSync(
      join(__dirname, '../src/monitoring/qr/job-scan.service.ts'),
      'utf8',
    );
    expect(service).toContain('this.prisma.jobSession.updateMany');
    expect(service).toMatch(
      /status:\s*\n?\s*action === ScanAction\.CHECK_IN\s*\?\s*JOB_SESSION_STATUS\.PENDING/,
    );

    const job = await h.seedJob();
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      // CAS บน job_sessions
      await c1.query('BEGIN');
      await c2.query('BEGIN');
      const cas = `UPDATE job_sessions SET status = 'CHECKED_IN' WHERE id = $1 AND status = 'PENDING'`;
      const first = await c1.query(cas, [job.sessionId]);
      let secondDone = false;
      const secondP = c2.query(cas, [job.sessionId]).then((r) => {
        secondDone = true;
        return r;
      });
      await sleep(500);
      expect(secondDone).toBe(false); // ถูก row lock กักไว้
      await c1.query('COMMIT');
      const second = await secondP;
      await c2.query('COMMIT');
      expect([first.rowCount, second.rowCount]).toEqual([1, 0]);

      // UNIQUE (booking_id, event_type) บน job_events
      const insert = `INSERT INTO job_events (id, booking_id, caregiver_id, event_type, source, server_ts)
                      VALUES ($1, $2, $3, 'check_in', 'caregiver', now())`;
      await c1.query(insert, [
        randomUUID(),
        job.bookingId,
        job.caregiver!.caregiverId,
      ]);
      await expect(
        c2.query(insert, [
          randomUUID(),
          job.bookingId,
          job.caregiver!.caregiverId,
        ]),
      ).rejects.toThrow(/job_events_booking_id_event_type_key|duplicate key/);
    } finally {
      c1.release();
      c2.release();
    }
  });
});
