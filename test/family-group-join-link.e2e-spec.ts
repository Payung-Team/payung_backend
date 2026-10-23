/**
 * E2E (GraphQL) — PYG-420 / TC-BS-02,04,05 · Join link, expiry & token security
 * Spec ที่ใช้: FG-2 v1.1 = คอมเมนต์ PYG-408 (AC B1–B8, SCR-FG2-001, Amendment 1 → B9–B10)
 *   ★ description ของ PYG-408 เป็น flow อีเมล v1.0 ที่ถูกลบไปแล้ว — ห้ามอ้าง
 *
 * guard chain จริง + Prisma จริงกับ Postgres ทิ้งได้ (ดู test/support/join-link-e2e.ts)
 * TC_16 (concurrency) อยู่แยกที่ family-group-join-link.concurrency.e2e-spec.ts
 * วิธีรัน: docs/qa/pyg-420-join-link-report.md หัวข้อ "How to run"
 */
import { createHash, randomUUID } from 'crypto';
import {
  GROUP_MAX_MEMBERS,
  JOIN_LINK_TTL_HOURS,
} from '../src/family-group/family-group.constants';
import {
  bootstrap,
  codeOf,
  describeDb,
  Harness,
  OPS,
  tokenFromUrl,
} from './support/join-link-e2e';

jest.setTimeout(60_000);

const ACTIVITY = `query($groupId: ID!) {
  familyGroupActivity(groupId: $groupId) { nodes { action createdAt targetId actor { userId } } }
}`;

