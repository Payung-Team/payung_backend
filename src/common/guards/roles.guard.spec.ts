/**
 * Unit tests สำหรับ RolesGuard (PYG-152)
 *
 * ครอบคลุม DoD ของ PYG-152:
 *   ✅ @Roles decorator ใช้งานได้กับทุก resolver        — verify ผ่าน reflector.getAllAndOverride
 *   ✅ Admin เข้า Super Admin route → 403               — role=3 vs required=[4]
 *   ✅ Super Admin เข้าได้ปกติ                          — role=4 vs required=[4]
 *   ✅ Unit test สำหรับ RolesGuard                      — ไฟล์นี้
 *
 * วิธี mock GraphQL context:
 *   - ใช้ jest.spyOn(GqlExecutionContext, 'create') เพื่อ override การ extract user
 *     แทนที่จะ build mock ExecutionContext ครบทุก method (เยอะเกินไป)
 *   - Pattern นี้ตรงกับวิธีที่ roles.guard.ts ใช้จริงในบรรทัด 34-35
 */
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { AuthUser } from '../decorators/current-user.decorator';
import { ROLE_ID } from '../constants/roles.constant';

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: jest.Mocked<Reflector>;

  // mock ExecutionContext — แค่ stub method ที่ guard เรียกใช้ (getHandler, getClass)
  // ส่วน GqlExecutionContext.create จะถูก spy ทับเพื่อ inject user ที่ต้องการ
  const mockExecutionContext = {
    getHandler: jest.fn(() => ({})),
    getClass: jest.fn(() => ({})),
  } as unknown as ExecutionContext;

  /**
   * Helper — stub GqlExecutionContext.create ให้คืน user ที่กำหนด
   * ถ้าส่ง undefined = simulate ว่ายังไม่ผ่าน SupabaseAuthGuard (ไม่มี user ใน req)
   */
  const stubGqlContext = (user: AuthUser | undefined) => {
    jest.spyOn(GqlExecutionContext, 'create').mockReturnValue({
      getContext: () => ({ req: { user } }),
    } as unknown as GqlExecutionContext);
  };

  // mock user สำหรับใช้ในเทสต์ (เป็นโครงที่ SupabaseAuthGuard จะ inject จริงๆ)
  const makeUser = (role: number): AuthUser => ({
    id: 'user-uuid-123',
    supabaseUid: 'supabase-uid-456',
    email: 'test@payung.app',
    role,
    isSuspended: false,
  });

  beforeEach(() => {
    // สร้าง Reflector mock ใหม่ทุก test เพื่อกัน state ปนกัน
    reflector = {
      getAllAndOverride: jest.fn(),
    } as unknown as jest.Mocked<Reflector>;
    guard = new RolesGuard(reflector);
  });

  afterEach(() => {
    // เคลียร์ spyOn ทุกตัวเพื่อไม่ให้รั่วข้าม test
    jest.restoreAllMocks();
  });

  // ── Test 1: ไม่ได้ใส่ @Roles() → ปล่อยผ่าน ──
  it('returns true เมื่อไม่มี @Roles() metadata (reflector คืน undefined)', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);

    const result = guard.canActivate(mockExecutionContext);

    expect(result).toBe(true);
    // ยืนยันว่า guard เรียก reflector ด้วย ROLES_KEY (ไม่ใช่ key ผิด)
    // อ่านผ่าน .mock.calls (ไม่ใช่ method reference) เพื่อกัน ESLint unbound-method
    expect(reflector.getAllAndOverride.mock.calls[0][0]).toBe(ROLES_KEY);
  });

  // ── Test 2: @Roles() ว่างเปล่า → ปล่อยผ่าน ──
  it('returns true เมื่อ @Roles() ส่ง array ว่าง', () => {
    reflector.getAllAndOverride.mockReturnValue([]);

    const result = guard.canActivate(mockExecutionContext);

    expect(result).toBe(true);
  });

  // ── Test 3: role ตรงกับที่ require → ปล่อยผ่าน (DoD: Super Admin เข้าได้ปกติ) ──
  it('returns true เมื่อ user.role ตรงกับ required role (Super Admin → Super Admin route)', () => {
    reflector.getAllAndOverride.mockReturnValue([ROLE_ID.SUPER_ADMIN]);
    stubGqlContext(makeUser(ROLE_ID.SUPER_ADMIN));

    expect(guard.canActivate(mockExecutionContext)).toBe(true);
  });

  // ── Test 4: role ไม่ตรง → 403 (DoD: Admin เข้า Super Admin route → 403) ──
  it('throws ForbiddenException เมื่อ admin เข้า super admin route', () => {
    reflector.getAllAndOverride.mockReturnValue([ROLE_ID.SUPER_ADMIN]);
    stubGqlContext(makeUser(ROLE_ID.ADMIN));

    // ใช้ () => guard.canActivate(...) เพราะ Jest ต้อง wrap ใน function ถึงจะจับ exception ได้
    expect(() => guard.canActivate(mockExecutionContext)).toThrow(
      ForbiddenException,
    );
    expect(() => guard.canActivate(mockExecutionContext)).toThrow(
      'Access denied. Required role: 4',
    );
  });

  // ── Test 5: required หลาย role → user role หนึ่งในนั้น = ผ่าน ──
  // (อ้างอิง pattern จาก PYG-145: @Roles(SUPER_ADMIN, ADMIN))
  it('returns true เมื่อ user.role อยู่ใน list ของ required roles', () => {
    reflector.getAllAndOverride.mockReturnValue([
      ROLE_ID.SUPER_ADMIN,
      ROLE_ID.ADMIN,
    ]);
    stubGqlContext(makeUser(ROLE_ID.ADMIN));

    expect(guard.canActivate(mockExecutionContext)).toBe(true);
  });

  // ── Test 6: ไม่มี user ใน context → 403 (กรณี developer ลืมใส่ SupabaseAuthGuard) ──
  it('throws ForbiddenException("Authentication required") เมื่อไม่มี user ใน request', () => {
    reflector.getAllAndOverride.mockReturnValue([ROLE_ID.SUPER_ADMIN]);
    stubGqlContext(undefined);

    expect(() => guard.canActivate(mockExecutionContext)).toThrow(
      ForbiddenException,
    );
    expect(() => guard.canActivate(mockExecutionContext)).toThrow(
      'Authentication required',
    );
  });

  // ── Test 7: error message format ถูกต้องเมื่อ require หลาย role ──
  it('error message รวมทุก role ที่ require ด้วย "or" เมื่อ user ไม่มี role ที่ต้องการ', () => {
    reflector.getAllAndOverride.mockReturnValue([
      ROLE_ID.SUPER_ADMIN,
      ROLE_ID.ADMIN,
    ]);
    stubGqlContext(makeUser(ROLE_ID.CAREGIVER));

    expect(() => guard.canActivate(mockExecutionContext)).toThrow(
      'Access denied. Required role: 4 or 3',
    );
  });
});
