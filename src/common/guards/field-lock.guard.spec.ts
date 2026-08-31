/**
 * Unit tests สำหรับ FieldLockGuard (PYG-146)
 *
 * ครอบคลุม Definition of Done ของ PYG-146:
 *   ✅ แก้ field ที่ถูก lock → ได้ error FIELD_LOCKED          — Test 4, 5
 *   ✅ แก้ field ที่ไม่ถูก lock → ทำงานปกติ                    — Test 3
 *   ✅ Partial update ได้ (lock บาง field ไม่ block ทั้ง mutation) — Test 5
 *
 * วิธี mock GraphQL context (เหมือน roles.guard.spec.ts):
 *   - jest.spyOn(GqlExecutionContext, 'create') เพื่อ override getContext + getArgs
 *     แทนการ build ExecutionContext เต็มรูปแบบ (เยอะเกินไป)
 */
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { FieldLockGuard } from './field-lock.guard';
import { FIELD_LOCK_ENTITY_KEY } from '../decorators/field-lock.decorator';
import { FieldLockedError } from '../exceptions/field-locked.exception';
import { PrismaService } from '../prisma.service';
import { AuthUser } from '../decorators/current-user.decorator';

describe('FieldLockGuard', () => {
  let guard: FieldLockGuard;
  let reflector: jest.Mocked<Reflector>;
  let prisma: {
    caregiver: { findUnique: jest.Mock };
    field_locks: { findMany: jest.Mock };
  };

  // mock ExecutionContext — แค่ stub method ที่ guard เรียก (getHandler, getClass)
  const mockExecutionContext = {
    getHandler: jest.fn(() => ({})),
    getClass: jest.fn(() => ({})),
  } as unknown as ExecutionContext;

  // user ที่ SupabaseAuthGuard จะ inject จริง
  const makeUser = (): AuthUser => ({
    id: 'user-uuid-123',
    supabaseUid: 'supabase-uid-456',
    email: 'test@payung.app',
    role: 1,
    isSuspended: false,
  });

  /**
   * stub GqlExecutionContext.create → คืน user + args ที่กำหนด
   * user = undefined  → จำลองว่ายังไม่ผ่าน SupabaseAuthGuard
   */
  const stubGqlContext = (
    user: AuthUser | undefined,
    input: Record<string, unknown> | undefined,
  ) => {
    jest.spyOn(GqlExecutionContext, 'create').mockReturnValue({
      getContext: () => ({ req: { user } }),
      getArgs: () => ({ input }),
    } as unknown as GqlExecutionContext);
  };

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn(),
    } as unknown as jest.Mocked<Reflector>;
    prisma = {
      caregiver: { findUnique: jest.fn() },
      field_locks: { findMany: jest.fn() },
    };
    guard = new FieldLockGuard(reflector, prisma as unknown as PrismaService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── Test 1: ไม่มี @FieldLock() → ปล่อยผ่าน (mutation ไม่เกี่ยวกับ lock) ──
  it('returns true เมื่อไม่มี @FieldLock() metadata', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);

    await expect(guard.canActivate(mockExecutionContext)).resolves.toBe(true);
    expect(reflector.getAllAndOverride.mock.calls[0][0]).toBe(
      FIELD_LOCK_ENTITY_KEY,
    );
  });

  // ── Test 2: มี @FieldLock() แต่ไม่มี user → 403 (ลืมใส่ SupabaseAuthGuard) ──
  it('throws ForbiddenException เมื่อไม่มี user ใน request', async () => {
    reflector.getAllAndOverride.mockReturnValue('USER');
    stubGqlContext(undefined, { phone: '0812345678' });

    await expect(guard.canActivate(mockExecutionContext)).rejects.toThrow(
      ForbiddenException,
    );
  });

  // ── Test 3: แก้ field ที่ไม่ถูก lock → ผ่าน (DoD: edit non-locked → ปกติ) ──
  it('returns true เมื่อ field ที่ส่งมาไม่มีตัวไหนถูก lock', async () => {
    reflector.getAllAndOverride.mockReturnValue('USER');
    stubGqlContext(makeUser(), { bio: 'อัปเดตประวัติ' });
    // lock 'phone' ไว้ แต่ client ส่ง 'bio' มา → ไม่ชน
    prisma.field_locks.findMany.mockResolvedValue([
      {
        field_name: 'phone',
        users_field_locks_locked_byTousers: { displayName: 'Admin Jane' },
      },
    ]);

    await expect(guard.canActivate(mockExecutionContext)).resolves.toBe(true);
  });

  // ── Test 4: แก้ field ที่ถูก lock → FIELD_LOCKED (DoD: edit locked → error) ──
  it('throws FieldLockedError พร้อม extensions ตรง contract เมื่อแก้ field ที่ถูก lock', async () => {
    reflector.getAllAndOverride.mockReturnValue('USER');
    stubGqlContext(makeUser(), { phone: '0899999999' });
    prisma.field_locks.findMany.mockResolvedValue([
      {
        field_name: 'phone',
        users_field_locks_locked_byTousers: { displayName: 'Admin Jane' },
      },
    ]);

    await expect(
      guard.canActivate(mockExecutionContext),
    ).rejects.toBeInstanceOf(FieldLockedError);

    await expect(guard.canActivate(mockExecutionContext)).rejects.toMatchObject(
      {
        extensions: {
          code: 'FIELD_LOCKED',
          lockedFields: ['phone'],
          lockedBy: 'Admin Jane',
        },
      },
    );
  });

  // ── Test 5: ส่ง field ถูก lock + ไม่ถูก lock ปนกัน ──
  // → block ทั้ง mutation, แต่ lockedFields ต้องมีเฉพาะตัวที่ถูก lock
  // (DoD: partial update — lock บาง field ไม่ทำให้ field อื่นหลุด contract)
  it('รายงานเฉพาะ field ที่ถูก lock เมื่อ input มีทั้ง locked + non-locked', async () => {
    reflector.getAllAndOverride.mockReturnValue('USER');
    stubGqlContext(makeUser(), {
      phone: '0899999999', // ถูก lock
      bio: 'แก้ bio ได้', // ไม่ถูก lock
    });
    prisma.field_locks.findMany.mockResolvedValue([
      {
        field_name: 'phone',
        users_field_locks_locked_byTousers: { displayName: 'Admin Jane' },
      },
    ]);

    await expect(guard.canActivate(mockExecutionContext)).rejects.toMatchObject(
      {
        extensions: {
          code: 'FIELD_LOCKED',
          lockedFields: ['phone'], // bio ต้องไม่อยู่ในนี้
          lockedBy: 'Admin Jane',
        },
      },
    );
  });

  // ── Test 6: entity ไม่มี active lock เลย → ผ่าน ──
  it('returns true เมื่อ field_locks ไม่มี active lock', async () => {
    reflector.getAllAndOverride.mockReturnValue('USER');
    stubGqlContext(makeUser(), { phone: '0812345678' });
    prisma.field_locks.findMany.mockResolvedValue([]);

    await expect(guard.canActivate(mockExecutionContext)).resolves.toBe(true);
  });

  // ── Test 7: CAREGIVER_PROFILE แต่ยังไม่มี caregiver row → ผ่าน ──
  it('returns true เมื่อ entity=CAREGIVER_PROFILE แต่ยังไม่มี caregiver profile', async () => {
    reflector.getAllAndOverride.mockReturnValue('CAREGIVER_PROFILE');
    stubGqlContext(makeUser(), { hourlyRate: 200 });
    prisma.caregiver.findUnique.mockResolvedValue(null);

    await expect(guard.canActivate(mockExecutionContext)).resolves.toBe(true);
    // ไม่มี caregiver → ต้องไม่ไป query field_locks เลย
    expect(prisma.field_locks.findMany).not.toHaveBeenCalled();
  });

  // ── Test 8: CAREGIVER_PROFILE มี lock → ค้นด้วย caregivers.id (ไม่ใช่ users.id) ──
  it('ใช้ caregivers.id เป็น entity_id เมื่อ entity=CAREGIVER_PROFILE', async () => {
    reflector.getAllAndOverride.mockReturnValue('CAREGIVER_PROFILE');
    stubGqlContext(makeUser(), { hourlyRate: 200 });
    prisma.caregiver.findUnique.mockResolvedValue({ id: 'caregiver-uuid-999' });
    prisma.field_locks.findMany.mockResolvedValue([
      {
        field_name: 'hourlyRate',
        users_field_locks_locked_byTousers: { displayName: 'Admin Bob' },
      },
    ]);

    await expect(guard.canActivate(mockExecutionContext)).rejects.toMatchObject(
      {
        extensions: {
          code: 'FIELD_LOCKED',
          lockedFields: ['hourlyRate'],
          lockedBy: 'Admin Bob',
        },
      },
    );
    expect(prisma.field_locks.findMany).toHaveBeenCalledWith({
      where: {
        entity_type: 'CAREGIVER_PROFILE',
        entity_id: 'caregiver-uuid-999',
        unlocked_at: null,
      },
      select: {
        field_name: true,
        users_field_locks_locked_byTousers: {
          select: { displayName: true },
        },
      },
    });
  });
});
