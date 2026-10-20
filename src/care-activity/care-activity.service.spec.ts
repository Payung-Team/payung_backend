/**
 * CareActivityService — unit tests (PYG-634 · S15 · contract PYG-632)
 *
 * ครอบคลุม: R5/E4 (activeList) · R3 ฝั่ง service ไม่มี (สิทธิ์อยู่ที่ RolesGuard ของ resolver)
 *   E3 ชื่อซ้ำ (ก่อนเขียน + unique ของ DB) · ระดับนอก 3 ค่า · ช่องบังคับ · updated_at
 *   resolveForBooking: E2 ปิดใช้งาน · ไม่มีอยู่ · E8 ซ้ำ · E9 ว่าง · listForBooking อ่านจากสำเนา (R6 / E1)
 */
import { UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CareActivityService } from './care-activity.service';
import { CareActivityError } from './care-activity.errors';
import { CareLevel } from '../common/care-level/care-level';
import type { PrismaService } from '../common/prisma.service';
import type { ClockService } from '../common/clock.service';

const NOW = new Date('2026-10-20T05:00:00.000Z');
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_C = '33333333-3333-4333-8333-333333333333';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: ID_A,
    code: 'A01',
    nameTh: 'พยุงเดิน',
    nameEn: 'Walking assistance',
    category: 'การเคลื่อนไหว',
    careLevel: 'basic',
    isActive: true,
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** argument ตัวแรกของการเรียกครั้งที่ n */
function firstArg<T = Record<string, any>>(mock: jest.Mock, call = 0): T {
  return (mock.mock.calls[call] as unknown[])[0] as T;
}

async function errorOf(p: Promise<unknown>): Promise<CareActivityError> {
  try {
    await p;
  } catch (err) {
    return err as CareActivityError;
  }
  throw new Error('ควร throw');
}

