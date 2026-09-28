import { Prisma } from '@prisma/client';

/**
 * ฟีดแบ็กอาจารย์ Sprint 9 ข้อ 2 — ราคาที่ "แสดง" ต้องมาจาก service_price_catalog
 * ให้ตรงกันทุกหน้า (Search → Booking → Booking Record) ไม่ใช่ caregivers.hourly_rate ที่ผู้ดูแลตั้งเอง
 *
 * ชื่อฟิลด์ใน API (hourlyRate / hourly_rate) คงเดิม FE ไม่ต้องแก้ — เปลี่ยนแค่แหล่งของค่า
 * ส่วนยอดที่ตัดเงินจริงอยู่ที่ bookings.estimated_cost (ไฟล์นี้ไม่แตะเงิน)
 */

type StartingPriceReader = {
  caregiverJobType: Pick<Prisma.CaregiverJobTypeDelegate, 'findMany'>;
  servicePriceCatalog: Pick<Prisma.ServicePriceCatalogDelegate, 'findMany'>;
};

/**
 * ราคา "เริ่มต้น" ต่อชั่วโมงของผู้ดูแลแต่ละคน
 *   = ราคาต่ำสุดใน catalog (is_active) ของประเภทงานที่ผู้ดูแลคนนั้นรับ
 *   ส่ง jobTypes มา → คิดเฉพาะประเภทที่อยู่ในชุดนั้น (ตรงกับตัวกรอง jobType ของหน้า Search)
 * ผู้ดูแลที่ไม่มีประเภทงานที่มีราคาเลย → ไม่อยู่ใน Map
 *
 * ★ กติกาเดียวกับ SQL ใน SearchService.searchCaregivers — แก้ที่หนึ่งต้องแก้อีกที่
 */
export async function startingHourlyPrices(
  prisma: StartingPriceReader,
  caregiverIds: string[],
  jobTypes: string[] = [],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (caregiverIds.length === 0) return result;

  const [jobs, catalog] = await Promise.all([
    prisma.caregiverJobType.findMany({
      where: { caregiverId: { in: caregiverIds } },
      select: { caregiverId: true, jobType: true },
    }),
    prisma.servicePriceCatalog.findMany({
      where: { isActive: true },
      select: { serviceType: true, pricePerHour: true },
    }),
  ]);

  const priceOf = new Map(catalog.map((c) => [c.serviceType, Number(c.pricePerHour)]));
  const allowed = jobTypes.length > 0 ? new Set(jobTypes) : null;

  for (const { caregiverId, jobType } of jobs) {
    if (allowed && !allowed.has(jobType)) continue;
    const price = priceOf.get(jobType);
    if (price == null) continue;
    const current = result.get(caregiverId);
    if (current == null || price < current) result.set(caregiverId, price);
  }
  return result;
}

type NumericLike = { toNumber(): number } | number;

const toNum = (v: NumericLike): number => (typeof v === 'number' ? v : v.toNumber());

/**
 * ราคาต่อชั่วโมงของ "ใบจองนี้" = estimated_cost ÷ duration_hours
 * ไม่ใช่ hourly_rate ปัจจุบันของผู้ดูแล — หน้า Booking Record ต้องตรงกับยอดที่จองไว้
 * (ใบเก่าก่อนมี catalog: estimated_cost = hourly_rate × ชม. อยู่แล้ว ค่าที่ได้จึงเท่าเดิม)
 */
export function bookingHourlyRate(
  estimatedCost: NumericLike | null | undefined,
  durationHours: NumericLike | null | undefined,
): number | undefined {
  if (estimatedCost == null || durationHours == null) return undefined;
  const hours = toNum(durationHours);
  if (!(hours > 0)) return undefined;
  return new Prisma.Decimal(toNum(estimatedCost))
    .div(hours)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
    .toNumber();
}
