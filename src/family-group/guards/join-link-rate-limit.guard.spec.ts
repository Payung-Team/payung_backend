/**
 * Unit tests — JoinLinkRateLimitGuard (PYG-479)
 *
 * ครอบคลุม AC ของการ์ด:
 *   ✅ คำขอที่เกินเกณฑ์ถูกปฏิเสธ ทั้งต่อผู้ใช้และต่อ IP
 *   ✅ error เป็นรูป extensions.code แบบเดียวกับ error อื่นของ family group (ไม่ใช่ 500)
 *   ✅ ผู้ใช้ปกติที่กดไม่กี่ครั้งไม่โดนผลกระทบ
 *
 * วิธี mock GraphQL context ยืมแพตเทิร์นเดียวกับ family-group.guard.spec.ts:
 *   spy ที่ GqlExecutionContext.create แทนการปั้น ExecutionContext ครบทุกเมธอด
 * คุมเวลาด้วย jest.spyOn(Date, 'now') — guard อ่านเวลาจาก Date.now() ตรง ๆ
 *
 * ★ ตัวเลขเพดานอ่านจากค่าคงที่จริง ไม่ hardcode → ถ้าวันหนึ่งทีมเปลี่ยน default
 *   เทสยังตรวจพฤติกรรมเดิมได้โดยไม่ต้องตามแก้ตัวเลข
 */
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { GraphQLError } from 'graphql';
import { JoinLinkRateLimitGuard } from './join-link-rate-limit.guard';
import {
  JOIN_RATE_LIMIT_PER_IP,
  JOIN_RATE_LIMIT_PER_USER,
  JOIN_RATE_LIMIT_WINDOW_SECONDS,
} from '../family-group.constants';
import { FG_ERROR } from '../family-group.errors';
import { AuthUser } from '../../common/decorators/current-user.decorator';

const WINDOW_MS = JOIN_RATE_LIMIT_WINDOW_SECONDS * 1000;
const T0 = 1_800_000_000_000; // เวลาเริ่มต้นสมมติ (epoch ms) — ค่าอะไรก็ได้ที่คงที่

const makeUser = (id: string): AuthUser => ({
  id,
  supabaseUid: `sb-${id}`,
  email: `${id}@payung.app`,
  role: 1,
  isSuspended: false,
});

const mockExecutionContext = {} as ExecutionContext;

