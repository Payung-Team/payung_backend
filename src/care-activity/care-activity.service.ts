/**
 * CareActivityService — รายการกิจกรรมการดูแลกลาง (PYG-634 · S15 · contract PYG-632)
 *
 * ฝั่งแอดมิน: adminList / create / update / setActive (ไม่มีลบ · R4)
 * ฝั่งหน้าจอง: activeList (เฉพาะที่เปิดใช้งาน · R5)
 * การจอง: resolveForBooking + writeForBooking — BookingService เรียกใน transaction เดียวกับ booking.create
 *   เก็บ "สำเนา" ชื่อ หมวด ระดับลง booking_activities (R6) · อ่านกลับด้วย toBookingActivities ไม่ join ค่าปัจจุบัน
 *
 * ★ ตรวจค่าที่ service (ไม่พึ่ง decorator ของ DTO) เพื่อให้ได้ code ตาม contract (บทเรียน PYG-415)
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import { PrismaService } from '../common/prisma.service';
import { ClockService } from '../common/clock.service';
import {
  CARE_LEVEL_INPUT_VALUES,
  CareLevel,
  careLevelFromDb,
  careLevelFromInput,
} from '../common/care-level/care-level';
import { BookingActivity, CareActivity } from './entities/care-activity.entity';
import {
  AdminCareActivitiesFilter,
  CreateCareActivityInput,
  UpdateCareActivityInput,
} from './dto/care-activity.input';
import { CARE_ACTIVITY_ERROR, CareActivityError } from './care-activity.errors';

/** ความยาวสูงสุดหลังตัดช่องว่าง — กันข้อความยาวผิดปกติ (DB เป็น text ไม่มีขีดจำกัด) */
export const CARE_ACTIVITY_NAME_MAX = 200;
export const CARE_ACTIVITY_CATEGORY_MAX = 100;

type Db = PrismaService | Prisma.TransactionClient;

type ActivityRow = {
  id: string;
  code: string | null;
  nameTh: string;
  nameEn: string | null;
  category: string;
  careLevel: string;
  isActive: boolean;
  sortOrder: number;
  updatedAt: Date;
};

/** แถวสำเนาใน booking_activities ที่ต้องใช้แสดงผล */
export type BookingActivityRow = {
  careActivityId: string;
  activityName: string;
  category: string;
  careLevel: string;
};

/** select ของ booking_activities สำหรับ include ใน query ของ booking — เรียงตามลำดับที่บันทึก */
export const BOOKING_ACTIVITIES_SELECT = {
  select: {
    careActivityId: true,
    activityName: true,
    category: true,
    careLevel: true,
  },
  orderBy: { createdAt: 'asc' as const },
};

const ORDER: Prisma.CareActivityOrderByWithRelationInput[] = [
  { category: 'asc' },
  { sortOrder: 'asc' },
  { nameTh: 'asc' },
];

