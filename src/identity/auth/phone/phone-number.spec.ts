/**
 * PYG-603 — เทสการตรวจและแปลงเบอร์มือถือไทย (R4, R7, R10)
 */
import {
  isSamePhone,
  maskPhone,
  parseThaiMobile,
  profilePhoneVariants,
} from './phone-number';

describe('parseThaiMobile (R4: เบอร์เดียวกันที่พิมพ์ต่างรูปแบบต้องเป็นเบอร์เดียวกัน)', () => {
  const expected = {
    national: '0812345678',
    e164: '+66812345678',
    supabase: '66812345678',
  };

  it.each([
    ['0812345678'],
    ['+66812345678'], // FE ส่งแบบนี้เสมอ
    ['66812345678'],
    ['+660812345678'], // พิมพ์ 0 ซ้ำหลังรหัสประเทศ
    ['081-234-5678'],
    ['081 234 5678'],
    ['(081) 234-5678'],
    ['  0812345678  '],
    ['+66 81 234 5678'],
  ])('"%s" → รูปมาตรฐานเดียวกัน', (raw) => {
    expect(parseThaiMobile(raw)).toEqual(expected);
  });

  it.each([['0612345678'], ['0912345678']])(
    'ขึ้นต้น 06 / 09 ก็เป็นมือถือ: "%s"',
    (raw) => {
      expect(parseThaiMobile(raw)?.national).toBe(raw);
    },
  );

  it.each([
    ['', 'ว่าง'],
    ['   ', 'ช่องว่างล้วน'],
    ['021234567', 'เบอร์บ้าน (02)'],
    ['0212345678', 'ขึ้นต้น 02 แม้ยาว 10 หลัก'],
    ['0512345678', 'ขึ้นต้น 05 ไม่ใช่มือถือ'],
    ['081234567', 'สั้นไป 9 หลัก'],
    ['08123456789', 'ยาวไป 11 หลัก'],
    ['+14155552671', 'เบอร์ต่างประเทศ'],
    ['abc0812345678', 'มีตัวอักษร'],
    ['0812345678; DROP TABLE users', 'มีอักขระแปลก'],
    ['08123456７８', 'ตัวเลขเต็มความกว้าง'],
    ['0'.repeat(40), 'ยาวผิดปกติ'],
  ])('ปฏิเสธ "%s" (%s) — R7: ปฏิเสธก่อนส่ง SMS', (raw) => {
    expect(parseThaiMobile(raw)).toBeNull();
  });

  it('ไม่ใช่ string → null (กันค่าแปลกจาก client)', () => {
    expect(parseThaiMobile(undefined)).toBeNull();
    expect(parseThaiMobile(null)).toBeNull();
    expect(parseThaiMobile(812345678)).toBeNull();
  });
});

describe('maskPhone (R10: ห้ามเขียนเบอร์เต็มลง log)', () => {
  it('เหลือ 3 ตัวหน้า 4 ตัวท้าย', () => {
    const phone = parseThaiMobile('0812345678')!;
    expect(maskPhone(phone)).toBe('081XXX5678');
    expect(maskPhone(phone)).not.toContain('0812345678');
  });
});

describe('profilePhoneVariants / isSamePhone', () => {
  it('ค้นหาได้ทุกรูปแบบที่อาจถูกเก็บใน users.phone', () => {
    const phone = parseThaiMobile('+66812345678')!;
    expect(profilePhoneVariants(phone)).toEqual([
      '0812345678',
      '+66812345678',
      '66812345678',
    ]);
  });

  it('เทียบข้ามรูปแบบได้ (auth.users เก็บ 668…, users.phone เก็บ 08…)', () => {
    expect(isSamePhone('66812345678', '0812345678')).toBe(true);
    expect(isSamePhone('+66812345678', '081-234-5678')).toBe(true);
    expect(isSamePhone('66812345678', '0899999999')).toBe(false);
    expect(isSamePhone(null, '0812345678')).toBe(false);
    expect(isSamePhone('junk', 'junk')).toBe(false);
  });
});
