import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { SearchService } from './search.service';
import { PrismaService } from '../common/prisma.service';
import { SortByEnum } from './dto/search-caregiver.input';

// ── Helpers ────────────────────────────────────────────────────────────────

type RawRow = {
  id: string; full_name: string | null; avatar_url: string | null;
  hourly_rate: number | null; avg_rating: number | null; review_count: bigint;
  skills: string[]; province: string | null; district: string | null; total_count: bigint;
};

function row(overrides: Partial<RawRow> = {}): RawRow {
  return {
    id: 'cg-1', full_name: 'สมชาย ใจดี', avatar_url: null,
    hourly_rate: 350, avg_rating: 4.5, review_count: BigInt(12),
    skills: ['elderly_care'], province: 'เชียงใหม่', district: 'เมืองเชียงใหม่',
    total_count: BigInt(1),
    ...overrides,
  };
}

/** Recursively join all string parts from a Prisma.Sql fragment or TemplateStringsArray. */
function flattenSql(arg: unknown): string {
  if (arg == null) return '';
  // TemplateStringsArray or plain array of strings
  if (Array.isArray(arg)) return arg.map(String).join(' ');
  // Prisma.Sql object
  const sql = arg as { strings?: unknown[]; values?: unknown[] };
  if (sql.strings) {
    const parts: string[] = [];
    const strings = sql.strings as string[];
    const values = sql.values ?? [];
    strings.forEach((s, i) => {
      parts.push(s);
      if (i < values.length) parts.push(flattenSql(values[i]));
    });
    return parts.join('');
  }
  return String(arg);
}

/** Extract the full flattened SQL string from a $queryRaw mock call. */
function getSql(mockFn: jest.Mock, callIndex = 0): string {
  const args: unknown[] = mockFn.mock.calls[callIndex];
  return args.map(flattenSql).join('');
}

/** Collect all leaf parameter values from a $queryRaw call.
 *  Recurses into Prisma.Sql objects (.strings + .values) but keeps plain arrays intact. */
function getValues(mockFn: jest.Mock, callIndex = 0): unknown[] {
  const collected: unknown[] = [];

  function collect(arg: unknown) {
    if (arg == null) return;
    // Prisma.Sql has a non-array object shape with .strings property
    if (typeof arg === 'object' && !Array.isArray(arg) && 'strings' in (arg as object)) {
      const sql = arg as { values?: unknown[] };
      (sql.values ?? []).forEach(collect);
      return;
    }
    // Plain value (including arrays like jobTypes string[]) — keep as-is
    collected.push(arg);
  }

  // skip index 0 (TemplateStringsArray — not a parameter value)
  mockFn.mock.calls[callIndex].slice(1).forEach(collect);
  return collected;
}

// ── Setup ──────────────────────────────────────────────────────────────────

