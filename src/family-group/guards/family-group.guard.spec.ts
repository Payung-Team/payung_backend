/**
 * Unit tests สำหรับ FamilyGroupGuard (PYG-412)
 *
 * ครอบคลุม DoD ของการ์ด:
 *   ✅ @GroupRole('OWNER'|'MEMBER') ใช้งานได้จริง
 *   ✅ ตรวจสิทธิ์เทียบกับ status = 'ACTIVE' เท่านั้น (REMOVED/LEFT ต้องหมดสิทธิ์ทันที)
 *   ✅ โหลดสมาชิกภาพ "ครั้งเดียวต่อ request" แล้วเก็บใน GraphQL context (กัน N+1)
 *   ✅ ประกอบร่างกับ RolesGuard เดิมได้ (ไม่มี @GroupRole → ปล่อยผ่าน)
 *
 * วิธี mock GraphQL context ยืมแพตเทิร์นเดียวกับ roles.guard.spec.ts:
 *   spy ที่ GqlExecutionContext.create แทนการปั้น ExecutionContext ครบทุกเมธอด
 */
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { FamilyGroupGuard } from './family-group.guard';
import { PrismaService } from '../../common/prisma.service';
import { GROUP_ROLE, MEMBER_STATUS } from '../family-group.constants';
import { FG_ERROR } from '../family-group.errors';
import { GROUP_MEMBERSHIP_CACHE } from '../types/group-membership.type';
import { AuthUser } from '../../common/decorators/current-user.decorator';

const GROUP_ID = '11111111-1111-1111-1111-111111111111';
const OWNER_ID = 'u-owner';
const MEMBER_ID = 'u-member';

const makeUser = (id: string): AuthUser => ({
  id,
  supabaseUid: `sb-${id}`,
  email: `${id}@payung.app`,
  role: 1,
  isSuspended: false,
});

/** แถว family_group_members ที่ guard select ออกมา */
const memberRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'fgm-1',
  groupId: GROUP_ID,
  userId: OWNER_ID,
  role: GROUP_ROLE.OWNER,
  status: MEMBER_STATUS.ACTIVE,
  ...overrides,
});

