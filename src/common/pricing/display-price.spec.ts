import { Prisma } from '@prisma/client';
import { bookingHourlyRate, startingHourlyPrices } from './display-price';

describe('startingHourlyPrices', () => {
  const prisma = {
    caregiverJobType: {
      findMany: jest.fn().mockResolvedValue([
        { caregiverId: 'a', jobType: 'general_care' },
        { caregiverId: 'a', jobType: 'physiotherapy' },
        { caregiverId: 'b', jobType: 'companion' }, // ปิดขาย → ไม่มีราคา
      ]),
    },
    servicePriceCatalog: {
      // findMany ถูกกรอง is_active = true แล้ว — companion จึงไม่มาในผลลัพธ์
      findMany: jest.fn().mockResolvedValue([
        { serviceType: 'general_care', pricePerHour: new Prisma.Decimal(300) },
        { serviceType: 'physiotherapy', pricePerHour: new Prisma.Decimal(280) },
      ]),
    },
  };

  it('คืนราคาต่ำสุดของประเภทที่รับ · ไม่มีประเภทที่มีราคา → ไม่อยู่ใน Map', async () => {
    const prices = await startingHourlyPrices(prisma, ['a', 'b']);
    expect(prices.get('a')).toBe(280);
    expect(prices.has('b')).toBe(false);
    expect(prisma.servicePriceCatalog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true } }),
    );
  });

  it('ส่ง jobTypes มา → คิดเฉพาะประเภทนั้น (ตรงกับตัวกรองหน้า Search)', async () => {
    const prices = await startingHourlyPrices(prisma, ['a'], ['general_care']);
    expect(prices.get('a')).toBe(300);
  });

  it('ไม่มี caregiverIds → ไม่ query เลย', async () => {
    prisma.caregiverJobType.findMany.mockClear();
    const prices = await startingHourlyPrices(prisma, []);
    expect(prices.size).toBe(0);
    expect(prisma.caregiverJobType.findMany).not.toHaveBeenCalled();
  });
});

describe('bookingHourlyRate', () => {
  it('estimated_cost ÷ ชม. ปัด 2 ตำแหน่ง', () => {
    expect(bookingHourlyRate(new Prisma.Decimal(1050), new Prisma.Decimal(3.5))).toBe(300);
    expect(bookingHourlyRate(1000, 3)).toBe(333.33);
  });

  it('ไม่มีราคา / ชม. เป็น 0 → undefined', () => {
    expect(bookingHourlyRate(null, 2)).toBeUndefined();
    expect(bookingHourlyRate(600, 0)).toBeUndefined();
    expect(bookingHourlyRate(600, null)).toBeUndefined();
  });
});
