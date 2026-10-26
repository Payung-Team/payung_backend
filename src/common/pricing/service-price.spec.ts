import { bookingTotals, platformFeeOf, platformFeePercentOf } from './service-price';


describe('platformFeeOf', () => {
  it('10% ของราคาบริการ ปัดสตางค์ HALF_UP', () => {
    expect(platformFeeOf(1600, 10)).toBe(160);
    expect(platformFeeOf(1050.5, 10)).toBe(105.05);
    expect(platformFeeOf(0.05, 10)).toBe(0.01); // 0.005 → 0.01
  });
  it('0% → 0', () => {
    expect(platformFeeOf(600, 0)).toBe(0);
  });
});

describe('bookingTotals / platformFeePercentOf', () => {
  it('ยอดรวม = ราคาบริการ + fee (คิดจาก percent เมื่อยังไม่มี platform_fee)', () => {
    expect(bookingTotals(1600, null, 10)).toEqual({ platformFee: 160, totalCost: 1760 });
    expect(bookingTotals({ toNumber: () => 1050.5 }, undefined, 10)).toEqual({
      platformFee: 105.05,
      totalCost: 1155.55,
    });
  });
  it('มี platform_fee ที่เก็บไว้ → ใช้ค่านั้น ไม่คิดใหม่', () => {
    expect(bookingTotals(1000, { toNumber: () => 50 }, 10)).toEqual({ platformFee: 50, totalCost: 1050 });
  });
  it('ไม่มีราคาบริการ → ไม่คืนอะไร', () => {
    expect(bookingTotals(null, null, 10)).toEqual({});
  });
  it('percent: ไม่ตั้ง/เพี้ยน → 10', () => {
    expect(platformFeePercentOf(undefined)).toBe(10);
    expect(platformFeePercentOf('abc')).toBe(10);
    expect(platformFeePercentOf('15')).toBe(15);
  });
});