describe('FamilyGroupGuard', () => {
  let guard: FamilyGroupGuard;
  let reflector: jest.Mocked<Reflector>;
  let prisma: { familyGroupMember: { findUnique: jest.Mock } };

  // req ตัวจริงของแต่ละเทสต์ — เก็บไว้ตรวจ cache หลัง guard ทำงาน
  let req: Record<string, unknown>;

  const mockExecutionContext = {
    getHandler: jest.fn(() => ({})),
    getClass: jest.fn(() => ({})),
  } as unknown as ExecutionContext;

  /** stub GqlExecutionContext ให้คืน user + args ที่ต้องการ (ใช้ req ตัวเดิมทุกครั้ง) */
  const stubGqlContext = (
    user: AuthUser | undefined,
    args: Record<string, unknown>,
  ) => {
    req = { user };
    jest.spyOn(GqlExecutionContext, 'create').mockReturnValue({
      getContext: () => ({ req }),
      getArgs: () => args,
    } as unknown as GqlExecutionContext);
  };

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn(),
    } as unknown as jest.Mocked<Reflector>;
    prisma = { familyGroupMember: { findUnique: jest.fn() } };
    guard = new FamilyGroupGuard(reflector, prisma as unknown as PrismaService);
  });

  afterEach(() => jest.restoreAllMocks());

  // ─── ไม่มี @GroupRole → ไม่ใช่หน้าที่ guard นี้ ─────────────────────────
  it('ปล่อยผ่านทันทีเมื่อ resolver ไม่ได้ติด @GroupRole (ประกอบร่างกับ RolesGuard ได้)', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    stubGqlContext(makeUser(OWNER_ID), { groupId: GROUP_ID });

    await expect(guard.canActivate(mockExecutionContext)).resolves.toBe(true);
    // สำคัญ: ต้องไม่ยิงดีบีเลย ไม่งั้นทุก resolver ในระบบจะมีคิวรี่เกินมาฟรี ๆ
    expect(prisma.familyGroupMember.findUnique).not.toHaveBeenCalled();
  });

  // ─── ลำดับ guard ผิด (ไม่มี req.user) ──────────────────────────────────
  it('ปฏิเสธเมื่อไม่มี req.user (ลืมใส่ SupabaseAuthGuard ไว้ข้างหน้า)', async () => {
    reflector.getAllAndOverride.mockReturnValue({
      role: GROUP_ROLE.MEMBER,
      idArg: 'groupId',
    });
    stubGqlContext(undefined, { groupId: GROUP_ID });

    await expect(guard.canActivate(mockExecutionContext)).rejects.toThrow(
      ForbiddenException,
    );
  });

  // ─── หา groupId ไม่เจอ = บั๊กฝั่งเรา ต้องปฏิเสธ ไม่ใช่ปล่อยผ่าน ────────
  it('ปฏิเสธเมื่อหา argument groupId ไม่เจอ (กันปล่อยผ่านโดยไม่มีใครตรวจสิทธิ์)', async () => {
    reflector.getAllAndOverride.mockReturnValue({
      role: GROUP_ROLE.OWNER,
      idArg: 'groupId',
    });
    stubGqlContext(makeUser(OWNER_ID), { input: { name: 'บ้านยาย' } });

    await expect(guard.canActivate(mockExecutionContext)).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.familyGroupMember.findUnique).not.toHaveBeenCalled();
  });

  // ─── หา groupId จากทั้งสองรูปแบบที่โปรเจกต์ใช้จริง ─────────────────────
  it.each([
    ['args ระดับบนสุด (query)', { groupId: GROUP_ID }],
    ['args.input (mutation)', { input: { groupId: GROUP_ID } }],
  ])('อ่าน groupId จาก %s ได้', async (_label, args) => {
    reflector.getAllAndOverride.mockReturnValue({
      role: GROUP_ROLE.MEMBER,
      idArg: 'groupId',
    });
    prisma.familyGroupMember.findUnique.mockResolvedValue(memberRow());
    stubGqlContext(makeUser(OWNER_ID), args);

    await expect(guard.canActivate(mockExecutionContext)).resolves.toBe(true);
    expect(prisma.familyGroupMember.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { groupId_userId: { groupId: GROUP_ID, userId: OWNER_ID } },
      }),
    );
  });

  // ─── สิทธิ์: MEMBER = "อย่างน้อยเป็นสมาชิก" ────────────────────────────
  it('@GroupRole(MEMBER): เจ้าของก็ผ่าน (OWNER สูงกว่า MEMBER)', async () => {
    reflector.getAllAndOverride.mockReturnValue({
      role: GROUP_ROLE.MEMBER,
      idArg: 'groupId',
    });
    prisma.familyGroupMember.findUnique.mockResolvedValue(memberRow());
    stubGqlContext(makeUser(OWNER_ID), { groupId: GROUP_ID });

    await expect(guard.canActivate(mockExecutionContext)).resolves.toBe(true);
  });

  // ─── สิทธิ์: OWNER = "เจ้าของเท่านั้น" ─────────────────────────────────
  it('@GroupRole(OWNER): สมาชิกธรรมดาโดนปฏิเสธด้วย NOT_GROUP_OWNER', async () => {
    reflector.getAllAndOverride.mockReturnValue({
      role: GROUP_ROLE.OWNER,
      idArg: 'groupId',
    });
    prisma.familyGroupMember.findUnique.mockResolvedValue(
      memberRow({ userId: MEMBER_ID, role: GROUP_ROLE.MEMBER }),
    );
    stubGqlContext(makeUser(MEMBER_ID), { groupId: GROUP_ID });

    await expect(guard.canActivate(mockExecutionContext)).rejects.toMatchObject(
      { extensions: { code: FG_ERROR.NOT_GROUP_OWNER } },
    );
  });

  // ─── A3: คนที่ถูกเตะ/ออกไปแล้ว ต้องหมดสิทธิ์ "ทันที" ───────────────────
  it.each([MEMBER_STATUS.REMOVED, MEMBER_STATUS.LEFT])(
    'สมาชิกสถานะ %s หมดสิทธิ์ทันที → NOT_A_MEMBER',
    async (status) => {
      reflector.getAllAndOverride.mockReturnValue({
        role: GROUP_ROLE.MEMBER,
        idArg: 'groupId',
      });
      prisma.familyGroupMember.findUnique.mockResolvedValue(
        memberRow({ userId: MEMBER_ID, role: GROUP_ROLE.MEMBER, status }),
      );
      stubGqlContext(makeUser(MEMBER_ID), { groupId: GROUP_ID });

      await expect(
        guard.canActivate(mockExecutionContext),
      ).rejects.toMatchObject({ extensions: { code: FG_ERROR.NOT_A_MEMBER } });
    },
  );

  // ─── คนนอกกลุ่ม: ต้องไม่รู้ว่ากลุ่มมีอยู่จริงหรือไม่ ────────────────────
  it('คนที่ไม่มีแถวสมาชิกเลย → NOT_A_MEMBER (ไม่บอกว่ากลุ่มมีอยู่จริงไหม)', async () => {
    reflector.getAllAndOverride.mockReturnValue({
      role: GROUP_ROLE.MEMBER,
      idArg: 'groupId',
    });
    prisma.familyGroupMember.findUnique.mockResolvedValue(null);
    stubGqlContext(makeUser('u-stranger'), { groupId: GROUP_ID });

    await expect(guard.canActivate(mockExecutionContext)).rejects.toMatchObject(
      { extensions: { code: FG_ERROR.NOT_A_MEMBER } },
    );
  });

  // ─── ข้อกำหนดหลักของการ์ด: โหลดครั้งเดียวต่อ request ───────────────────
  it('โหลดสมาชิกภาพครั้งเดียวต่อ request แล้วใช้ cache ต่อ (กัน N+1)', async () => {
    reflector.getAllAndOverride.mockReturnValue({
      role: GROUP_ROLE.MEMBER,
      idArg: 'groupId',
    });
    prisma.familyGroupMember.findUnique.mockResolvedValue(memberRow());
    stubGqlContext(makeUser(OWNER_ID), { groupId: GROUP_ID });

    // เรียกซ้ำ 3 ครั้งบน request เดียวกัน (จำลอง resolver หลายตัวใน 1 เอกสาร)
    await guard.canActivate(mockExecutionContext);
    await guard.canActivate(mockExecutionContext);
    await guard.canActivate(mockExecutionContext);

    expect(prisma.familyGroupMember.findUnique).toHaveBeenCalledTimes(1);
  });

  it('เก็บผลไว้ใน req เพื่อให้ @GroupMembership() หยิบไปใช้ต่อได้', async () => {
    reflector.getAllAndOverride.mockReturnValue({
      role: GROUP_ROLE.OWNER,
      idArg: 'groupId',
    });
    prisma.familyGroupMember.findUnique.mockResolvedValue(memberRow());
    stubGqlContext(makeUser(OWNER_ID), { groupId: GROUP_ID });

    await guard.canActivate(mockExecutionContext);

    const cache = req[GROUP_MEMBERSHIP_CACHE] as Map<string, unknown>;
    expect(cache.get(GROUP_ID)).toEqual({
      membershipId: 'fgm-1',
      groupId: GROUP_ID,
      userId: OWNER_ID,
      role: GROUP_ROLE.OWNER,
    });
  });
});
