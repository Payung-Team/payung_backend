import { UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * ฟีดแบ็กอาจารย์ Sprint 9 ข้อ 2 — ราคาจากระบบ (service_price_catalog) แทนราคาที่ผู้ดูแลตั้งเอง
 *
 * ราคางาน = price_per_hour ของ service_type × durationHours
 * คิดครั้งเดียวตอนจองแล้วเก็บลง bookings.estimated_cost — ตอนจ่าย (PaymentService.createPayment)
 * ตัดตามยอดที่เก็บไว้ ไม่คิดใหม่ แก้ราคา catalog ทีหลังจึงไม่ย้อนไปเปลี่ยนใบที่จองแล้ว
 */

type CatalogReader = {
  servicePriceCatalog: Pick<Prisma.ServicePriceCatalogDelegate, 'findUnique'>;
};

/**
 * ราคาต่อชั่วโมงของ service_type ที่เปิดขายอยู่
 * ไม่มีแถว / is_active = false → 422 (ยังไม่เปิดให้จองบริการประเภทนี้)
 */
export async function activeHourlyPrice(
  prisma: CatalogReader,
  serviceType: string,
): Promise<Prisma.Decimal> {
  const row = await prisma.servicePriceCatalog.findUnique({
    where: { serviceType },
    select: { pricePerHour: true, isActive: true },
  });
  if (!row || !row.isActive) {
    throw new UnprocessableEntityException('ยังไม่เปิดให้บริการประเภทนี้');
  }
  return row.pricePerHour;
}

/** price_per_hour × durationHours ปัดเป็นสตางค์ (HALF_UP) — คำนวณด้วย Decimal ไม่ผ่าน float */
export function estimatedCostOf(
  pricePerHour: Prisma.Decimal,
  durationHours: number,
): Prisma.Decimal {
  return new Prisma.Decimal(pricePerHour)
    .mul(durationHours)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}