describeDb(
  'PYG-420 · join link, expiry & token security (e2e, real DB)',
  () => {
    let h: Harness;

    beforeAll(async () => {
      h = await bootstrap();
    });

    afterAll(async () => {
      await h?.close();
    });

    const activeLinks = (groupId: string) =>
      h.prisma.familyGroupJoinLink.count({
        where: { groupId, status: 'ACTIVE' },
      });

    // ═══════════════════════════════════════════════════════════════════════
    //  ชีตเดิม (_01–_15) · _11 เขียนใหม่ตาม Amendment 1
    // ═══════════════════════════════════════════════════════════════════════

    it('PYG-420_01 — owner creates a join link (ACTIVE row, 7-day expiry, 32-byte random token)', async () => {
      const { groupId, owner } = await seedGroupWithOwner();
      const before = Date.now();

      const body = await h.gql(owner.token, OPS.CREATE_LINK, { groupId });
      expect(body.errors).toBeUndefined();
      const link = body.data!.createJoinLink;
      const token = tokenFromUrl(link.url as string);

      expect(link.isUsable).toBe(true);
      expect(await activeLinks(groupId)).toBe(1);

      // token: 32 ไบต์สุ่ม encode เป็น base64url (43 ตัว) · DB เก็บ sha256 ที่ตรงกัน
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
      const row = await h.prisma.familyGroupJoinLink.findUnique({
        where: { id: link.id as string },
        select: {
          tokenHash: true,
          expiresAt: true,
          createdBy: true,
          status: true,
        },
      });
      expect(row!.status).toBe('ACTIVE');
      expect(row!.createdBy).toBe(owner.id);
      expect(row!.tokenHash).toBe(
        createHash('sha256').update(token).digest('hex'),
      );

      // expires_at ≈ now + 7 วัน (เผื่อ 2 นาที)
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      expect(
        Math.abs(row!.expiresAt.getTime() - (before + sevenDays)),
      ).toBeLessThan(2 * 60 * 1000);

      // สุ่มจริง: อีกกลุ่มได้ token คนละค่า
      const other = await seedGroupWithOwner();
      const otherLink = await h.createLink(other.owner.token, other.groupId);
      expect(otherLink.token).not.toBe(token);
    });

    it.skip('PYG-420_02 — BLOCKED (decision ก. token storage, PYG-455) — owner copies the same link repeatedly', () => {
      // ไม่ assert: ถ้าเก็บแค่ sha256 เคสนี้ต้อง FAIL by design · ถ้าเก็บ token_raw เคสนี้ผ่าน
      // รอ SCR-FG2-001 §7 ข้อ 1 ตัดสิน
    });

    it('PYG-420_03 — invited user previews (group name + creator) and joins as MEMBER', async () => {
      const { groupId, owner } = await seedGroupWithOwner();
      const link = await h.createLink(owner.token, groupId);
      const u = await h.seedUser('joiner');

      const preview = await h.gql(u.token, OPS.PREVIEW, { token: link.token });
      expect(preview.errors).toBeUndefined();
      expect(preview.data!.joinLinkPreview).toMatchObject({
        groupName: 'บ้าน PYG-420',
        ownerName: owner.displayName,
        isUsable: true,
        alreadyMember: false,
      });

      const join = await h.gql(u.token, OPS.JOIN, { token: link.token });
      expect(join.errors).toBeUndefined();
      expect(join.data!.joinGroupByLink.id).toBe(groupId);

      expect(await h.memberRow(groupId, u.id)).toEqual({
        role: 'MEMBER',
        status: 'ACTIVE',
        joinedViaLinkId: link.id,
      });
      const row = await h.linkRow(link.id);
      expect(row!.usedCount).toBe(1);
      expect(row!.status).toBe('ACTIVE');
      const ownerView = await h.gql(owner.token, OPS.GROUP, { groupId });
      expect(ownerView.data!.familyGroup.memberCount).toBe(2);
    });

    it('PYG-420_04 — unauthenticated caller is rejected without side effects (API half; resume-after-login NOT COVERED (FE))', async () => {
      const { groupId, owner } = await seedGroupWithOwner();
      const link = await h.createLink(owner.token, groupId);

      const preview = await h.gql(null, OPS.PREVIEW, { token: link.token });
      const join = await h.gql(null, OPS.JOIN, { token: link.token });

      expect(codeOf(preview)).toBe('UNAUTHENTICATED');
      expect(codeOf(join)).toBe('UNAUTHENTICATED');
      expect((await h.linkRow(link.id))!.usedCount).toBe(0);
      expect(await h.activeCount(groupId)).toBe(1);
    });

    it('PYG-420_05 — existing member re-using the link is a no-op and does not consume used_count', async () => {
      const { groupId, owner, members } = await seedGroupWithOwner(1);
      const link = await h.createLink(owner.token, groupId);
      const m = members[0];

      const preview = await h.gql(m.token, OPS.PREVIEW, { token: link.token });
      expect(preview.data!.joinLinkPreview.alreadyMember).toBe(true);

      const join = await h.gql(m.token, OPS.JOIN, { token: link.token });
      expect(join.errors).toBeUndefined();
      expect(join.data!.joinGroupByLink.id).toBe(groupId);

      expect(await h.activeCount(groupId)).toBe(2);
      expect((await h.linkRow(link.id))!.usedCount).toBe(0);
    });

    it('PYG-420_06 — expired link is rejected with JOIN_LINK_EXPIRED', async () => {
      const { groupId, owner } = await seedGroupWithOwner();
      const link = await h.createLink(owner.token, groupId);
      await h.prisma.familyGroupJoinLink.update({
        where: { id: link.id },
        data: { expiresAt: new Date(Date.now() - 60 * 60 * 1000) },
      });
      const u = await h.seedUser('joiner');

      const preview = await h.gql(u.token, OPS.PREVIEW, { token: link.token });
      expect(preview.data!.joinLinkPreview).toMatchObject({
        isUsable: false,
        unusableReason: 'EXPIRED',
      });

      const join = await h.gql(u.token, OPS.JOIN, { token: link.token });
      expect(join.data).toBeNull();
      expect(await h.memberRow(groupId, u.id)).toBeNull();
      expect(await h.activeCount(groupId)).toBe(1);
      expect((await h.linkRow(link.id))!.usedCount).toBe(0);
      expect(codeOf(join)).toBe('JOIN_LINK_EXPIRED');
    });

    it('PYG-420_07 — revoked link is rejected with JOIN_LINK_REVOKED', async () => {
      const { groupId, owner } = await seedGroupWithOwner();
      const link = await h.createLink(owner.token, groupId);
      const u = await h.seedUser('joiner');

      const revoke = await h.gql(owner.token, OPS.REVOKE_LINK, { groupId });
      expect(revoke.errors).toBeUndefined();
      expect(revoke.data!.revokeJoinLink).toBe(true);

      const row = await h.linkRow(link.id);
      expect(row!.status).toBe('REVOKED');
      expect(row!.revokedAt).not.toBeNull();
      // "no longer shown on the group page"
      expect(
        codeOf(await h.gql(owner.token, OPS.GROUP_LINK, { groupId })),
      ).toBe('JOIN_LINK_NOT_FOUND');

      const join = await h.gql(u.token, OPS.JOIN, { token: link.token });
      expect(join.data).toBeNull();
      expect(await h.memberRow(groupId, u.id)).toBeNull();
      expect((await h.linkRow(link.id))!.usedCount).toBe(0);
      expect(codeOf(join)).toBe('JOIN_LINK_REVOKED');
    });

    it('PYG-420_08 — rotate kills the old token, new one works, JOIN_LINK_ROTATED activity written', async () => {
      const { groupId, owner } = await seedGroupWithOwner();
      const oldLink = await h.createLink(owner.token, groupId);
      const u = await h.seedUser('joiner');

      const rotate = await h.gql(owner.token, OPS.ROTATE_LINK, { groupId });
      expect(rotate.errors).toBeUndefined();
      const newLink = rotate.data!.rotateJoinLink as {
        id: string;
        url: string;
      };
      const newToken = tokenFromUrl(newLink.url);
      expect(newToken).not.toBe(oldLink.token);

      expect((await h.linkRow(oldLink.id))!.status).toBe('REVOKED');
      expect((await h.linkRow(newLink.id))!.status).toBe('ACTIVE');
      expect(await activeLinks(groupId)).toBe(1);

      const activity = await h.prisma.familyGroupActivity.findMany({
        where: { groupId, action: 'JOIN_LINK_ROTATED' },
        select: { actorId: true, targetId: true, metadata: true },
      });
      expect(activity).toHaveLength(1);
      expect(activity[0]).toMatchObject({
        actorId: owner.id,
        targetId: newLink.id,
      });
      expect(activity[0].metadata).toMatchObject({
        replacedLinkId: oldLink.id,
      });

      const viaOld = await h.gql(u.token, OPS.JOIN, { token: oldLink.token });
      expect(await h.memberRow(groupId, u.id)).toBeNull();
      expect(codeOf(viaOld)).toBe('JOIN_LINK_REVOKED');

      const viaNew = await h.gql(u.token, OPS.JOIN, { token: newToken });
      expect(viaNew.errors).toBeUndefined();
      expect(await h.activeCount(groupId)).toBe(2);
    });

    it('PYG-420_09 — joining is blocked once used_count reaches max_uses (JOIN_LINK_EXHAUSTED + DB CHECK)', async () => {
      const { groupId, owner } = await seedGroupWithOwner();
      const link = await h.createLink(owner.token, groupId, { maxUses: 2 });

      for (const tag of ['first', 'second']) {
        const u = await h.seedUser(tag);
        expect(
          (await h.gql(u.token, OPS.JOIN, { token: link.token })).errors,
        ).toBeUndefined();
      }
      expect(await h.linkRow(link.id)).toMatchObject({
        usedCount: 2,
        maxUses: 2,
      });

      const third = await h.seedUser('third');
      const denied = await h.gql(third.token, OPS.JOIN, { token: link.token });
      expect(denied.data).toBeNull();
      expect(await h.memberRow(groupId, third.id)).toBeNull();
      expect((await h.linkRow(link.id))!.usedCount).toBe(2);

      // ชั้นฐานข้อมูล: CHECK ต้องปฏิเสธการดัน used_count เกิน max_uses ต่อให้เลี่ยง service
      await expect(
        h.prisma.$executeRawUnsafe(
          `UPDATE family_group_join_links SET used_count = 3 WHERE id = '${link.id}'::uuid`,
        ),
      ).rejects.toThrow(/used_count_check|check constraint/i);
      expect((await h.linkRow(link.id))!.usedCount).toBe(2);

      expect(codeOf(denied)).toBe('JOIN_LINK_EXHAUSTED');
    });

    it('PYG-420_10 — a group holds only one ACTIVE link (service returns existing; partial unique index enforces)', async () => {
      const { groupId, owner } = await seedGroupWithOwner();
      const first = await h.gql(owner.token, OPS.CREATE_LINK, { groupId });
      const second = await h.gql(owner.token, OPS.CREATE_LINK, {
        groupId,
        maxUses: 3,
      });

      expect(first.errors).toBeUndefined();
      expect(second.errors).toBeUndefined();
      expect(second.data!.createJoinLink.id).toBe(
        first.data!.createJoinLink.id,
      );
      expect(second.data!.createJoinLink.url).toBe(
        first.data!.createJoinLink.url,
      );
      expect(await activeLinks(groupId)).toBe(1);

      // ชั้นฐานข้อมูล: INSERT แถว ACTIVE ใบที่สองตรง ๆ ต้องชน partial unique index
      const token = randomUUID();
      await expect(
        h.prisma.familyGroupJoinLink.create({
          data: {
            groupId,
            tokenHash: createHash('sha256').update(token).digest('hex'),
            status: 'ACTIVE',
            expiresAt: new Date(Date.now() + 3600_000),
          },
        }),
      ).rejects.toThrow(/unique/i);
      expect(await activeLinks(groupId)).toBe(1);
    });

    it('PYG-420_11 — member cannot create, rotate or revoke the link (NOT_GROUP_OWNER); link unchanged · UI half NOT COVERED (FE)', async () => {
      const { groupId, owner, members } = await seedGroupWithOwner(1);
      const link = await h.createLink(owner.token, groupId);
      const m = members[0];
      const rowBefore = await h.linkRow(link.id);
      const linksBefore = await h.prisma.familyGroupJoinLink.count({
        where: { groupId },
      });
      const activityBefore = await h.prisma.familyGroupActivity.count({
        where: { groupId },
      });

      const create = await h.gql(m.token, OPS.CREATE_LINK, { groupId });
      const rotate = await h.gql(m.token, OPS.ROTATE_LINK, { groupId });
      const revoke = await h.gql(m.token, OPS.REVOKE_LINK, { groupId });

      expect(await h.linkRow(link.id)).toEqual(rowBefore);
      expect(
        await h.prisma.familyGroupJoinLink.count({ where: { groupId } }),
      ).toBe(linksBefore);
      expect(
        await h.prisma.familyGroupActivity.count({ where: { groupId } }),
      ).toBe(activityBefore);

      expect([codeOf(create), codeOf(rotate), codeOf(revoke)]).toEqual([
        'NOT_GROUP_OWNER',
        'NOT_GROUP_OWNER',
        'NOT_GROUP_OWNER',
      ]);
    });

    it('PYG-420_12 — malformed or guessed tokens are rejected with JOIN_LINK_INVALID', async () => {
      const { groupId, owner } = await seedGroupWithOwner();
      const link = await h.createLink(owner.token, groupId);
      const u = await h.seedUser('guesser');
      const lastChar = link.token.slice(-1) === 'A' ? 'B' : 'A';
      const variants = [
        'aaaaaaaa',
        '12345678',
        '',
        'A'.repeat(4096),
        link.token.slice(0, -1) + lastChar, // ถูกแก้ 1 ตัวอักษร
      ];

      const results: { join: string; preview: string; message: string }[] = [];
      for (const token of variants) {
        const join = await h.gql(u.token, OPS.JOIN, { token });
        const preview = await h.gql(u.token, OPS.PREVIEW, { token });
        expect(join.data).toBeNull();
        expect(JSON.stringify(join)).not.toContain('บ้าน PYG-420');
        expect(JSON.stringify(preview)).not.toContain('บ้าน PYG-420');
        results.push({
          join: codeOf(join) as string,
          preview: codeOf(preview) as string,
          message: join.errors?.[0]?.message ?? '',
        });
      }

      expect(await h.activeCount(groupId)).toBe(1);
      expect((await h.linkRow(link.id))!.usedCount).toBe(0);
      // ข้อความเดียวกันทุกกรณี — ไม่บอกใบ้ว่าใกล้เคียงแค่ไหน
      expect(new Set(results.map((r) => r.message)).size).toBe(1);
      for (const r of results) {
        expect(r).toMatchObject({
          join: 'JOIN_LINK_INVALID',
          preview: 'JOIN_LINK_INVALID',
        });
      }
    });

    it('PYG-420_13 — a token from group A cannot be used to join group B', async () => {
      const a = await seedGroupWithOwner();
      const b = await seedGroupWithOwner();
      const linkA = await h.createLink(a.owner.token, a.groupId);
      await h.createLink(b.owner.token, b.groupId);
      const u = await h.seedUser('outsider');

      // 1) ยัด groupId ของ B ไปพร้อม token ของ A → schema ไม่มี argument นี้ ต้องถูกปฏิเสธ
      const spoof = await h.gql(
        u.token,
        `mutation($token: String!, $groupId: ID!) { joinGroupByLink(token: $token, groupId: $groupId) { id } }`,
        { token: linkA.token, groupId: b.groupId },
      );
      expect(spoof.errors).toBeDefined();
      expect(codeOf(spoof)).toBe('GRAPHQL_VALIDATION_FAILED');
      expect(await h.memberRow(a.groupId, u.id)).toBeNull();
      expect(await h.memberRow(b.groupId, u.id)).toBeNull();
      expect(await h.activeCount(a.groupId)).toBe(1);
      expect(await h.activeCount(b.groupId)).toBe(1);

      // 2) ใช้ token ของ A ตามปกติ → เข้าได้เฉพาะ A, B ไม่เปลี่ยน
      const join = await h.gql(u.token, OPS.JOIN, { token: linkA.token });
      expect(join.data!.joinGroupByLink.id).toBe(a.groupId);
      expect(await h.memberRow(b.groupId, u.id)).toBeNull();
      expect(await h.activeCount(b.groupId)).toBe(1);
    });

    it.skip('PYG-420_14 — BLOCKED (decision ก. token storage, PYG-455) — token not exposed / token_raw readable by ACTIVE members only', () => {
      // ไม่ assert: ความหมายของเคสนี้กลับด้านตามข้อตัดสินใจ ก.
      // (เก็บแค่ sha256 → "raw token never persisted" · เก็บ token_raw → "อ่านได้เฉพาะสมาชิก ACTIVE" ตาม Amendment 1)
    });

    it('PYG-420_15 — joining via the link is recorded in the activity feed (one row)', async () => {
      const { groupId, owner } = await seedGroupWithOwner();
      const link = await h.createLink(owner.token, groupId);
      const u = await h.seedUser('joiner');
      const before = await h.prisma.familyGroupActivity.count({
        where: { groupId },
      });

      expect(
        (await h.gql(u.token, OPS.JOIN, { token: link.token })).errors,
      ).toBeUndefined();

      expect(
        await h.prisma.familyGroupActivity.count({ where: { groupId } }),
      ).toBe(before + 1);
      const feed = await h.gql(owner.token, ACTIVITY, { groupId });
      expect(feed.errors).toBeUndefined();
      const latest = feed.data!.familyGroupActivity.nodes[0];
      expect(latest).toMatchObject({
        action: 'MEMBER_JOINED',
        actor: { userId: u.id },
      });
      expect(Number.isNaN(Date.parse(latest.createdAt as string))).toBe(false);
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  เคสใหม่ปิดช่องว่าง B1–B10 (TC_16 อยู่ในไฟล์ concurrency)
    // ═══════════════════════════════════════════════════════════════════════

    it(`PYG-420_17 — full group (${GROUP_MAX_MEMBERS}) blocks joining even with link quota left (GROUP_MEMBER_LIMIT_REACHED)`, async () => {
      const { groupId, owner } = await seedGroupWithOwner(
        GROUP_MAX_MEMBERS - 1,
      );
      const link = await h.createLink(owner.token, groupId, {
        maxUses: GROUP_MAX_MEMBERS,
      });
      expect(await h.activeCount(groupId)).toBe(GROUP_MAX_MEMBERS);
      const u = await h.seedUser('over-cap');

      const join = await h.gql(u.token, OPS.JOIN, { token: link.token });
      expect(join.data).toBeNull();
      expect(await h.activeCount(groupId)).toBe(GROUP_MAX_MEMBERS);
      expect((await h.linkRow(link.id))!.usedCount).toBe(0);
      expect(await h.memberRow(groupId, u.id)).toBeNull();
      expect(codeOf(join)).toBe('GROUP_MEMBER_LIMIT_REACHED');
    });

    it('PYG-420_18 — ACTIVE member can view and copy the active link (B9)', async () => {
      const { groupId, owner, members } = await seedGroupWithOwner(1);
      await h.createLink(owner.token, groupId);

      const ownerView = await h.gql(owner.token, OPS.GROUP_LINK, { groupId });
      const memberView = await h.gql(members[0].token, OPS.GROUP_LINK, {
        groupId,
      });

      expect(ownerView.errors).toBeUndefined();
      expect(memberView.errors).toBeUndefined();
      expect(memberView.data?.groupJoinLink?.url).toBe(
        ownerView.data!.groupJoinLink.url,
      );
    });

    it('PYG-420_19 — non-member cannot read the join link and cannot tell whether one exists', async () => {
      const withLink = await seedGroupWithOwner();
      const link = await h.createLink(withLink.owner.token, withLink.groupId);
      const withoutLink = await seedGroupWithOwner();
      const u = await h.seedUser('outsider');

      const a = await h.gql(u.token, OPS.GROUP_LINK, {
        groupId: withLink.groupId,
      });
      const b = await h.gql(u.token, OPS.GROUP_LINK, {
        groupId: withoutLink.groupId,
      });

      expect(a.data).toBeNull();
      expect(JSON.stringify(a)).not.toContain(link.token);
      expect(codeOf(a)).toBe('NOT_A_MEMBER');
      expect(codeOf(b)).toBe(codeOf(a));
      expect(b.errors![0].message).toBe(a.errors![0].message);
    });

    it('PYG-420_20 — member sees JOIN_LINK_NOT_FOUND when the group has no active link; read creates nothing (B10) · UI half NOT COVERED (FE)', async () => {
      const { groupId, members } = await seedGroupWithOwner(1);

      const body = await h.gql(members[0].token, OPS.GROUP_LINK, { groupId });
      expect(body.data).toBeNull();
      expect(
        await h.prisma.familyGroupJoinLink.count({ where: { groupId } }),
      ).toBe(0);
      expect(codeOf(body)).toBe('JOIN_LINK_NOT_FOUND');
    });

    it('PYG-420_21 — revoke while a joiner sits on the preview fails gracefully (JOIN_LINK_REVOKED, no 500)', async () => {
      const { groupId, owner } = await seedGroupWithOwner();
      const link = await h.createLink(owner.token, groupId);
      const u = await h.seedUser('joiner');

      const preview = await h.gql(u.token, OPS.PREVIEW, { token: link.token });
      expect(preview.data!.joinLinkPreview.isUsable).toBe(true);

      expect(
        (await h.gql(owner.token, OPS.REVOKE_LINK, { groupId })).errors,
      ).toBeUndefined();

      const res = await h.gqlRaw(u.token, OPS.JOIN, { token: link.token });
      expect(res.status).toBe(200);
      const body = res.body as {
        data: unknown;
        errors: { message: string; extensions: { code: string } }[];
      };
      expect(body.data).toBeNull();
      expect(body.errors[0].extensions.code).not.toBe('INTERNAL_SERVER_ERROR');
      expect(body.errors[0].message.length).toBeGreaterThan(0);
      expect(body.errors[0].message).not.toMatch(
        /prisma|sql|constraint|internal server error/i,
      );
      expect(await h.memberRow(groupId, u.id)).toBeNull();
      expect(body.errors[0].extensions.code).toBe('JOIN_LINK_REVOKED');
    });

    it('PYG-420_22 — membership records the link it was joined through (joined_via_link_id)', async () => {
      const { groupId, owner } = await seedGroupWithOwner();
      const l1 = await h.createLink(owner.token, groupId);
      const u1 = await h.seedUser('u1');
      expect(
        (await h.gql(u1.token, OPS.JOIN, { token: l1.token })).errors,
      ).toBeUndefined();

      const rotate = await h.gql(owner.token, OPS.ROTATE_LINK, { groupId });
      const l2 = rotate.data!.rotateJoinLink as { id: string; url: string };
      const u2 = await h.seedUser('u2');
      expect(
        (await h.gql(u2.token, OPS.JOIN, { token: tokenFromUrl(l2.url) }))
          .errors,
      ).toBeUndefined();

      expect((await h.memberRow(groupId, u1.id))!.joinedViaLinkId).toBe(l1.id);
      expect((await h.memberRow(groupId, u2.id))!.joinedViaLinkId).toBe(l2.id);
      expect(l1.id).not.toBe(l2.id);
    });

    it('PYG-420_23 — repeated join attempts are rate limited', async () => {
      const u = await h.seedUser('hammer');
      const attempts = 30;

      // ยิงต่อเนื่องเร็วที่สุดทีละคำขอ — ไม่ยิงคู่ขนาน เพราะ supertest เปิด server ชั่วคราวต่อคำขอ
      // แล้ว connection รีเซ็ตเอง (ECONNRESET) ซึ่งจะกลายเป็นหลักฐานปลอม
      const outcomes: string[] = [];
      for (let i = 0; i < attempts; i++) {
        const res = await h.gqlRaw(u.token, OPS.JOIN, {
          token: `guess-${randomUUID()}`,
        });
        const code = (
          res.body as { errors?: { extensions?: { code?: string } }[] }
        ).errors?.[0]?.extensions?.code;
        outcomes.push(`${res.status}:${code ?? 'OK'}`);
      }

      // ทุกคำขอต้องได้คำตอบ GraphQL จริง (ไม่ใช่ network error)
      expect(outcomes).toHaveLength(attempts);
      const limited = outcomes.filter(
        (o) =>
          o.startsWith('429:') ||
          /TOO_MANY_REQUESTS|RATE_LIMITED|THROTTLED|ThrottlerException/.test(o),
      );

      // ต้องมีอย่างน้อย 1 คำขอที่ถูก limiter ตัด (SCR-FG2-001 §3 · SRS ใหม่ "จำกัดอัตราการเรียกเข้าร่วมต่อผู้ใช้/IP")
      // ถ้าล้ม Jest จะพิมพ์การกระจายของ status:code ทั้งหมดเป็นหลักฐาน
      const summary = {
        limited: limited.length,
        distinct: [...new Set(outcomes)],
      };
      expect(summary.limited > 0 ? 'rate-limited' : summary).toBe(
        'rate-limited',
      );
    });

    it(`PYG-420_24 — TTL boundary: now+1min joins, now−1min is JOIN_LINK_EXPIRED (TTL = ${JOIN_LINK_TTL_HOURS}h)`, async () => {
      expect(JOIN_LINK_TTL_HOURS).toBe(168);

      const fresh = await seedGroupWithOwner();
      const stale = await seedGroupWithOwner();
      const freshLink = await h.createLink(fresh.owner.token, fresh.groupId);
      const staleLink = await h.createLink(stale.owner.token, stale.groupId);
      await h.prisma.familyGroupJoinLink.update({
        where: { id: freshLink.id },
        data: { expiresAt: new Date(Date.now() + 60_000) },
      });
      await h.prisma.familyGroupJoinLink.update({
        where: { id: staleLink.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      const u = await h.seedUser('boundary');

      expect(
        (await h.gql(u.token, OPS.JOIN, { token: freshLink.token })).errors,
      ).toBeUndefined();

      const expired = await h.gql(u.token, OPS.JOIN, {
        token: staleLink.token,
      });
      expect(await h.memberRow(stale.groupId, u.id)).toBeNull();
      expect((await h.linkRow(staleLink.id))!.usedCount).toBe(0);
      expect(codeOf(expired)).toBe('JOIN_LINK_EXPIRED');
    });

    it('PYG-420_25 — join writes exactly one activity row naming the joiner, in the same transaction', async () => {
      const { groupId, owner } = await seedGroupWithOwner();
      const link = await h.createLink(owner.token, groupId);
      const u = await h.seedUser('joiner');

      expect(
        (await h.gql(u.token, OPS.JOIN, { token: link.token })).errors,
      ).toBeUndefined();
      const rows = await h.prisma.familyGroupActivity.findMany({
        where: {
          groupId,
          action: { in: ['MEMBER_JOINED', 'MEMBER_REJOINED'] },
        },
        select: {
          action: true,
          actorId: true,
          targetType: true,
          targetId: true,
          metadata: true,
        },
      });
      expect(rows).toEqual([
        {
          action: 'MEMBER_JOINED',
          actorId: u.id,
          targetType: 'MEMBER',
          targetId: u.id,
          metadata: { joinedViaLinkId: link.id },
        },
      ]);

      // same transaction: บังคับให้ insert activity ของกลุ่มที่สองล้ม → membership + used_count ต้อง rollback
      const g2 = await seedGroupWithOwner();
      const link2 = await h.createLink(g2.owner.token, g2.groupId);
      const v = await h.seedUser('rollback');
      await h.prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION pyg420_fail_join_activity() RETURNS trigger AS $$
      BEGIN
        IF NEW.group_id = '${g2.groupId}'::uuid AND NEW.action = 'MEMBER_JOINED' THEN
          RAISE EXCEPTION 'pyg420 forced activity failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
      await h.prisma.$executeRawUnsafe(`
      CREATE TRIGGER pyg420_fail_join_activity BEFORE INSERT ON family_group_activity
      FOR EACH ROW EXECUTE FUNCTION pyg420_fail_join_activity()`);
      try {
        const failed = await h.gql(v.token, OPS.JOIN, { token: link2.token });
        expect(failed.errors).toBeDefined();
        expect(await h.memberRow(g2.groupId, v.id)).toBeNull();
        expect((await h.linkRow(link2.id))!.usedCount).toBe(0);
      } finally {
        await h.prisma.$executeRawUnsafe(
          'DROP TRIGGER IF EXISTS pyg420_fail_join_activity ON family_group_activity',
        );
        await h.prisma.$executeRawUnsafe(
          'DROP FUNCTION IF EXISTS pyg420_fail_join_activity()',
        );
      }
    });

    it.skip('PYG-420_26 — BLOCKED (decision ค. removed-member re-join) — removed member re-using the old link', () => {
      // ไม่ assert: SCR-FG2-001 §7 ข้อ 3 ยังไม่ตัดสิน (ข้อเสนอ: เข้าได้ + MEMBER_REJOINED)
    });

    // ─── helpers ─────────────────────────────────────────────────────────────
    function seedGroupWithOwner(memberCount = 0) {
      return h.seedGroup(memberCount);
    }
  },
);
