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

/**
 * ค่าธรรมเนียมแพลตฟอร์ม (บาท) = ราคาบริการ × percent/100 ปัดสตางค์ HALF_UP
 * เก็บเพิ่มจากลูกค้าบนราคาบริการ — ผู้ดูแลได้ราคาบริการเต็ม ไม่ถูกหัก
 */
export function platformFeeOf(estimatedCost: number, percent: number): number {
  return new Prisma.Decimal(estimatedCost)
    .mul(percent)
    .div(100)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
    .toNumber();
}

/** PLATFORM_FEE_PERCENT จาก env/config (string) → เลข · ไม่ตั้ง/เพี้ยน → default 10 */
export function platformFeePercentOf(raw: string | number | undefined | null): number {
  const n = raw == null || raw === '' ? 10 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 10;
}

/**
 * ยอดที่ลูกค้าต้องจ่ายของใบจอง = ราคาบริการ + ค่าธรรมเนียม (ตัวเลขเดียวกับที่ตัดบัตร)
 * ใช้ platform_fee ที่เก็บไว้ถ้ามี (ตั้งตอนชำระ) ไม่งั้นคิดจาก percent ปัจจุบัน
 */
export function bookingTotals(
  estimatedCost: { toNumber(): number } | number | null | undefined,
  storedFee: { toNumber(): number } | number | null | undefined,
  percent: number,
): { platformFee?: number; totalCost?: number } {
  if (estimatedCost == null) return {};
  const base = typeof estimatedCost === 'number' ? estimatedCost : estimatedCost.toNumber();
  const platformFee =
    storedFee != null
      ? typeof storedFee === 'number'
        ? storedFee
        : storedFee.toNumber()
      : platformFeeOf(base, percent);
  return {
    platformFee,
    totalCost: new Prisma.Decimal(base).add(platformFee).toDecimalPlaces(2).toNumber(),
  };
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