describe('CareActivityService (PYG-634)', () => {
  let service: CareActivityService;
  let prisma: {
    careActivity: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      aggregate: jest.Mock;
    };
    bookingActivity: { findMany: jest.Mock };
  };
  let tx: { $queryRaw: jest.Mock; bookingActivity: { createMany: jest.Mock } };

  beforeEach(() => {
    prisma = {
      careActivity: {
        findMany: jest.fn().mockResolvedValue([row()]),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(row()),
        create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(row({ id: ID_B, code: null, ...data })),
        ),
        update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(row(data)),
        ),
        aggregate: jest.fn().mockResolvedValue({ _max: { sortOrder: 4 } }),
      },
      bookingActivity: { findMany: jest.fn().mockResolvedValue([]) },
    };
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      bookingActivity: { createMany: jest.fn() },
    };
    service = new CareActivityService(
      prisma as unknown as PrismaService,
      { now: () => NOW } as unknown as ClockService,
    );
  });

  describe('activeList (หน้าจอง)', () => {
    it('ขอเฉพาะที่เปิดใช้งาน เรียงหมวด → sortOrder และแปลงระดับเป็น enum', async () => {
      const result = await service.activeList();
      expect(prisma.careActivity.findMany).toHaveBeenCalledWith({
        where: { isActive: true },
        orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }, { nameTh: 'asc' }],
      });
      expect(result[0]).toMatchObject({
        id: ID_A,
        careLevel: CareLevel.BASIC,
        isActive: true,
      });
    });

    it('E5: ไม่มีกิจกรรมเลย → [] ไม่ใช่ error', async () => {
      prisma.careActivity.findMany.mockResolvedValue([]);
      await expect(service.activeList()).resolves.toEqual([]);
    });
  });

  describe('adminList', () => {
    it('ไม่มีตัวกรอง = ทุกแถว รวมที่ปิดใช้งาน', async () => {
      await service.adminList();
      expect(
        firstArg<{ where: Record<string, unknown> }>(
          prisma.careActivity.findMany,
        ).where,
      ).toEqual({});
    });

    it('กรองหมวด / ระดับ (รับค่า GraphQL) / สถานะ / คำค้น', async () => {
      await service.adminList({
        category: ' การเคลื่อนไหว ',
        careLevel: 'ADVANCED',
        isActive: false,
        search: 'พยุง',
      });
      const where = firstArg<{ where: Record<string, unknown> }>(
        prisma.careActivity.findMany,
      ).where;
      expect(where).toMatchObject({
        category: 'การเคลื่อนไหว',
        careLevel: 'advanced',
        isActive: false,
      });
      expect(where.OR).toHaveLength(3);
    });

    it('ระดับนอก 3 ค่า → CARE_ACTIVITY_INVALID', async () => {
      const err = await errorOf(service.adminList({ careLevel: 'EXPERT' }));
      expect(err.extensions.code).toBe('CARE_ACTIVITY_INVALID');
    });
  });

  describe('create', () => {
    it('ตัดช่องว่าง · ระดับ GraphQL → DB · ไม่ส่ง sortOrder = ต่อท้ายหมวด · ตั้ง updated_at', async () => {
      const result = await service.create({
        nameTh: '  ป้อนอาหาร ',
        category: 'โภชนาการ',
        careLevel: 'INTERMEDIATE',
        nameEn: '  ',
      });
      expect(prisma.careActivity.create).toHaveBeenCalledWith({
        data: {
          nameTh: 'ป้อนอาหาร',
          nameEn: null,
          category: 'โภชนาการ',
          careLevel: 'intermediate',
          sortOrder: 5,
          createdAt: NOW,
          updatedAt: NOW,
        },
      });
      expect(result.careLevel).toBe(CareLevel.INTERMEDIATE);
    });

    it.each([
      [{ nameTh: '  ', category: 'x', careLevel: 'BASIC' }, 'nameTh'],
      [{ nameTh: 'x', category: '', careLevel: 'BASIC' }, 'category'],
      [{ nameTh: 'x', category: 'x', careLevel: 'basic' }, 'careLevel'],
      [
        { nameTh: 'ก'.repeat(201), category: 'x', careLevel: 'BASIC' },
        'nameTh',
      ],
    ])(
      'ค่าไม่ผ่าน %j → CARE_ACTIVITY_INVALID (%s) และไม่เขียน DB',
      async (input, field) => {
        const err = await errorOf(service.create(input));
        expect(err.extensions).toMatchObject({
          code: 'CARE_ACTIVITY_INVALID',
          field,
          statusCode: 422,
        });
        expect(prisma.careActivity.create).not.toHaveBeenCalled();
      },
    );

    it('E3: ชื่อซ้ำในหมวดเดียวกัน → CARE_ACTIVITY_DUPLICATE', async () => {
      prisma.careActivity.findFirst.mockResolvedValue({ id: ID_A });
      const err = await errorOf(
        service.create({
          nameTh: 'พยุงเดิน',
          category: 'การเคลื่อนไหว',
          careLevel: 'BASIC',
        }),
      );
      expect(err.extensions).toMatchObject({
        code: 'CARE_ACTIVITY_DUPLICATE',
        category: 'การเคลื่อนไหว',
        nameTh: 'พยุงเดิน',
      });
      expect(prisma.careActivity.create).not.toHaveBeenCalled();
    });

    it('E3: ชนกันระหว่างตรวจกับเขียน (unique ของ DB · P2002) → code เดียวกัน', async () => {
      prisma.careActivity.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'x',
        }),
      );
      const err = await errorOf(
        service.create({
          nameTh: 'พยุงเดิน',
          category: 'การเคลื่อนไหว',
          careLevel: 'BASIC',
          sortOrder: 1,
        }),
      );
      expect(err.extensions.code).toBe('CARE_ACTIVITY_DUPLICATE');
    });
  });

  describe('update', () => {
    it('E3: แก้ตัวเองโดยไม่เปลี่ยนชื่อ/หมวด → ไม่ตรวจซ้ำ ผ่าน · ตั้ง updated_at', async () => {
      await service.update(ID_A, { careLevel: 'ADVANCED' });
      expect(prisma.careActivity.findFirst).not.toHaveBeenCalled();
      expect(prisma.careActivity.update).toHaveBeenCalledWith({
        where: { id: ID_A },
        data: { careLevel: 'advanced', updatedAt: NOW },
      });
    });

    it('E3: เปลี่ยนชื่อชนกับกิจกรรมอื่นในหมวด → DUPLICATE (ตรวจโดยไม่นับตัวเอง)', async () => {
      prisma.careActivity.findFirst.mockResolvedValue({ id: ID_B });
      const err = await errorOf(service.update(ID_A, { nameTh: 'ป้อนอาหาร' }));
      expect(err.extensions.code).toBe('CARE_ACTIVITY_DUPLICATE');
      expect(prisma.careActivity.findFirst).toHaveBeenCalledWith({
        where: {
          category: 'การเคลื่อนไหว',
          nameTh: 'ป้อนอาหาร',
          NOT: { id: ID_A },
        },
        select: { id: true },
      });
      expect(prisma.careActivity.update).not.toHaveBeenCalled();
    });

    it('nameEn "" = ลบชื่ออังกฤษ', async () => {
      await service.update(ID_A, { nameEn: '' });
      expect(
        firstArg<{ data: Record<string, unknown> }>(prisma.careActivity.update)
          .data,
      ).toMatchObject({
        nameEn: null,
      });
    });

    it('ไม่พบ / id ไม่ใช่ uuid → CARE_ACTIVITY_NOT_FOUND', async () => {
      prisma.careActivity.findUnique.mockResolvedValue(null);
      expect(
        (await errorOf(service.update(ID_C, { nameTh: 'x' }))).extensions.code,
      ).toBe('CARE_ACTIVITY_NOT_FOUND');
      expect(
        (await errorOf(service.update('abc', { nameTh: 'x' }))).extensions.code,
      ).toBe('CARE_ACTIVITY_NOT_FOUND');
    });
  });

  describe('setActive', () => {
    it('ปิด/เปิดใช้งาน + updated_at (R4 ไม่มีลบ)', async () => {
      const result = await service.setActive(ID_A, false);
      expect(prisma.careActivity.update).toHaveBeenCalledWith({
        where: { id: ID_A },
        data: { isActive: false, updatedAt: NOW },
      });
      expect(result.isActive).toBe(false);
    });
  });

  describe('resolveForBooking (ใน transaction ของการจอง)', () => {
    const dbRow = (id: string, isActive = true) => ({
      id,
      name_th: `กิจกรรม ${id.slice(0, 1)}`,
      category: 'หมวด',
      care_level: 'intermediate',
      is_active: isActive,
    });

    it('E9: ไม่ส่ง / รายการว่าง → [] และไม่แตะ DB', async () => {
      await expect(
        service.resolveForBooking(tx as never, undefined),
      ).resolves.toEqual([]);
      await expect(service.resolveForBooking(tx as never, [])).resolves.toEqual(
        [],
      );
      expect(tx.$queryRaw).not.toHaveBeenCalled();
    });

    it('E8: id ซ้ำนับครั้งเดียว ลำดับตามที่ส่งครั้งแรก · ล็อกแถวด้วย FOR SHARE', async () => {
      tx.$queryRaw.mockResolvedValue([dbRow(ID_B), dbRow(ID_A)]);
      const result = await service.resolveForBooking(tx as never, [
        ID_A,
        ID_B,
        ID_A,
      ]);
      expect(result.map((r) => r.careActivityId)).toEqual([ID_A, ID_B]);
      expect(result[0]).toEqual({
        careActivityId: ID_A,
        activityName: 'กิจกรรม 1',
        category: 'หมวด',
        careLevel: 'intermediate',
      });
      const [strings, ids] = tx.$queryRaw.mock.calls[0] as [
        TemplateStringsArray,
        string[],
      ];
      expect(strings.join('?')).toContain('FOR SHARE');
      expect(ids).toEqual([ID_A, ID_B]);
    });

    it('E2: มีกิจกรรมที่ปิดใช้งาน → CARE_ACTIVITY_INACTIVE พร้อม id ที่ไม่ผ่าน', async () => {
      tx.$queryRaw.mockResolvedValue([dbRow(ID_A), dbRow(ID_B, false)]);
      const err = await errorOf(
        service.resolveForBooking(tx as never, [ID_A, ID_B]),
      );
      expect(err.extensions).toMatchObject({
        code: 'CARE_ACTIVITY_INACTIVE',
        activityIds: [ID_B],
        statusCode: 422,
      });
    });

    it('id ไม่มีอยู่ / ไม่ใช่ uuid → CARE_ACTIVITY_NOT_FOUND', async () => {
      tx.$queryRaw.mockResolvedValue([dbRow(ID_A)]);
      const missing = await errorOf(
        service.resolveForBooking(tx as never, [ID_A, ID_C]),
      );
      expect(missing.extensions).toMatchObject({
        code: 'CARE_ACTIVITY_NOT_FOUND',
        activityIds: [ID_C],
      });

      const malformed = await errorOf(
        service.resolveForBooking(tx as never, ['not-a-uuid']),
      );
      expect(malformed.extensions).toMatchObject({
        code: 'CARE_ACTIVITY_NOT_FOUND',
        activityIds: ['not-a-uuid'],
      });
    });
  });

  describe('writeForBooking / listForBooking (สำเนา · R6)', () => {
    it('เขียนสำเนาชื่อ หมวด ระดับ · ไม่มีกิจกรรม = ไม่เขียน', async () => {
      await service.writeForBooking(tx as never, 'b-1', []);
      expect(tx.bookingActivity.createMany).not.toHaveBeenCalled();

      await service.writeForBooking(tx as never, 'b-1', [
        {
          careActivityId: ID_A,
          activityName: 'พยุงเดิน',
          category: 'การเคลื่อนไหว',
          careLevel: 'basic',
        },
      ]);
      expect(tx.bookingActivity.createMany).toHaveBeenCalledWith({
        data: [
          {
            bookingId: 'b-1',
            careActivityId: ID_A,
            activityName: 'พยุงเดิน',
            category: 'การเคลื่อนไหว',
            careLevel: 'basic',
          },
        ],
      });
    });

    it('E1: อ่านจาก booking_activities เท่านั้น — ชื่อ/ระดับที่ถูกแก้ภายหลังไม่กระทบ', async () => {
      prisma.bookingActivity.findMany.mockResolvedValue([
        {
          careActivityId: ID_A,
          activityName: 'ชื่อตอนจอง',
          category: 'หมวดเดิม',
          careLevel: 'basic',
        },
      ]);
      const result = await service.listForBooking('b-1');
      expect(result).toEqual([
        {
          activityId: ID_A,
          name: 'ชื่อตอนจอง',
          category: 'หมวดเดิม',
          careLevel: CareLevel.BASIC,
        },
      ]);
      expect(prisma.careActivity.findMany).not.toHaveBeenCalled();
    });
  });

  it('toRestError: ทาง REST ได้ 422 ที่มี code และข้อมูลประกอบ', () => {
    const err = new CareActivityError('x', 'CARE_ACTIVITY_INACTIVE', {
      activityIds: [ID_A],
    }).toRestError();
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect(err.getResponse()).toMatchObject({
      statusCode: 422,
      code: 'CARE_ACTIVITY_INACTIVE',
      activityIds: [ID_A],
    });
  });
});
