/**
 * Unit tests สำหรับ SuperAdminGuard (PYG-152)
 *
 * เทสต์เน้น behavior หลักของ shorthand guard:
 *   - role=4 (super_admin) → ปล่อยผ่าน
 *   - role=3 (admin) → 403 (admin ไม่มีสิทธิ์ super admin route)
 *   - role อื่น (patient, caregiver) → 403
 *   - ไม่มี user (auth missing) → 403
 *
 * Mocking strategy เหมือน roles.guard.spec.ts:
 *   spy ที่ GqlExecutionContext.create เพื่อ inject user ที่ต้องการเทสต์
 */
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { SuperAdminGuard, SUPER_ADMIN_ROLE } from './super-admin.guard';
import { AuthUser } from '../decorators/current-user.decorator';
import { ROLE_ID } from '../constants/roles.constant';

describe('SuperAdminGuard', () => {
  let guard: SuperAdminGuard;

  // ExecutionContext แบบ minimal — SuperAdminGuard ไม่ได้ใช้ reflector
  // ไม่ต้อง stub getHandler/getClass แต่ใส่ไว้กันบาง type-checker
  const mockExecutionContext = {
    getHandler: jest.fn(() => ({})),
    getClass: jest.fn(() => ({})),
  } as unknown as ExecutionContext;

  const stubGqlContext = (user: AuthUser | undefined) => {
    jest.spyOn(GqlExecutionContext, 'create').mockReturnValue({
      getContext: () => ({ req: { user } }),
    } as unknown as GqlExecutionContext);
  };

  const makeUser = (role: number): AuthUser => ({
    id: 'user-uuid-1',
    supabaseUid: 'supabase-uid-2',
    email: 'test@payung.app',
    role,
    isSuspended: false,
  });

  beforeEach(() => {
    guard = new SuperAdminGuard();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── Sanity check: constant ตรงกับ ROLE_ID.SUPER_ADMIN ──
  it('SUPER_ADMIN_ROLE constant ต้องตรงกับ ROLE_ID.SUPER_ADMIN', () => {
    // ป้องกัน drift ระหว่าง 2 ที่ — ถ้ามีคนเปลี่ยน ROLE_ID.SUPER_ADMIN เป็นเลขอื่น
    // โดยไม่ได้แก้ SUPER_ADMIN_ROLE ตาม → test นี้จะแดง
    expect(SUPER_ADMIN_ROLE).toBe(ROLE_ID.SUPER_ADMIN);
  });

  // ── Test 1: super admin → ผ่าน ──
  it('returns true เมื่อ user เป็น super admin (role=4)', () => {
    stubGqlContext(makeUser(ROLE_ID.SUPER_ADMIN));

    expect(guard.canActivate(mockExecutionContext)).toBe(true);
  });

  // ── Test 2: admin → 403 ──
  it('throws ForbiddenException("Super admin access required") เมื่อ user เป็น admin (role=3)', () => {
    stubGqlContext(makeUser(ROLE_ID.ADMIN));

    expect(() => guard.canActivate(mockExecutionContext)).toThrow(
      ForbiddenException,
    );
    expect(() => guard.canActivate(mockExecutionContext)).toThrow(
      'Super admin access required',
    );
  });

  // ── Test 3: caregiver/patient → 403 ──
  it.each([
    ['patient', ROLE_ID.PATIENT],
    ['caregiver', ROLE_ID.CAREGIVER],
  ])('throws ForbiddenException เมื่อ user เป็น %s', (_label, roleId) => {
    stubGqlContext(makeUser(roleId));

    expect(() => guard.canActivate(mockExecutionContext)).toThrow(
      'Super admin access required',
    );
  });

  // ── Test 4: ไม่มี user → 403 ──
  it('throws ForbiddenException("Authentication required") เมื่อไม่มี user ใน request', () => {
    stubGqlContext(undefined);

    expect(() => guard.canActivate(mockExecutionContext)).toThrow(
      ForbiddenException,
    );
    expect(() => guard.canActivate(mockExecutionContext)).toThrow(
      'Authentication required',
    );
  });
});