@Injectable()
export class CareActivityService {
  private readonly logger = new Logger(CareActivityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  // ─── หน้าจอง ──────────────────────────────────────────────────────────────

  /** เฉพาะที่เปิดใช้งาน เรียงตามหมวด → sortOrder (R5 · E4) — รายการว่างไม่ใช่ error (E5) */
  async activeList(): Promise<CareActivity[]> {
    const rows = await this.prisma.careActivity.findMany({
      where: { isActive: true },
      orderBy: ORDER,
    });
    return rows.map((r) => this.toEntity(r));
  }

  // ─── แอดมิน ───────────────────────────────────────────────────────────────

  /** รวมที่ปิดใช้งาน · ตัวกรอง หมวด / ระดับ / สถานะ / คำค้น */
  async adminList(
    filter: AdminCareActivitiesFilter = {},
  ): Promise<CareActivity[]> {
    const where: Prisma.CareActivityWhereInput = {};
    const category = filter.category?.trim();
    if (category) where.category = category;
    if (
      filter.careLevel !== undefined &&
      filter.careLevel !== null &&
      filter.careLevel !== ''
    ) {
      where.careLevel = this.parseLevel(filter.careLevel);
    }
    if (typeof filter.isActive === 'boolean') where.isActive = filter.isActive;
    const search = filter.search?.trim();
    if (search) {
      where.OR = [
        { nameTh: { contains: search, mode: 'insensitive' } },
        { nameEn: { contains: search, mode: 'insensitive' } },
        { code: { contains: search, mode: 'insensitive' } },
      ];
    }
    const rows = await this.prisma.careActivity.findMany({
      where,
      orderBy: ORDER,
    });
    return rows.map((r) => this.toEntity(r));
  }

  async create(input: CreateCareActivityInput): Promise<CareActivity> {
    const nameTh = this.requireText(
      input.nameTh,
      'nameTh',
      CARE_ACTIVITY_NAME_MAX,
    );
    const category = this.requireText(
      input.category,
      'category',
      CARE_ACTIVITY_CATEGORY_MAX,
    );
    const careLevel = this.parseLevel(input.careLevel);
    const nameEn = this.optionalText(
      input.nameEn,
      'nameEn',
      CARE_ACTIVITY_NAME_MAX,
    );

    await this.assertNameFree(this.prisma, category, nameTh);

    // ไม่ส่ง sortOrder = ต่อท้ายหมวด
    const sortOrder =
      input.sortOrder ??
      ((
        await this.prisma.careActivity.aggregate({
          where: { category },
          _max: { sortOrder: true },
        })
      )._max.sortOrder ?? -1) + 1;

    const now = this.clock.now();
    const row = await this.withDuplicateGuard(category, nameTh, () =>
      this.prisma.careActivity.create({
        data: {
          nameTh,
          nameEn,
          category,
          careLevel,
          sortOrder,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    this.logger.log({
      event: 'care_activity.created',
      id: row.id,
      category,
      careLevel,
    });
    return this.toEntity(row);
  }

  /** แก้ไข — ส่งเฉพาะช่องที่เปลี่ยน · แก้ตัวเองโดยไม่เปลี่ยนชื่อ/หมวดไม่ถือว่าซ้ำ (E3) */
  async update(
    id: string,
    input: UpdateCareActivityInput,
  ): Promise<CareActivity> {
    const current = await this.findOrThrow(id);

    const data: Prisma.CareActivityUpdateInput = {};
    if (input.nameTh !== undefined && input.nameTh !== null) {
      data.nameTh = this.requireText(
        input.nameTh,
        'nameTh',
        CARE_ACTIVITY_NAME_MAX,
      );
    }
    if (input.category !== undefined && input.category !== null) {
      data.category = this.requireText(
        input.category,
        'category',
        CARE_ACTIVITY_CATEGORY_MAX,
      );
    }
    if (input.careLevel !== undefined && input.careLevel !== null) {
      data.careLevel = this.parseLevel(input.careLevel);
    }
    if (input.nameEn !== undefined) {
      data.nameEn = this.optionalText(
        input.nameEn,
        'nameEn',
        CARE_ACTIVITY_NAME_MAX,
      );
    }
    if (input.sortOrder !== undefined && input.sortOrder !== null)
      data.sortOrder = input.sortOrder;

    const nameTh = (data.nameTh as string | undefined) ?? current.nameTh;
    const category = (data.category as string | undefined) ?? current.category;
    if (nameTh !== current.nameTh || category !== current.category) {
      await this.assertNameFree(this.prisma, category, nameTh, current.id);
    }

    data.updatedAt = this.clock.now();
    const row = await this.withDuplicateGuard(category, nameTh, () =>
      this.prisma.careActivity.update({ where: { id: current.id }, data }),
    );
    this.logger.log({ event: 'care_activity.updated', id: row.id });
    return this.toEntity(row);
  }

  /** ปิด / เปิดใช้งาน (R4: ไม่มีลบ) · booking เดิมไม่กระทบเพราะอ่านจากสำเนา */
  async setActive(id: string, isActive: boolean): Promise<CareActivity> {
    const current = await this.findOrThrow(id);
    const row = await this.prisma.careActivity.update({
      where: { id: current.id },
      data: { isActive, updatedAt: this.clock.now() },
    });
    this.logger.log({
      event: isActive ? 'care_activity.activated' : 'care_activity.deactivated',
      id: row.id,
    });
    return this.toEntity(row);
  }

  // ─── การจอง ───────────────────────────────────────────────────────────────

  /**
   * ตรวจกิจกรรมที่เลือกตอนสร้าง booking — เรียกใน transaction เดียวกับ booking.create
   *
   * - ไม่ส่ง / รายการว่าง → [] (E9 · client เก่าจองได้ตามเดิม)
   * - id ซ้ำในคำขอเดียว → นับครั้งเดียว (E8) · ลำดับตามที่ส่งมาครั้งแรก
   * - id ไม่มีอยู่ / ไม่ใช่ uuid → CARE_ACTIVITY_NOT_FOUND
   * - ปิดใช้งาน → CARE_ACTIVITY_INACTIVE (E2) — booking ไม่ถูกสร้าง (ทั้ง transaction rollback)
   *
   * SELECT … FOR SHARE: แอดมินปิดใช้งานกิจกรรมเดียวกันพร้อมกันต้องรอ transaction นี้จบ
   *   → ไม่มีกรณีตรวจแล้วว่าเปิด แต่ตอนบันทึกถูกปิดไปแล้ว
   */
  async resolveForBooking(
    tx: Prisma.TransactionClient,
    activityIds: readonly string[] | null | undefined,
  ): Promise<BookingActivityRow[]> {
    const ids = [
      ...new Set(
        (activityIds ?? [])
          .map((id) => (typeof id === 'string' ? id.trim() : ''))
          .filter(Boolean),
      ),
    ];
    if (ids.length === 0) return [];

    const malformed = ids.filter((id) => !isUUID(id));
    if (malformed.length > 0) throw this.notFound(malformed);

    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        name_th: string;
        category: string;
        care_level: string;
        is_active: boolean;
      }>
    >`
      SELECT id::text AS id, name_th, category, care_level, is_active
        FROM care_activities
       WHERE id = ANY(${ids}::uuid[])
       FOR SHARE
    `;
    const byId = new Map(rows.map((r) => [r.id, r]));

    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length > 0) throw this.notFound(missing);

    const inactive = ids.filter((id) => !byId.get(id)!.is_active);
    if (inactive.length > 0) {
      throw new CareActivityError(
        'กิจกรรมที่เลือกบางรายการถูกปิดใช้งานแล้ว กรุณาเลือกใหม่',
        CARE_ACTIVITY_ERROR.INACTIVE,
        { activityIds: inactive },
      );
    }

    return ids.map((id) => {
      const r = byId.get(id)!;
      return {
        careActivityId: r.id,
        activityName: r.name_th,
        category: r.category,
        careLevel: r.care_level,
      };
    });
  }

  /** บันทึกสำเนาลง booking_activities (ใน transaction เดียวกับ booking.create) */
  async writeForBooking(
    tx: Prisma.TransactionClient,
    bookingId: string,
    activities: readonly BookingActivityRow[],
  ): Promise<void> {
    if (activities.length === 0) return;
    await tx.bookingActivity.createMany({
      data: activities.map((a) => ({
        bookingId,
        careActivityId: a.careActivityId,
        activityName: a.activityName,
        category: a.category,
        careLevel: a.careLevel,
      })),
    });
  }

  /** กิจกรรมของ booking จากสำเนา (R6) — ResolveField activities ของ BookingSummary / CaregiverBookingSummary */
  async listForBooking(bookingId: string): Promise<BookingActivity[]> {
    const rows = await this.prisma.bookingActivity.findMany({
      where: { bookingId },
      ...BOOKING_ACTIVITIES_SELECT,
    });
    return toBookingActivities(rows);
  }

  // ─── แปลงค่า ──────────────────────────────────────────────────────────────

  toEntity(row: ActivityRow): CareActivity {
    return {
      id: row.id,
      code: row.code,
      nameTh: row.nameTh,
      nameEn: row.nameEn,
      category: row.category,
      careLevel: this.levelFromDb(row.careLevel, row.id),
      isActive: row.isActive,
      sortOrder: row.sortOrder,
      updatedAt: row.updatedAt,
    };
  }

  // ─── ภายใน ────────────────────────────────────────────────────────────────

  private levelFromDb(value: string, id: string): CareLevel {
    const level = careLevelFromDb(value);
    if (level) return level;
    // DB มี CHECK กันอยู่แล้ว — ถ้าหลุดมาให้เห็นใน log แทนที่ทั้ง query พังตอน serialize enum
    this.logger.error({ event: 'care_activity.invalid_level', id, value });
    return CareLevel.BASIC;
  }

  private async findOrThrow(id: string) {
    const row = isUUID(id ?? '')
      ? await this.prisma.careActivity.findUnique({ where: { id } })
      : null;
    if (!row) throw this.notFound([id]);
    return row;
  }

  private notFound(activityIds: string[]): CareActivityError {
    return new CareActivityError(
      'ไม่พบกิจกรรมที่เลือก',
      CARE_ACTIVITY_ERROR.NOT_FOUND,
      { activityIds },
    );
  }

  /** ชื่อซ้ำในหมวดเดียวกัน (E3) — เทียบตรงตัวแบบเดียวกับ unique (category, name_th) ของ DB */
  private async assertNameFree(
    db: Db,
    category: string,
    nameTh: string,
    excludeId?: string,
  ): Promise<void> {
    const clash = await db.careActivity.findFirst({
      where: { category, nameTh, ...(excludeId && { NOT: { id: excludeId } }) },
      select: { id: true },
    });
    if (clash) throw this.duplicate(category, nameTh);
  }

  /** ชนกันระหว่างตรวจกับเขียน (สองคำขอพร้อมกัน) → unique ของ DB กันไว้ แปลงเป็น code เดียวกัน */
  private async withDuplicateGuard<T>(
    category: string,
    nameTh: string,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw this.duplicate(category, nameTh);
      }
      throw err;
    }
  }

  private duplicate(category: string, nameTh: string): CareActivityError {
    return new CareActivityError(
      'มีกิจกรรมชื่อนี้ในหมวดนี้อยู่แล้ว',
      CARE_ACTIVITY_ERROR.DUPLICATE,
      {
        category,
        nameTh,
      },
    );
  }

  private parseLevel(value: string): CareLevel {
    const level = careLevelFromInput(value);
    if (!level) {
      throw new CareActivityError(
        'ระดับต้องเป็น BASIC, INTERMEDIATE หรือ ADVANCED',
        CARE_ACTIVITY_ERROR.INVALID,
        {
          field: 'careLevel',
          allowed: CARE_LEVEL_INPUT_VALUES,
          received: value,
        },
      );
    }
    return level;
  }

  private requireText(
    value: string | null | undefined,
    field: string,
    max: number,
  ): string {
    const v = (value ?? '').trim();
    if (!v) {
      throw new CareActivityError(
        `ต้องระบุ ${field}`,
        CARE_ACTIVITY_ERROR.INVALID,
        { field, reason: 'required' },
      );
    }
    if (v.length > max) {
      throw new CareActivityError(
        `${field} ยาวเกิน ${max} ตัวอักษร`,
        CARE_ACTIVITY_ERROR.INVALID,
        {
          field,
          reason: 'too_long',
          max,
        },
      );
    }
    return v;
  }

  /** ว่าง / null = ไม่มีค่า */
  private optionalText(
    value: string | null | undefined,
    field: string,
    max: number,
  ): string | null {
    const v = (value ?? '').trim();
    if (!v) return null;
    if (v.length > max) {
      throw new CareActivityError(
        `${field} ยาวเกิน ${max} ตัวอักษร`,
        CARE_ACTIVITY_ERROR.INVALID,
        {
          field,
          reason: 'too_long',
          max,
        },
      );
    }
    return v;
  }
}

/** แถวสำเนา → type ที่ส่งให้ client (ไม่อ่านค่าปัจจุบันของ care_activities · R6) */
export function toBookingActivities(
  rows: readonly BookingActivityRow[] | null | undefined,
): BookingActivity[] {
  return (rows ?? []).map((r) => ({
    activityId: r.careActivityId,
    name: r.activityName,
    category: r.category,
    careLevel: careLevelFromDb(r.careLevel) ?? CareLevel.BASIC,
  }));
}
