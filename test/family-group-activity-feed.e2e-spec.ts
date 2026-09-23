/**
 * E2E (GraphQL) — PYG-423 / TC-BS-07 · Family group activity feed + member-only access (PYG-409, AC-BS-07)
 *
 * สเปกที่ใช้: AC-BS-07 (PYG-409) + คอมเมนต์ PYG-423 วันที่ 2026-09-02 ทั้งสองอัน
 *   (FG-2 เปลี่ยนจากคำเชิญทางอีเมลเป็นลิงก์เข้าร่วม — SCR-FG2-001) + โมเดล "สมาชิก = patient" ของ PYG-464
 *   ★ ที่ไหนชีตขัดกับคอมเมนต์/โค้ดที่ merge แล้ว คอมเมนต์และโค้ดชนะ และความขัดคือ finding ในรายงาน
 *
 * guard chain จริง + FamilyGroupModule ทั้งโมดูล + Prisma จริงกับ Postgres ทิ้งได้ (test/support/activity-feed-e2e.ts)
 * เคสเรียงลำดับ/แบ่งหน้าใช้กลุ่มที่ seed ตรงลง DB พร้อม created_at ที่คุมเองทุกแถว — ไม่พึ่งเวลานาฬิกา
 * วิธีรัน: docs/qa/pyg-423-activity-feed-report.md หัวข้อ "How to run"
 */
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { ACTIVITY_ACTION } from '../src/family-group/family-group.constants';
import {
  bootstrap,
  codeOf,
  describeDb,
  FeedNode,
  Harness,
} from './support/activity-feed-e2e';

jest.setTimeout(90_000);

const ACTIONS = Object.values(ACTIVITY_ACTION) as string[];

const RENAME = `mutation($g: ID!, $n: String!) { renameFamilyGroup(input: { groupId: $g, name: $n }) { id } }`;
const CREATE_LINK = `mutation($g: ID!) { createJoinLink(input: { groupId: $g }) { id url } }`;
const ROTATE_LINK = `mutation($g: ID!) { rotateJoinLink(input: { groupId: $g }) { id url } }`;
const REVOKE_LINK = `mutation($g: ID!) { revokeJoinLink(groupId: $g) }`;
const JOIN = `mutation($t: String!) { joinGroupByLink(token: $t) { id } }`;
const REMOVE = `mutation($g: ID!, $u: ID!) { removeMember(input: { groupId: $g, userId: $u }) { id } }`;
const LEAVE = `mutation($g: ID!) { leaveFamilyGroup(groupId: $g) { left } }`;
const MY_GROUPS = `query { myFamilyGroups { id } }`;
const ADD_RECIPIENT = `mutation($input: AddGroupCareRecipientInput!) { addGroupCareRecipient(input: $input) { id } }`;
const UPDATE_RECIPIENT = `mutation($input: UpdateGroupCareRecipientInput!) { updateGroupCareRecipient(input: $input) { id } }`;
const ON_BEHALF = `mutation($input: CreateBookingOnBehalfInput!) { createBookingOnBehalf(input: $input) { id } }`;

const BASE = new Date('2026-01-01T00:00:00.000Z');
const minutes = (n: number) => new Date(BASE.getTime() + n * 60_000);
const tokenOf = (url: string) =>
  new URL(url).searchParams.get('token') as string;
let bookingDay = 30;
const nextBookingDate = () =>
  new Date(Date.now() + bookingDay++ * 86_400_000).toISOString().slice(0, 10);