describe('SearchService', () => {
  let service: SearchService;
  let prisma: { $queryRaw: jest.Mock };

  beforeEach(async () => {
    prisma = { $queryRaw: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SearchService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<SearchService>(SearchService);
  });

  // ── No filters ─────────────────────────────────────────────────────────

  it('returns mapped CaregiverSummary with no filters', async () => {
    prisma.$queryRaw.mockResolvedValue([row()]);

    const result = await service.searchCaregivers({});

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      id: 'cg-1', fullName: 'สมชาย ใจดี',
      hourlyRate: 350, avgRating: 4.5, reviewCount: 12,
      skills: ['elderly_care'], province: 'เชียงใหม่', district: 'เมืองเชียงใหม่',
    });
    expect(result.pagination).toMatchObject({ page: 1, limit: 10, total: 1, totalPages: 1 });
  });

  // ── Empty results ───────────────────────────────────────────────────────

  it('returns empty data and total=0 when no rows match', async () => {
    prisma.$queryRaw.mockResolvedValue([]);

    const result = await service.searchCaregivers({ province: 'ไม่มีจังหวัดนี้' });

    expect(result.data).toHaveLength(0);
    expect(result.pagination).toMatchObject({ total: 0, totalPages: 1 });
  });

  // ── 0-review caregiver ─────────────────────────────────────────────────

  it('returns avgRating=undefined and reviewCount=0 when caregiver has no reviews', async () => {
    prisma.$queryRaw.mockResolvedValue([row({ avg_rating: null, review_count: BigInt(0) })]);

    const result = await service.searchCaregivers({});

    expect(result.data[0].avgRating).toBeUndefined();
    expect(result.data[0].reviewCount).toBe(0);
  });

  // ── Pagination ──────────────────────────────────────────────────────────

  it('computes totalPages = ceil(total / limit)', async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row({ id: `cg-${i}`, total_count: BigInt(42) }),
    );
    prisma.$queryRaw.mockResolvedValue(rows);

    const result = await service.searchCaregivers({ page: 2, limit: 10 });

    expect(result.pagination).toMatchObject({ page: 2, limit: 10, total: 42, totalPages: 5 });
  });

  it('clamps limit to max 50', async () => {
    prisma.$queryRaw.mockResolvedValue([]);

    await service.searchCaregivers({ limit: 999 });

    expect(getValues(prisma.$queryRaw)).toContain(50);
  });

  it('clamps page to min 1 (offset = 0)', async () => {
    prisma.$queryRaw.mockResolvedValue([]);

    await service.searchCaregivers({ page: -5 });

    expect(getValues(prisma.$queryRaw)).toContain(0); // offset = (1-1)*10
  });

  // ── Sorting ─────────────────────────────────────────────────────────────

  it('uses avg_rating DESC (default) when sortBy not set', async () => {
    prisma.$queryRaw.mockResolvedValue([]);

    await service.searchCaregivers({});

    expect(getSql(prisma.$queryRaw)).toContain('avg_rating');
  });

  it('uses hourly_rate ASC when sortBy=price_asc', async () => {
    prisma.$queryRaw.mockResolvedValue([]);

    await service.searchCaregivers({ sortBy: SortByEnum.PRICE_ASC });

    const sql = getSql(prisma.$queryRaw);
    expect(sql).toContain('hourly_rate');
    expect(sql).toContain('ASC');
  });

  it('uses hourly_rate DESC when sortBy=price_desc', async () => {
    prisma.$queryRaw.mockResolvedValue([]);

    await service.searchCaregivers({ sortBy: SortByEnum.PRICE_DESC });

    const sql = getSql(prisma.$queryRaw);
    expect(sql).toContain('hourly_rate');
    expect(sql).toContain('DESC');
  });

  // ── Filter parameters passed to query ──────────────────────────────────

  it('passes province value as query parameter', async () => {
    prisma.$queryRaw.mockResolvedValue([]);

    await service.searchCaregivers({ province: 'เชียงใหม่' });

    expect(getValues(prisma.$queryRaw)).toContain('เชียงใหม่');
  });

  it('passes minPrice and maxPrice as parameters', async () => {
    prisma.$queryRaw.mockResolvedValue([]);

    await service.searchCaregivers({ minPrice: 200, maxPrice: 600 });

    const values = getValues(prisma.$queryRaw);
    expect(values).toContain(200);
    expect(values).toContain(600);
  });

  it('passes minRating as parameter and adds outer COALESCE filter', async () => {
    prisma.$queryRaw.mockResolvedValue([]);

    await service.searchCaregivers({ minRating: 3.5 });

    const sql = getSql(prisma.$queryRaw);
    expect(sql).toContain('COALESCE(avg_rating, 0)');
    expect(getValues(prisma.$queryRaw)).toContain(3.5);
  });

  it('omits outer COALESCE filter when minRating is not set', async () => {
    prisma.$queryRaw.mockResolvedValue([]);

    await service.searchCaregivers({});

    expect(getSql(prisma.$queryRaw)).not.toContain('COALESCE(avg_rating, 0)');
  });

  it('passes parsed jobType array as parameter', async () => {
    prisma.$queryRaw.mockResolvedValue([]);

    await service.searchCaregivers({ jobType: 'general_care, overnight' });

    const values = getValues(prisma.$queryRaw);
    expect(values).toContainEqual(['general_care', 'overnight']);
  });

  it('omits job_type EXISTS subquery when jobType not set', async () => {
    prisma.$queryRaw.mockResolvedValue([]);

    await service.searchCaregivers({});

    expect(getSql(prisma.$queryRaw)).not.toContain('caregiver_job_types');
  });

  // ── All filters combined ────────────────────────────────────────────────

  it('includes all filter conditions and correct ORDER BY when all filters set', async () => {
    prisma.$queryRaw.mockResolvedValue([row({ total_count: BigInt(3) })]);

    const result = await service.searchCaregivers({
      province: 'กรุงเทพ', district: 'บางรัก',
      jobType: 'overnight', minPrice: 300, maxPrice: 700,
      minRating: 4, sortBy: SortByEnum.PRICE_DESC, page: 2, limit: 5,
    });

    const sql    = getSql(prisma.$queryRaw);
    const values = getValues(prisma.$queryRaw);
    expect(sql).toContain('service_area_province');
    expect(sql).toContain('service_area_district');
    expect(sql).toContain('caregiver_job_types');
    expect(sql).toContain('COALESCE(avg_rating, 0)');
    expect(sql).toContain('hourly_rate');
    expect(values).toContain('กรุงเทพ');
    expect(values).toContain('บางรัก');
    expect(values).toContain(300);
    expect(values).toContain(700);
    expect(values).toContain(4);
    expect(result.pagination).toMatchObject({ page: 2, limit: 5, total: 3, totalPages: 1 });
  });
});