describe('JoinLinkRateLimitGuard (PYG-479)', () => {
  let guard: JoinLinkRateLimitGuard;
  let now: number;

  /** ตั้ง request ของคำขอถัดไป: ใคร + มาจาก IP อะไร */
  const asRequest = (user: AuthUser | undefined, ip = '203.0.113.9') => {
    jest.spyOn(GqlExecutionContext, 'create').mockReturnValue({
      getContext: () => ({ req: { user, headers: {}, ip } }),
    } as unknown as GqlExecutionContext);
  };

  /** เรียก guard 1 ครั้ง — คืน 'OK' หรือ extensions.code ของ error ที่ได้ */
  const call = (user: AuthUser | undefined, ip?: string): string => {
    asRequest(user, ip);
    try {
      guard.canActivate(mockExecutionContext);
      return 'OK';
    } catch (err) {
      if (err instanceof GraphQLError) {
        return String(err.extensions.code);
      }
      throw err;
    }
  };

  /** เรียก guard แล้วคืน error ที่โยนออกมา (ไม่โยน = undefined) */
  const thrownBy = (user: AuthUser): unknown => {
    asRequest(user);
    try {
      guard.canActivate(mockExecutionContext);
      return undefined;
    } catch (err) {
      return err;
    }
  };

  beforeEach(() => {
    // guard ใหม่ทุกเคส = ตัวนับว่างทุกครั้ง เคสไม่ปนกัน
    guard = new JoinLinkRateLimitGuard();
    now = T0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => jest.restoreAllMocks());

  // ─── ผู้ใช้ปกติไม่โดนผลกระทบ ──────────────────────────────────────────
  it('ผู้ใช้ปกติ (preview + join ไม่กี่ครั้ง) ผ่านทุกครั้ง', () => {
    const u = makeUser('normal');
    expect([call(u), call(u), call(u)]).toEqual(['OK', 'OK', 'OK']);
  });

  // ─── ต่อผู้ใช้ ─────────────────────────────────────────────────────────
  it(`ต่อผู้ใช้: ผ่านได้ ${JOIN_RATE_LIMIT_PER_USER} ครั้ง แล้วครั้งถัดไปได้ JOIN_LINK_RATE_LIMITED`, () => {
    const u = makeUser('hammer');
    for (let i = 0; i < JOIN_RATE_LIMIT_PER_USER; i++) {
      expect(call(u)).toBe('OK');
    }
    expect(call(u)).toBe(FG_ERROR.JOIN_LINK_RATE_LIMITED);
  });

  it('ต่อผู้ใช้: เปลี่ยน IP หนีไม่ได้ (นับตาม userId จาก JWT)', () => {
    const u = makeUser('ip-hopper');
    for (let i = 0; i < JOIN_RATE_LIMIT_PER_USER; i++) {
      expect(call(u, `198.51.100.${i}`)).toBe('OK');
    }
    expect(call(u, '192.0.2.250')).toBe(FG_ERROR.JOIN_LINK_RATE_LIMITED);
  });

  it('ต่อผู้ใช้: คนหนึ่งเต็มไม่กระทบอีกคน', () => {
    const a = makeUser('a');
    const b = makeUser('b');
    for (let i = 0; i < JOIN_RATE_LIMIT_PER_USER; i++) call(a, '198.51.100.1');

    expect(call(a, '198.51.100.1')).toBe(FG_ERROR.JOIN_LINK_RATE_LIMITED);
    expect(call(b, '198.51.100.2')).toBe('OK');
  });

  // ─── ต่อ IP ────────────────────────────────────────────────────────────
  it(`ต่อ IP: หลายบัญชีจาก IP เดียวกัน รวมกันเกิน ${JOIN_RATE_LIMIT_PER_IP} ครั้ง → ถูกปฏิเสธ`, () => {
    const ip = '203.0.113.50';
    // บัญชีใหม่ทุกครั้ง → ไม่มีบัญชีไหนชนเพดานต่อผู้ใช้เลย ชนเพดานต่อ IP อย่างเดียว
    for (let i = 0; i < JOIN_RATE_LIMIT_PER_IP; i++) {
      expect(call(makeUser(`sock-${i}`), ip)).toBe('OK');
    }
    expect(call(makeUser('sock-extra'), ip)).toBe(
      FG_ERROR.JOIN_LINK_RATE_LIMITED,
    );
    // IP อื่นยังใช้ได้ปกติ
    expect(call(makeUser('elsewhere'), '203.0.113.51')).toBe('OK');
  });

  it('หา IP ไม่ได้ → ข้ามการนับต่อ IP แต่ยังนับต่อผู้ใช้', () => {
    const u = makeUser('no-ip');
    for (let i = 0; i < JOIN_RATE_LIMIT_PER_USER; i++) {
      expect(call(u, 'not-an-ip')).toBe('OK');
    }
    expect(call(u, 'not-an-ip')).toBe(FG_ERROR.JOIN_LINK_RATE_LIMITED);
  });

  // ─── รูปแบบ error ──────────────────────────────────────────────────────
  it('error เป็น GraphQLError รูป extensions.code + retryAfterSeconds (ไม่ใช่ HttpException / 500)', () => {
    const u = makeUser('shape');
    for (let i = 0; i < JOIN_RATE_LIMIT_PER_USER; i++) call(u);

    // ผ่านไป 10 วินาทีนับจากครั้งแรก → ต้องรออีก (หน้าต่าง − 10) วินาที
    now = T0 + 10_000;
    const thrown = thrownBy(u);

    expect(thrown).toBeInstanceOf(GraphQLError);
    const gqlErr = thrown as GraphQLError;
    expect(gqlErr.extensions).toEqual({
      code: FG_ERROR.JOIN_LINK_RATE_LIMITED,
      retryAfterSeconds: JOIN_RATE_LIMIT_WINDOW_SECONDS - 10,
    });
    // ข้อความภาษาไทยพร้อมโชว์ และบอกเวลารอตรงกับ extensions
    expect(gqlErr.message).toContain(
      `${JOIN_RATE_LIMIT_WINDOW_SECONDS - 10} วินาที`,
    );
  });

  it('retryAfterSeconds ปัดขึ้น — เหลือไม่ถึงวินาทีต้องบอก 1 ไม่ใช่ 0', () => {
    const u = makeUser('round-up');
    for (let i = 0; i < JOIN_RATE_LIMIT_PER_USER; i++) call(u);

    now = T0 + WINDOW_MS - 1; // เหลืออีก 1 ms
    const thrown = thrownBy(u) as GraphQLError;
    expect(thrown.extensions.retryAfterSeconds).toBe(1);
  });

  // ─── หายเองเมื่อพ้นหน้าต่าง ───────────────────────────────────────────
  it('พ้นหน้าต่างเวลาแล้วเรียกได้อีก (ไม่ใช่บล็อกถาวร)', () => {
    const u = makeUser('patient');
    for (let i = 0; i < JOIN_RATE_LIMIT_PER_USER; i++) call(u);
    expect(call(u)).toBe(FG_ERROR.JOIN_LINK_RATE_LIMITED);

    now = T0 + WINDOW_MS;
    expect(call(u)).toBe('OK');
  });

  it('ครั้งที่ถูกปฏิเสธต่อผู้ใช้ ไม่ไปกินโควตาต่อ IP ของคนอื่นที่ใช้ IP เดียวกัน', () => {
    const ip = '203.0.113.77';
    const hammer = makeUser('hammer-shared-ip');
    for (let i = 0; i < JOIN_RATE_LIMIT_PER_USER; i++) call(hammer, ip);
    // ยิงต่ออีกเยอะ ๆ — ถูกปฏิเสธหมด และต้องไม่ถูกนับเข้าตัวนับของ IP
    for (let i = 0; i < JOIN_RATE_LIMIT_PER_IP; i++) {
      expect(call(hammer, ip)).toBe(FG_ERROR.JOIN_LINK_RATE_LIMITED);
    }

    // คนในบ้านเดียวกันยังใช้ได้ เพราะ IP ถูกนับไปแค่ JOIN_RATE_LIMIT_PER_USER ครั้ง
    expect(call(makeUser('family-member'), ip)).toBe('OK');
  });

  // ─── ลำดับ guard ผิด ───────────────────────────────────────────────────
  it('ไม่มี req.user (ลืมวางไว้หลัง SupabaseAuthGuard) → ปฏิเสธ ไม่ใช่ปล่อยผ่าน', () => {
    asRequest(undefined);
    expect(() => guard.canActivate(mockExecutionContext)).toThrow(
      ForbiddenException,
    );
  });
});
