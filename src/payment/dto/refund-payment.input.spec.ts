/**
 * RefundPaymentInput boundary validation (PYG-374 follow-up)
 *
 * RefundService บังคับ reason >= 10 ทุกเส้นทาง (รวม admin_manual). test นี้พิสูจน์ว่า
 * admin refund mutation ถูก reject "ที่ boundary" (ValidationPipe รัน class-validator
 * ตัวเดียวกับที่ประกาศใน DTO) พร้อมข้อความไทย — ไม่ตกลึกใน service หลัง FE ส่งไปแล้ว
 *
 * main.ts ตั้ง app.useGlobalPipes(new ValidationPipe({ whitelist, forbidNonWhitelisted }))
 * → constraint ใน DTO นี้ทำงานกับทุก GraphQL mutation ที่รับ RefundPaymentInput
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RefundPaymentInput } from './refund-payment.input';

const VALID_UUID = '11111111-1111-4111-8111-111111111111';
const THAI = 'กรุณาระบุเหตุผลอย่างน้อย 10 ตัวอักษร';

function validateInput(obj: Record<string, unknown>) {
  return validate(plainToInstance(RefundPaymentInput, obj));
}

/** ดึงข้อความ constraint ทั้งหมดของ property `reason` */
async function reasonMessages(obj: Record<string, unknown>): Promise<string[]> {
  const errors = await validateInput(obj);
  const err = errors.find((e) => e.property === 'reason');
  return err ? Object.values(err.constraints ?? {}) : [];
}

describe('RefundPaymentInput — reason validation at API boundary (PYG-374)', () => {
  it('missing reason → rejected with Thai message', async () => {
    expect(await reasonMessages({ paymentId: VALID_UUID })).toContain(THAI);
  });

  it('empty reason → rejected with Thai message', async () => {
    expect(await reasonMessages({ paymentId: VALID_UUID, reason: '' })).toContain(THAI);
  });

  it('short reason (< 10 chars) → rejected with Thai message', async () => {
    expect(await reasonMessages({ paymentId: VALID_UUID, reason: 'สั้นไป' })).toContain(THAI);
  });

  it('valid reason (>= 10 chars) → no reason error', async () => {
    const errors = await validateInput({
      paymentId: VALID_UUID,
      reason: 'ผู้ป่วยยกเลิกบริการก่อนวันนัด',
    });
    expect(errors.find((e) => e.property === 'reason')).toBeUndefined();
  });

  it('valid full-refund payload (no amount) with good reason → passes', async () => {
    const errors = await validateInput({
      paymentId: VALID_UUID,
      reason: 'service not delivered as agreed',
    });
    expect(errors).toHaveLength(0);
  });

  it('reason over 500 chars → still rejected by MaxLength', async () => {
    const errors = await validateInput({
      paymentId: VALID_UUID,
      reason: 'ก'.repeat(501),
    });
    expect(errors.find((e) => e.property === 'reason')).toBeDefined();
  });
});
