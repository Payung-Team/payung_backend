/**
 * E2E concurrency — PYG-420_16 · สองคนกดเข้าร่วมพร้อมกันตอนเหลือที่ว่าง 1 ที่
 *
 * mock พิสูจน์เรื่องนี้ไม่ได้ ต้องใช้ Postgres จริงสองธุรกรรมพร้อมกัน:
 *   (ก) ผ่าน API จริง — ยิง joinGroupByLink คู่ขนานหลายรอบ แล้วดู invariant ของทุกรอบ
 *   (ข) ระดับ SQL — สอง connection รัน conditional UPDATE เดียวกับที่ service ใช้
 *       พิสูจน์ว่าตัวที่สองถูก row lock กักไว้ แล้วได้ 0 แถวหลังตัวแรก commit
 *       = การบังคับโควตาอยู่ที่ SQL ไม่ใช่ที่ชั้น service
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { Pool } from 'pg';
import {
  bootstrap,
  codeOf,
  DB_URL,
  describeDb,
  Harness,
  OPS,
} from './support/join-link-e2e';

jest.setTimeout(120_000);

/** predicate เดียวกับ FamilyGroupService.joinGroupByLink (ตรวจด้านล่างว่าโค้ดยังใช้ข้อความนี้จริง) */
const CLAIM_PREDICATE = 'AND (max_uses IS NULL OR used_count < max_uses)';
const CLAIM_SQL = `UPDATE family_group_join_links
    SET used_count = used_count + 1
  WHERE token_hash = $1
    AND status = 'ACTIVE'
    AND expires_at > now()
    ${CLAIM_PREDICATE}
  RETURNING id`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeDb('PYG-420_16 · join link concurrency (e2e, real DB)', () => {
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

  it('PYG-420_16 — two users joining simultaneously on the last slot cannot exceed max_uses', async () => {
    // ── (ก) ผ่าน API จริง, 10 รอบ ────────────────────────────────────────
    const rounds = 10;
    const outcomes: string[][] = [];
    for (let round = 0; round < rounds; round++) {
      const { groupId, owner } = await h.seedGroup();
      const link = await h.createLink(owner.token, groupId, { maxUses: 2 });
      const early = await h.seedUser(`r${round}-early`);
      expect(
        (await h.gql(early.token, OPS.JOIN, { token: link.token })).errors,
      ).toBeUndefined();
      expect((await h.linkRow(link.id))!.usedCount).toBe(1); // เหลือ 1 ที่

      const u1 = await h.seedUser(`r${round}-u1`);
      const u2 = await h.seedUser(`r${round}-u2`);
      const [a, b] = await Promise.all([
        h.gql(u1.token, OPS.JOIN, { token: link.token }),
        h.gql(u2.token, OPS.JOIN, { token: link.token }),
      ]);

      const codes = [a, b]
        .map((r) => (r.errors ? (codeOf(r) as string) : 'OK'))
        .sort();
      outcomes.push(codes);
      const row = await h.linkRow(link.id);
      expect(row!.usedCount).toBe(2);
      expect(row!.usedCount).toBeLessThanOrEqual(row!.maxUses!);
      expect(await h.activeCount(groupId)).toBe(3); // owner + early + ผู้ชนะคนเดียว
    }
    for (const codes of outcomes) {
      expect(codes).toEqual(['JOIN_LINK_EXHAUSTED', 'OK']);
    }

    // ── (ข) ระดับ SQL: conditional UPDATE ของ service กันได้จริงภายใต้ธุรกรรมซ้อน ──
    const service = readFileSync(
      join(__dirname, '../src/family-group/family-group.service.ts'),
      'utf8',
    );
    expect(service.replace(/\s+/g, ' ')).toContain(CLAIM_PREDICATE);

    const { groupId, owner } = await h.seedGroup();
    const link = await h.createLink(owner.token, groupId, { maxUses: 2 });
    await h.prisma.familyGroupJoinLink.update({
      where: { id: link.id },
      data: { usedCount: 1 },
    });
    const hash = createHash('sha256').update(link.token).digest('hex');

    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      await c1.query('BEGIN');
      await c2.query('BEGIN');
      const first = await c1.query(CLAIM_SQL, [hash]);
      expect(first.rowCount).toBe(1);

      let secondDone = false;
      const secondP = c2.query(CLAIM_SQL, [hash]).then((r) => {
        secondDone = true;
        return r;
      });
      await sleep(500);
      expect(secondDone).toBe(false); // ถูก row lock กักไว้จนกว่า c1 จะ commit

      await c1.query('COMMIT');
      const second = await secondP;
      expect(second.rowCount).toBe(0); // ประเมิน WHERE ใหม่หลังได้ lock → โควตาหมดแล้ว
      await c2.query('COMMIT');
    } finally {
      c1.release();
      c2.release();
    }
    expect(await h.linkRow(link.id)).toMatchObject({
      usedCount: 2,
      maxUses: 2,
    });
  });
});
