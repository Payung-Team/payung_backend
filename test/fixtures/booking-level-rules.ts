import { readFileSync } from 'fs';
import { join } from 'path';
import type { BookingLevelRule } from '../../src/booking/level/booking-level.calculate';
/** Exact committed seed rows, followed by the approved F03 correction. */
export function seededBookingLevelRules(): BookingLevelRule[] {
  const dir = join(__dirname, '../../prisma/migrations');
  const files = [
    '20261008060000_pyg569_seed_booking_level_rules',
    '20261008070000_pyg569_seed_flag_level_rules',
  ];
  const rows = files.flatMap((file) => {
    const sql = readFileSync(join(dir, file, 'migration.sql'), 'utf8');
    const values = sql.slice(
      sql.indexOf('INSERT INTO'),
      sql.indexOf('ON CONFLICT', sql.indexOf('INSERT INTO')),
    );
    return [
      ...values.matchAll(
        /\(\s*'(flag|service)',\s*'([^']+)',\s*'([^']*)',\s*(NULL|'[^']+')\)/g,
      ),
    ].map((m) => ({
      source: m[1],
      code: m[2],
      variant: m[3],
      level: m[4] === 'NULL' ? null : m[4].slice(1, -1),
      isActive: true,
    }));
  });
  const correction = readFileSync(
    join(dir, '20261009010000_pyg638_f03_level_advanced/migration.sql'),
    'utf8',
  );
  if (!/SET\s+"level"\s*=\s*'advanced'/.test(correction))
    throw new Error('Recheck the F03 seed correction');
  return rows.map((row) =>
    row.source === 'service' && row.code === 'F03'
      ? { ...row, level: 'advanced' }
      : row,
  );
}

/** Test fixture only: caller has already validated the disposable DB URL. */
export async function seedBookingLevelRules(
  db: import('@prisma/client').PrismaClient,
) {
  for (const row of seededBookingLevelRules()) {
    const { source, code, variant, ...data } = row;
    await db.bookingLevelRule.upsert({
      where: { source_code_variant: { source, code, variant } },
      create: row,
      update: data,
    });
  }
}
