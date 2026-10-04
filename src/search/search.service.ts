import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { AvatarUrlService } from '../common/avatar-url.service';
import { SearchCaregiverInput, SortByEnum } from './dto/search-caregiver.input';
import { CaregiverSummary, SearchCaregiverPayload } from './dto/search-caregiver.payload';

type RawCaregiverRow = {
  id: string;
  full_name: string | null;
  avatar_url: string | null;
  hourly_rate: number | null; // ราคาเริ่มต้นจาก catalog (float8) — null = ไม่มีประเภทงานที่มีราคา
  avg_rating: number | null;
  // PYG-298: อ่านจากคอลัมน์ caregivers.review_count (INTEGER → number) แทนการ COUNT() สด
  review_count: number;
  skills: string[];
  province: string | null;
  district: string | null;
  gender: string | null;
  total_count: bigint; // COUNT(*) OVER() ของ Postgres เป็น bigint เสมอ
};

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly avatarUrlService: AvatarUrlService,
  ) {}

  /**
   * searchCaregivers — ค้นหา caregiver ที่ is_searchable + kyc_status = 'verified'
   * มี active availability slot อย่างน้อย 1 slot
   *
   * Strategy (PYG-298):
   * - CTE `agg`: JOIN caregivers + users → อ่าน avg_rating/review_count จากคอลัมน์ที่ trigger
   *   trg_recalc_rating เก็บไว้ให้ (ไม่ JOIN/GROUP BY reviews สดอีกต่อไป → เร็วขึ้น)
   * - Outer query: กรอง min_rating (อ้าง alias avg_rating ได้หลัง CTE) + COUNT(*) OVER() สำหรับ pagination
   * - $queryRaw: ใช้ Prisma.sql สำหรับ dynamic WHERE fragments (safe parameterization)
   */
  async searchCaregivers(input: SearchCaregiverInput): Promise<SearchCaregiverPayload> {
    const page  = Math.max(1, input.page  ?? 1);
    const limit = Math.min(50, Math.max(1, input.limit ?? 10));
    const offset = (page - 1) * limit;
    const sortBy = input.sortBy ?? SortByEnum.RATING_DESC;

    // ─── Parse job_type ───────────────────────────────────────────────────
    const jobTypes = input.jobType
      ? input.jobType.split(',').map((s) => s.trim()).filter(Boolean)
      : [];

    // ─── Build inner WHERE (applied before GROUP BY) ──────────────────────
    const conditions: Prisma.Sql[] = [
      Prisma.sql`c.is_searchable = true`,
      Prisma.sql`c.kyc_status = 'verified'`,
      Prisma.sql`EXISTS (
        SELECT 1 FROM caregiver_availability ca
        WHERE ca.caregiver_id = c.id AND ca.is_active = true
      )`,
    ];

    if (input.province) {
      conditions.push(Prisma.sql`c.service_area_province = ${input.province}`);
    }
    if (input.district) {
      conditions.push(Prisma.sql`(${input.district} = ANY(string_to_array(c.service_area_district, ',')) OR c.service_area_district = ${input.district})`);
    }
    if (jobTypes.length > 0) {
      conditions.push(Prisma.sql`EXISTS (
        SELECT 1 FROM caregiver_job_types jt
        WHERE jt.caregiver_id = c.id
          AND jt.job_type::text = ANY(${jobTypes}::text[])
      )`);
    }

    const whereClause = Prisma.join(conditions, ' AND ');

    // ─── ราคาเริ่มต้นจาก service_price_catalog (ฟีดแบ็กอาจารย์ Sprint 9 ข้อ 2) ───
    // = ราคาต่ำสุดของประเภทงานที่ผู้ดูแลรับ (เฉพาะแถว is_active) · กรอง jobType มา → คิดเฉพาะประเภทนั้น
    // ไม่ใช่ caregivers.hourly_rate ที่ผู้ดูแลตั้งเองอีกต่อไป
    // ★ กติกาเดียวกับ startingHourlyPrices() ใน common/pricing/display-price.ts — แก้ที่หนึ่งต้องแก้อีกที่
    const priceJobTypeFilter = jobTypes.length > 0
      ? Prisma.sql`AND jt.job_type::text = ANY(${jobTypes}::text[])`
      : Prisma.sql``;
    const startingPrice = Prisma.sql`(
      SELECT MIN(spc.price_per_hour)::float8
      FROM caregiver_job_types jt
      JOIN service_price_catalog spc
        ON spc.service_type = jt.job_type::text AND spc.is_active = true
      WHERE jt.caregiver_id = c.id ${priceJobTypeFilter}
    )`;

    // ─── Outer WHERE for min_rating (applied after aggregation via CTE) ───
    const outerConditions: Prisma.Sql[] = [];
    // ตัวกรองราคาอ้าง alias hourly_rate (ราคาจาก catalog) หลัง CTE — ใน WHERE ชั้นในยังไม่มี alias นี้
    if (input.minPrice !== undefined) {
      outerConditions.push(Prisma.sql`hourly_rate >= ${input.minPrice}`);
    }
    if (input.maxPrice !== undefined) {
      outerConditions.push(Prisma.sql`hourly_rate <= ${input.maxPrice}`);
    }
    if (input.minRating !== undefined) {
      outerConditions.push(
        Prisma.sql`COALESCE(avg_rating, 0) >= ${input.minRating}`,
      );
    }
    const outerWhere = outerConditions.length > 0
      ? Prisma.sql`WHERE ${Prisma.join(outerConditions, ' AND ')}`
      : Prisma.sql``;

    // ─── ORDER BY ─────────────────────────────────────────────────────────
    const orderBy = this.buildOrderBy(sortBy);

    // ─── Execute ──────────────────────────────────────────────────────────
    const rows = await this.prismaService.$queryRaw<RawCaregiverRow[]>`
      WITH agg AS (
        SELECT
          c.id,
          c.full_name,
          u.avatar_url,
          ${startingPrice}                          AS hourly_rate,
          -- PYG-298: อ่านค่าที่ trigger trg_recalc_rating เก็บไว้ — ไม่ JOIN/aggregate reviews สด
          c.average_rating                          AS avg_rating,
          c.review_count                            AS review_count,
          c.skills,
          c.service_area_province                   AS province,
          c.service_area_district                   AS district,
          c.gender
        FROM caregivers c
        INNER JOIN users u ON u.id = c.user_id
        WHERE ${whereClause}
      )
      SELECT
        *,
        COUNT(*) OVER() AS total_count
      FROM agg
      ${outerWhere}
      ORDER BY ${orderBy}
      LIMIT ${limit} OFFSET ${offset}
    `;

    const total      = rows.length > 0 ? Number(rows[0].total_count) : 0;
    const totalPages = total === 0 ? 1 : Math.ceil(total / limit);

    // PYG-518: เซ็น avatar ของทุกแถวในหน้านี้ด้วย createSignedUrls ครั้งเดียว
    // (ไม่ใช่ยิง sign ทีละแถว) · avatar_url ของผู้ดูแลมีค่าเฉพาะหลังแอดมินอนุมัติรูป (PYG-508)
    const avatarByRow = await this.avatarUrlService.resolveMany(
      rows,
      (row) => row.avatar_url,
    );

    const data: CaregiverSummary[] = rows.map((row) => ({
      id:          row.id,
      fullName:    row.full_name   ?? '',
      avatarUrl:   avatarByRow.get(row) ?? undefined,
      hourlyRate:  row.hourly_rate ?? 0,
      avgRating:   row.avg_rating  != null ? row.avg_rating : undefined,
      reviewCount: Number(row.review_count),
      skills:      row.skills      ?? [],
      province:    row.province    ?? undefined,
      district:    row.district    ?? undefined,
      gender:      row.gender      ?? undefined,
    }));

    this.logger.log({
      event:  'search.caregivers',
      input:  { province: input.province, district: input.district, jobType: input.jobType,
                minPrice: input.minPrice, maxPrice: input.maxPrice, minRating: input.minRating,
                sortBy, page, limit },
      total,
      returned: data.length,
    });

    return { data, pagination: { page, limit, total, totalPages } };
  }

  private buildOrderBy(sortBy: SortByEnum): Prisma.Sql {
    switch (sortBy) {
      case SortByEnum.PRICE_ASC:  return Prisma.sql`hourly_rate ASC  NULLS LAST`;
      case SortByEnum.PRICE_DESC: return Prisma.sql`hourly_rate DESC NULLS LAST`;
      case SortByEnum.RATING_DESC:
      default:                    return Prisma.sql`avg_rating  DESC NULLS LAST`;
    }
  }
}