describeDb(
  'PYG-423 · activity feed + member-only access (e2e, real DB)',
  () => {
    let h: Harness;

    beforeAll(async () => {
      h = await bootstrap();
    });

    afterAll(async () => {
      await h?.close();
    });

    const ids = (nodes: FeedNode[]) => nodes.map((n) => n.id);

    /** 12 แถวที่เวลาห่างกันแถวละ 1 นาที → คืน id เรียงใหม่สุดก่อน (ลำดับที่ฟีดควรคืน) */
    const twelveEvents = async (groupId: string, actorId: string) => {
      const created = await h.seedEvents(
        groupId,
        actorId,
        Array.from({ length: 12 }, (_, i) => minutes(i)),
      );
      return [...created].reverse();
    };

    const onBehalfInput = (
      groupId: string,
      memberUserId: string,
      extra = {},
    ) => ({
      groupId,
      memberUserId,
      patientName: 'คุณยาย ฟีด',
      tasks: ['อาบน้ำ'],
      serviceLocations: ['บ้าน'],
      serviceType: 'general_care',
      timeSlot: 'morning',
      startTime: '09:00:00',
      durationHours: 2,
      locationAddress: 'PYG-423 address',
      bookingDate: nextBookingDate(),
      ...extra,
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  ลำดับและเนื้อหาของฟีด
    // ═══════════════════════════════════════════════════════════════════════

    it('PYG-423_01 — feed returns events newest-first; the most recent mutation is at index 0', async () => {
      const { groupId, owner } = await h.seedBareGroup();
      const seeded = await h.seedEvents(groupId, owner.id, [
        minutes(0),
        minutes(10),
        minutes(20),
      ]);
      expect(
        (await h.gql(owner.token, RENAME, { g: groupId, n: 'ชื่อใหม่' }))
          .errors,
      ).toBeUndefined();

      const { body, nodes } = await h.feed(owner.token, groupId);
      expect(body.errors).toBeUndefined();

      expect(nodes[0].action).toBe('GROUP_RENAMED');
      expect(nodes[0].metadata).toContain('ชื่อใหม่');
      expect(ids(nodes.slice(1))).toEqual([seeded[2], seeded[1], seeded[0]]);
      const times = nodes.map((n) => Date.parse(n.createdAt));
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    });

    it('PYG-423_02 (rewritten) — each event shows the correct actor, action (from the enum) and timestamp', async () => {
      const { groupId, owner } = await h.seedGroupViaApi();

      const beforeRename = Date.now();
      expect(
        (await h.gql(owner.token, RENAME, { g: groupId, n: 'บ้านใหม่' }))
          .errors,
      ).toBeUndefined();
      const afterRename = Date.now();
      const renameNode = (await h.feed(owner.token, groupId)).nodes[0];

      const beforeLink = Date.now();
      expect(
        (await h.gql(owner.token, CREATE_LINK, { g: groupId })).errors,
      ).toBeUndefined();
      const afterLink = Date.now();
      const linkNode = (await h.feed(owner.token, groupId)).nodes[0];

      for (const [node, action, from, to] of [
        [renameNode, 'GROUP_RENAMED', beforeRename, afterRename],
        [linkNode, 'JOIN_LINK_CREATED', beforeLink, afterLink],
      ] as const) {
        expect(ACTIONS).toContain(action);
        expect(node.action).toBe(action);
        expect(node.actor).toEqual({
          userId: owner.id,
          displayName: owner.displayName,
        });
        const t = Date.parse(node.createdAt);
        expect(t).toBeGreaterThanOrEqual(from - 1000);
        expect(t).toBeLessThanOrEqual(to + 1000);
      }
    });

    it('PYG-423_03 — identical created_at values return in a deterministic tiebreak order (id DESC)', async () => {
      const { groupId, owner } = await h.seedBareGroup();
      const same = minutes(5);
      const [a, b] = await h.seedEvents(groupId, owner.id, [same, same]);

      const first = ids((await h.feed(owner.token, groupId)).nodes);
      const second = ids((await h.feed(owner.token, groupId)).nodes);

      expect(first).toEqual(second);
      expect(first).toEqual([a, b].sort().reverse()); // uuid เทียบแบบไบต์ = ลำดับสตริง hex ตัวเล็ก
      const column = await h.prisma.$queryRawUnsafe<
        { data_type: string; column_default: string }[]
      >(
        `select data_type, column_default from information_schema.columns
        where table_name = 'family_group_activity' and column_name = 'id'`,
      );
      expect(column[0]).toEqual({
        data_type: 'uuid',
        column_default: 'gen_random_uuid()',
      });
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  แบ่งหน้าแบบ keyset
    // ═══════════════════════════════════════════════════════════════════════

    it('PYG-423_04 — first page returns the newest N with a next-page cursor', async () => {
      const { groupId, owner } = await h.seedBareGroup();
      const expected = await twelveEvents(groupId, owner.id);

      const { nodes, pageInfo } = await h.feed(owner.token, groupId, 5);
      expect(ids(nodes)).toEqual(expected.slice(0, 5));
      expect(pageInfo).toEqual({
        endCursor: nodes[4].cursor,
        hasNextPage: true,
      });
    });

    it('PYG-423_05 — next page via cursor returns the following events with no overlap and no gap', async () => {
      const { groupId, owner } = await h.seedBareGroup();
      const expected = await twelveEvents(groupId, owner.id);

      const page1 = await h.feed(owner.token, groupId, 5);
      const page2 = await h.feed(
        owner.token,
        groupId,
        5,
        page1.pageInfo!.endCursor!,
      );

      expect(ids(page2.nodes)).toEqual(expected.slice(5, 10));
      expect(
        ids(page1.nodes).filter((id) => ids(page2.nodes).includes(id)),
      ).toEqual([]);
      expect([...ids(page1.nodes), ...ids(page2.nodes)]).toEqual(
        expected.slice(0, 10),
      );
    });

    it('PYG-423_06 — keyset pagination stays anchored when a newer event is inserted between page fetches', async () => {
      const { groupId, owner } = await h.seedBareGroup();
      const expected = await twelveEvents(groupId, owner.id);

      const page1 = await h.feed(owner.token, groupId, 5);
      await h.seedEvents(groupId, owner.id, [minutes(100)]); // ใหม่กว่าทุกแถว
      const page2 = await h.feed(
        owner.token,
        groupId,
        5,
        page1.pageInfo!.endCursor!,
      );

      // offset-based จะเลื่อนไป 1 แถวและส่ง expected[4] ซ้ำ — keyset ต้องไม่เป็นแบบนั้น
      expect(ids(page2.nodes)).toEqual(expected.slice(5, 10));
    });

    it('PYG-423_07 — last page returns the remainder and signals no more pages', async () => {
      const { groupId, owner } = await h.seedBareGroup();
      const expected = await twelveEvents(groupId, owner.id);

      const sizes: number[] = [];
      const seen: string[] = [];
      let after: string | undefined;
      let last: Awaited<ReturnType<Harness['feed']>> | undefined;
      for (let i = 0; i < 10; i++) {
        last = await h.feed(owner.token, groupId, 5, after);
        sizes.push(last.nodes.length);
        seen.push(...ids(last.nodes));
        if (!last.pageInfo!.hasNextPage) break;
        after = last.pageInfo!.endCursor!;
      }

      expect(sizes).toEqual([5, 5, 2]);
      expect(seen).toEqual(expected);
      expect(last!.pageInfo!.hasNextPage).toBe(false);
      // Relay pageInfo: endCursor ยังชี้แถวสุดท้าย (ไม่ใช่ null) — ขอต่อด้วยค่านี้ต้องได้หน้าว่าง
      const beyond = await h.feed(
        owner.token,
        groupId,
        5,
        last!.pageInfo!.endCursor!,
      );
      expect(beyond.nodes).toEqual([]);
      expect(beyond.pageInfo!.hasNextPage).toBe(false);
    });

    it('PYG-423_08 — invalid or tampered cursors are rejected with ACTIVITY_CURSOR_INVALID and leak nothing', async () => {
      const { groupId, owner } = await h.seedBareGroup();
      await twelveEvents(groupId, owner.id);
      const other = await h.seedBareGroup();
      const otherIds = await twelveEvents(other.groupId, other.owner.id);
      const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
      const countBefore = await h.activityCount(groupId);

      const variants: Record<string, string> = {
        notBase64: 'not-a-cursor!!',
        garbage: b64('garbage'),
        emptyId: b64('2026-01-01T00:00:00.000Z|'),
        tooManyParts: b64('a|b|c'),
        badDate: b64(`not-a-date|${randomUUID()}`),
        nonUuidId: b64('2026-01-01T00:00:00.000Z|not-a-uuid'),
      };

      const observed: Record<string, string> = {};
      for (const [name, cursor] of Object.entries(variants)) {
        const { body, nodes } = await h.feed(owner.token, groupId, 5, cursor);
        expect(nodes).toEqual([]);
        expect(JSON.stringify(body)).not.toMatch(
          new RegExp(otherIds.join('|')),
        );
        observed[name] = String(codeOf(body) ?? 'NO_ERROR');
      }

      expect(await h.activityCount(groupId)).toBe(countBefore);
      expect(observed).toEqual(
        Object.fromEntries(
          Object.keys(variants).map((k) => [k, 'ACTIVITY_CURSOR_INVALID']),
        ),
      );
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  สิทธิ์การอ่าน
    // ═══════════════════════════════════════════════════════════════════════

    it('PYG-423_09 — an ACTIVE member can read the feed', async () => {
      const { groupId, owner, members } = await h.seedBareGroup(1);
      const expected = await twelveEvents(groupId, owner.id);
      const m = members[0];
      expect(
        (await h.prisma.familyGroupMember.findUnique({
          where: { groupId_userId: { groupId, userId: m.id } },
          select: { status: true, role: true },
        }))!,
      ).toEqual({ status: 'ACTIVE', role: 'MEMBER' });

      const { body, nodes } = await h.feed(m.token, groupId, 50);
      expect(body.errors).toBeUndefined();
      expect(ids(nodes)).toEqual(expected);
    });

    it('PYG-423_10 — a non-member cannot read the feed (NOT_A_MEMBER, no events)', async () => {
      const { groupId, owner } = await h.seedBareGroup();
      const seeded = await twelveEvents(groupId, owner.id);
      const u = await h.seedUser('outsider');
      const before = await h.activityCount(groupId);

      const { body } = await h.feed(u.token, groupId);
      expect(body.data).toBeNull();
      expect(JSON.stringify(body)).not.toMatch(new RegExp(seeded.join('|')));
      expect(await h.activityCount(groupId)).toBe(before);
      expect(codeOf(body)).toBe('NOT_A_MEMBER');
    });

    it('PYG-423_11 — an unauthenticated request cannot read the feed (UNAUTHENTICATED)', async () => {
      const { groupId, owner } = await h.seedBareGroup();
      const seeded = await twelveEvents(groupId, owner.id);

      const missing = await h.feed(null, groupId);
      const invalid = await h.feed('tok-not-a-real-session', groupId);

      for (const { body } of [missing, invalid]) {
        expect(body.data).toBeNull();
        expect(JSON.stringify(body)).not.toMatch(new RegExp(seeded.join('|')));
      }
      expect([codeOf(missing.body), codeOf(invalid.body)]).toEqual([
        'UNAUTHENTICATED',
        'UNAUTHENTICATED',
      ]);
    });

    it("PYG-423_12 — a member of another group cannot read this group's feed", async () => {
      const g1 = await h.seedBareGroup();
      const g1Ids = await twelveEvents(g1.groupId, g1.owner.id);
      const g2 = await h.seedBareGroup(1);

      const { body } = await h.feed(g2.members[0].token, g1.groupId);
      expect(body.data).toBeNull();
      expect(JSON.stringify(body)).not.toMatch(new RegExp(g1Ids.join('|')));
      expect(codeOf(body)).toBe('NOT_A_MEMBER');
    });

    it('PYG-423_13 — a removed member can no longer read the feed', async () => {
      const { groupId, owner, members } = await h.seedGroupViaApi(1);
      const m = members[0];
      expect((await h.feed(m.token, groupId)).body.errors).toBeUndefined();

      expect(
        (await h.gql(owner.token, REMOVE, { g: groupId, u: m.id })).errors,
      ).toBeUndefined();

      const { body } = await h.feed(m.token, groupId);
      expect(body.data).toBeNull();
      expect(codeOf(body)).toBe('NOT_A_MEMBER');
    });

    it('PYG-423_14 — a member who leaves loses feed access', async () => {
      const { groupId, members } = await h.seedGroupViaApi(1);
      const m = members[0];
      expect((await h.feed(m.token, groupId)).body.errors).toBeUndefined();

      expect(
        (await h.gql(m.token, LEAVE, { g: groupId })).errors,
      ).toBeUndefined();

      const { body } = await h.feed(m.token, groupId);
      expect(body.data).toBeNull();
      expect(codeOf(body)).toBe('NOT_A_MEMBER');
    });

    it("PYG-423_15 — a removed member's still-valid session cannot read the feed (membership re-checked per request)", async () => {
      const { groupId, owner, members } = await h.seedGroupViaApi(1);
      const m = members[0];
      expect((await h.feed(m.token, groupId)).nodes.length).toBeGreaterThan(0);

      expect(
        (await h.gql(owner.token, REMOVE, { g: groupId, u: m.id })).errors,
      ).toBeUndefined();

      // token เดิมยังผ่าน auth ได้จริง (ไม่ใช่ token หมดอายุ)
      const stillAuthenticated = await h.gql(m.token, MY_GROUPS);
      expect(stillAuthenticated.errors).toBeUndefined();
      expect(stillAuthenticated.data!.myFamilyGroups).toEqual([]);

      const { body } = await h.feed(m.token, groupId);
      expect(body.data).toBeNull();
      expect(codeOf(body)).toBe('NOT_A_MEMBER');
    });

    it('PYG-423_31 — a non-ACTIVE membership row (LEFT / REMOVED) cannot read the feed', async () => {
      const { groupId, owner, members } = await h.seedBareGroup(2);
      const seeded = await twelveEvents(groupId, owner.id);
      const [left, removed] = members;
      await h.prisma.familyGroupMember.update({
        where: { groupId_userId: { groupId, userId: left.id } },
        data: { status: 'LEFT', removedAt: new Date() },
      });
      await h.prisma.familyGroupMember.update({
        where: { groupId_userId: { groupId, userId: removed.id } },
        data: { status: 'REMOVED', removedAt: new Date() },
      });

      const results = [
        await h.feed(left.token, groupId),
        await h.feed(removed.token, groupId),
      ];
      for (const { body, nodes } of results) {
        expect(body.data).toBeNull();
        expect(nodes).toEqual([]);
        expect(JSON.stringify(body)).not.toMatch(new RegExp(seeded.join('|')));
      }
      expect(results.map((r) => codeOf(r.body))).toEqual([
        'NOT_A_MEMBER',
        'NOT_A_MEMBER',
      ]);
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  การเขียนแถวกิจกรรม (emission)
    // ═══════════════════════════════════════════════════════════════════════

    it('PYG-423_16 — creating a family group produces exactly one GROUP_CREATED row', async () => {
      const creator = await h.seedUser('creator');
      const body = await h.gql(
        creator.token,
        `mutation($name: String!) { createFamilyGroup(input: { name: $name }) { id } }`,
        { name: 'กลุ่มใหม่' },
      );
      const groupId = body.data!.createFamilyGroup.id as string;

      const rows = await h.prisma.familyGroupActivity.findMany({
        where: { groupId },
        select: { action: true, actorId: true },
      });
      expect(rows).toEqual([{ action: 'GROUP_CREATED', actorId: creator.id }]);
    });

    it('PYG-423_18 (rewritten) — care-recipient changes produce exactly one activity row each; booking on behalf adds no separate recipient row', async () => {
      const { groupId, members } = await h.seedGroupViaApi(2);
      const [m, n] = members;
      const count = (action: string) =>
        h.prisma.familyGroupActivity.count({ where: { groupId, action } });

      // ทางที่ 1: mutation แบบ explicit ที่ยังเปิดอยู่ใน GraphQL (FE ไม่มีที่เรียก — PYG-464)
      const added = await h.gql(m.token, ADD_RECIPIENT, {
        input: { groupId, name: 'คุณตา explicit' },
      });
      expect(added.errors).toBeUndefined();
      const recipientId = added.data!.addGroupCareRecipient.id as string;
      const updated = await h.gql(m.token, UPDATE_RECIPIENT, {
        input: { groupId, recipientId, nickname: 'ตาเอง' },
      });
      expect(updated.errors).toBeUndefined();

      // ทางที่ 2: โมเดล PYG-464 — โปรไฟล์ถูกสร้างเงียบ ๆ ใน createBookingOnBehalf
      const booking = await h.gql(m.token, ON_BEHALF, {
        input: onBehalfInput(groupId, n.id),
      });
      expect(booking.errors).toBeUndefined();

      const observed = {
        explicitAdd_RECIPIENT_ADDED: await count('RECIPIENT_ADDED'),
        explicitUpdate_RECIPIENT_UPDATED: await count('RECIPIENT_UPDATED'),
        implicitBooking_BOOKING_ON_BEHALF: await count('BOOKING_ON_BEHALF'),
        recipientRowsFromImplicitProvisioning:
          (await count('RECIPIENT_ADDED')) - 1, // ไม่ควรมีเพิ่มจากการจองแทน
      };
      expect(observed).toEqual({
        explicitAdd_RECIPIENT_ADDED: 1,
        explicitUpdate_RECIPIENT_UPDATED: 1,
        implicitBooking_BOOKING_ON_BEHALF: 1,
        recipientRowsFromImplicitProvisioning: 0,
      });
    });

    it('PYG-423_19 (rewritten) — booking on behalf produces exactly one activity row, using the action the code emits (BOOKING_ON_BEHALF)', async () => {
      const { groupId, members } = await h.seedGroupViaApi(2);
      const [m, n] = members;

      const body = await h.gql(m.token, ON_BEHALF, {
        input: onBehalfInput(groupId, n.id),
      });
      expect(body.errors).toBeUndefined();
      const bookingId = body.data!.createBookingOnBehalf.id as string;

      const rows = await h.prisma.familyGroupActivity.findMany({
        where: { groupId, targetType: 'BOOKING' },
        select: { action: true, actorId: true, targetId: true },
      });
      expect(ACTIONS).toContain('BOOKING_ON_BEHALF');
      expect(ACTIONS).not.toContain('BOOKING_CREATED');
      expect(rows).toEqual([
        { action: 'BOOKING_ON_BEHALF', actorId: m.id, targetId: bookingId },
      ]);
    });

    it('PYG-423_20 — a rolled-back mutation produces zero activity rows and no phantom event', async () => {
      const { groupId, owner } = await h.seedGroupViaApi();
      const before = await h.activityCount(groupId);

      await h.prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION pyg423_fail_activity() RETURNS trigger AS $$
      BEGIN
        IF NEW.group_id = '${groupId}'::uuid THEN
          RAISE EXCEPTION 'pyg423 forced activity failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
      await h.prisma.$executeRawUnsafe(`
      CREATE TRIGGER pyg423_fail_activity BEFORE INSERT ON family_group_activity
      FOR EACH ROW EXECUTE FUNCTION pyg423_fail_activity()`);
      try {
        const failed = await h.gql(owner.token, RENAME, {
          g: groupId,
          n: 'ต้องไม่ติด',
        });
        expect(failed.errors).toBeDefined();
      } finally {
        await h.prisma.$executeRawUnsafe(
          'DROP TRIGGER IF EXISTS pyg423_fail_activity ON family_group_activity',
        );
        await h.prisma.$executeRawUnsafe(
          'DROP FUNCTION IF EXISTS pyg423_fail_activity()',
        );
      }

      expect(
        (await h.prisma.familyGroup.findUnique({
          where: { id: groupId },
          select: { name: true },
        }))!.name,
      ).toBe('บ้าน PYG-423');
      expect(await h.activityCount(groupId)).toBe(before);
      const { nodes } = await h.feed(owner.token, groupId, 50);
      expect(nodes.map((x) => x.action)).not.toContain('GROUP_RENAMED');
    });

    it.skip('PYG-423_21 — BLOCKED: no family-group mutation supports retry / idempotency keys (idempotency exists only for payments, PYG-375)', () => {
      // ไม่ assert: ไม่มีกลไก idempotency ในโมดูล family group ให้ทดสอบ — ห้ามประดิษฐ์ retry ที่ผ่านเงียบ ๆ
    });

    it('PYG-423_22 — creating a join link produces exactly one JOIN_LINK_CREATED row (a repeat create adds none)', async () => {
      const { groupId, owner } = await h.seedGroupViaApi();

      expect(
        (await h.gql(owner.token, CREATE_LINK, { g: groupId })).errors,
      ).toBeUndefined();
      expect(
        (await h.gql(owner.token, CREATE_LINK, { g: groupId })).errors,
      ).toBeUndefined(); // คืนใบเดิม

      const rows = await h.prisma.familyGroupActivity.findMany({
        where: { groupId, action: 'JOIN_LINK_CREATED' },
        select: { actorId: true, targetType: true },
      });
      expect(rows).toEqual([{ actorId: owner.id, targetType: 'JOIN_LINK' }]);
    });

    it('PYG-423_23 — rotating a join link produces exactly one JOIN_LINK_ROTATED row and no extra revoke row', async () => {
      const { groupId, owner } = await h.seedGroupViaApi();
      await h.gql(owner.token, CREATE_LINK, { g: groupId });

      const rotated = await h.gql(owner.token, ROTATE_LINK, { g: groupId });
      expect(rotated.errors).toBeUndefined();

      const count = (action: string) =>
        h.prisma.familyGroupActivity.count({ where: { groupId, action } });
      expect({
        JOIN_LINK_CREATED: await count('JOIN_LINK_CREATED'),
        JOIN_LINK_ROTATED: await count('JOIN_LINK_ROTATED'),
        JOIN_LINK_REVOKED: await count('JOIN_LINK_REVOKED'),
      }).toEqual({
        JOIN_LINK_CREATED: 1,
        JOIN_LINK_ROTATED: 1,
        JOIN_LINK_REVOKED: 0,
      });
    });

    it('PYG-423_24 — revoking a join link produces exactly one JOIN_LINK_REVOKED row, actor = owner', async () => {
      const { groupId, owner } = await h.seedGroupViaApi();
      await h.gql(owner.token, CREATE_LINK, { g: groupId });

      const revoked = await h.gql(owner.token, REVOKE_LINK, { g: groupId });
      expect(revoked.errors).toBeUndefined();

      const rows = await h.prisma.familyGroupActivity.findMany({
        where: { groupId, action: 'JOIN_LINK_REVOKED' },
        select: { actorId: true },
      });
      expect(rows).toEqual([{ actorId: owner.id }]);
    });

    it('PYG-423_25 — joining via link writes one MEMBER_JOINED row with linkId in metadata', async () => {
      const { groupId, owner } = await h.seedGroupViaApi();
      const link = await h.gql(owner.token, CREATE_LINK, { g: groupId });
      const linkId = link.data!.createJoinLink.id as string;
      const u = await h.seedUser('joiner');

      expect(
        (
          await h.gql(u.token, JOIN, {
            t: tokenOf(link.data!.createJoinLink.url as string),
          })
        ).errors,
      ).toBeUndefined();

      const rows = await h.prisma.familyGroupActivity.findMany({
        where: { groupId, action: 'MEMBER_JOINED' },
        select: { actorId: true, metadata: true },
      });
      const metadata = (rows[0]?.metadata ?? {}) as Record<string, unknown>;
      expect({
        rows: rows.length,
        actorId: rows[0]?.actorId,
        metadataKeys: Object.keys(metadata),
        linkId: metadata.linkId,
      }).toEqual({
        rows: 1,
        actorId: u.id,
        metadataKeys: ['linkId'],
        linkId,
      });
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  ความเป็นส่วนตัว / ความถูกต้องของฟีด
    // ═══════════════════════════════════════════════════════════════════════

    it('PYG-423_26 — the feed never exposes a join token, token hash or full link URL', async () => {
      const { groupId, owner, members } = await h.seedGroupViaApi(1);
      const urls: string[] = [];
      const c1 = await h.gql(owner.token, CREATE_LINK, { g: groupId });
      urls.push(c1.data!.createJoinLink.url as string);
      const r = await h.gql(owner.token, ROTATE_LINK, { g: groupId });
      urls.push(r.data!.rotateJoinLink.url as string);
      await h.gql(owner.token, REVOKE_LINK, { g: groupId });
      const c2 = await h.gql(owner.token, CREATE_LINK, { g: groupId });
      urls.push(c2.data!.createJoinLink.url as string);
      const u = await h.seedUser('joiner');
      expect(
        (await h.gql(u.token, JOIN, { t: tokenOf(urls[2]) })).errors,
      ).toBeUndefined();

      const secrets = await h.prisma.familyGroupJoinLink.findMany({
        where: { groupId },
        select: { tokenHash: true, tokenRaw: true },
      });
      const { body, nodes } = await h.feed(members[0].token, groupId, 50);
      expect(body.errors).toBeUndefined();
      expect(nodes.map((n) => n.action)).toEqual(
        expect.arrayContaining([
          'JOIN_LINK_CREATED',
          'JOIN_LINK_ROTATED',
          'JOIN_LINK_REVOKED',
          'MEMBER_JOINED',
        ]),
      );

      const payload = JSON.stringify(body);
      const leaks = [
        ...urls.map((url) => ({ kind: 'url', value: url })),
        ...urls.map((url) => ({ kind: 'token', value: tokenOf(url) })),
        ...secrets.flatMap((s) => [
          { kind: 'tokenHash', value: s.tokenHash },
          ...(s.tokenRaw ? [{ kind: 'tokenRaw', value: s.tokenRaw }] : []),
        ]),
        { kind: 'urlFragment', value: 'token=' },
        { kind: 'baseUrl', value: 'pyg423.test' },
      ].filter((x) => payload.includes(x.value));
      expect(leaks).toEqual([]);
    });

    it('PYG-423_27 — the feed does not expose care recipient health details', async () => {
      const { groupId, members } = await h.seedGroupViaApi(3);
      const [m, n, p] = members;
      const booking = await h.gql(m.token, ON_BEHALF, {
        input: onBehalfInput(groupId, n.id, {
          memberDetails: {
            conditions: ['โรคลับ-หัวใจ'],
            medicines: 'ยาลับ-metformin',
            allergies: 'แพ้ลับ-penicillin',
            careInstructions: 'คำแนะนำลับ',
          },
        }),
      });
      expect(booking.errors).toBeUndefined();

      const { body, nodes } = await h.feed(p.token, groupId, 50);
      const event = nodes.find((x) => x.action === 'BOOKING_ON_BEHALF')!;
      const payload = JSON.stringify(body);

      expect(event.actor?.userId).toBe(m.id);
      expect(Object.keys(JSON.parse(event.metadata)).sort()).toEqual([
        'bookingDate',
        'recipientName',
        'startTime',
      ]);
      expect(
        [
          'โรคลับ-หัวใจ',
          'ยาลับ-metformin',
          'แพ้ลับ-penicillin',
          'คำแนะนำลับ',
        ].filter((s) => payload.includes(s)),
      ).toEqual([]);
    });

    it('PYG-423_28 — the activity feed is append-only through the API (no mutation can edit or delete a row)', async () => {
      const { groupId, owner } = await h.seedGroupViaApi();
      await h.gql(owner.token, RENAME, { g: groupId, n: 'ก่อนลอง' });
      const snapshot = await h.prisma.familyGroupActivity.findMany({
        where: { groupId },
        orderBy: { createdAt: 'asc' },
      });

      const schema = await h.gql(
        owner.token,
        `{ __schema { mutationType { fields { name } } } }`,
      );
      const mutationNames = (
        schema.data!.__schema.mutationType.fields as { name: string }[]
      ).map((f) => f.name);
      const attempts = [
        await h.gql(
          owner.token,
          `mutation { deleteFamilyGroupActivity(id: "${snapshot[0].id}") }`,
        ),
        await h.gql(
          owner.token,
          `mutation { updateFamilyGroupActivity(id: "${snapshot[0].id}", action: "GROUP_CREATED") }`,
        ),
      ];

      expect(mutationNames.filter((name) => /activity/i.test(name))).toEqual(
        [],
      );
      expect(attempts.map((a) => codeOf(a))).toEqual([
        'GRAPHQL_VALIDATION_FAILED',
        'GRAPHQL_VALIDATION_FAILED',
      ]);
      expect(
        await h.prisma.familyGroupActivity.findMany({
          where: { groupId },
          orderBy: { createdAt: 'asc' },
        }),
      ).toEqual(snapshot);
    });

    it('PYG-423_29 — realtime exposure is safe: family_group_activity is not published, or is published only with RLS enabled (repo migrations)', () => {
      const dir = join(__dirname, '../prisma/migrations');
      const sql = readdirSync(dir)
        .map((d) => join(dir, d, 'migration.sql'))
        .filter((f) => existsSync(f))
        .map((f) => readFileSync(f, 'utf8'))
        .join('\n')
        .split('\n')
        .filter((line) => !/^\s*--/.test(line))
        .join('\n');

      const published =
        /ALTER\s+PUBLICATION\s+supabase_realtime\s+ADD\s+TABLE[^;]*family_group_activity/i.test(
          sql,
        );
      const rlsEnabled =
        /ALTER\s+TABLE\s+"?family_group_activity"?\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(
          sql,
        );

      expect({
        published,
        rlsEnabled,
        unsafe: published && !rlsEnabled,
      }).toEqual({
        published: false,
        rlsEnabled: true,
        unsafe: false,
      });
    });

    it('PYG-423_30 — a cursor issued for one group cannot page another group’s feed', async () => {
      const g1 = await h.seedBareGroup();
      const g2 = await h.seedBareGroup();
      const m = await h.seedUser('both-groups');
      for (const groupId of [g1.groupId, g2.groupId]) {
        await h.prisma.familyGroupMember.create({
          data: { groupId, userId: m.id, role: 'MEMBER', status: 'ACTIVE' },
        });
      }
      const g1Ids = await twelveEvents(g1.groupId, g1.owner.id);
      const g2Ids = await h.seedEvents(
        g2.groupId,
        g2.owner.id,
        Array.from(
          { length: 12 },
          (_, i) => new Date(minutes(i).getTime() + 30_000),
        ),
      );

      const g1Page1 = await h.feed(m.token, g1.groupId, 3);
      const cross = await h.feed(
        m.token,
        g2.groupId,
        50,
        g1Page1.pageInfo!.endCursor!,
      );

      const leaked = ids(cross.nodes).filter((id) => g1Ids.includes(id));
      expect(leaked).toEqual([]);
      expect(ids(cross.nodes).every((id) => g2Ids.includes(id))).toBe(true);
    });
  },
);
