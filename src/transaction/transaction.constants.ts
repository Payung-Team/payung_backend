/**
 * PYG-333 — ค่าคงที่ + helper สำหรับ transaction module (admin read-only)
 */

/**
 * สถานะ payment ที่ถือว่าเป็น "refund" (เงินคืน patient)
 * ต้องตรงกับ enum PaymentStatus ใน schema.prisma (@@map payment_status_enum)
 * ถ้าเพิ่มสถานะ refund ใหม่ในอนาคต → เพิ่มที่นี่ด้วย
 */
export const REFUND_PAYMENT_STATUSES = ['refunded', 'partially_refunded'];

/** สกุลเงินเริ่มต้นของระบบ — payouts ไม่มี column currency (ตลาดไทย) */
export const DEFAULT_CURRENCY = 'THB';

/** ตัวคั่นใน composite id ของ transaction เช่น "payment:<uuid>" */
export const TXN_ID_SEP = ':';

/** แหล่งข้อมูลจริงของ transaction (ตารางต้นทาง) */
export type TxnSource = 'payment' | 'payout';

/**
 * สร้าง composite id ให้ transaction — เพราะ id ของ payment/payout เป็น UUID
 * คนละตาราง อาจซ้ำกันได้ (ในทางทฤษฎี) → prefix ด้วยแหล่งที่มาเพื่อให้ query detail
 * รู้ว่าต้องไปหาในตารางไหน เช่น "payment:2f9c...", "payout:8ab1..."
 */
export function buildTxnId(source: TxnSource, uuid: string): string {
  return `${source}${TXN_ID_SEP}${uuid}`;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ตรวจว่า string เป็น UUID — กัน Postgres error ตอน filter column uuid ด้วยค่าที่ไม่ใช่ UUID */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * แยก composite id กลับเป็น { source, uuid } — คืน null ถ้ารูปแบบไม่ถูกต้อง
 * (prefix ไม่ใช่ payment/payout หรือส่วน uuid ไม่ใช่ UUID จริง)
 */
export function parseTxnId(
  id: string,
): { source: TxnSource; uuid: string } | null {
  const sepIndex = id.indexOf(TXN_ID_SEP);
  if (sepIndex <= 0) return null;

  const source = id.slice(0, sepIndex);
  const uuid = id.slice(sepIndex + 1);

  if (source !== 'payment' && source !== 'payout') return null;
  if (!isUuid(uuid)) return null;

  return { source, uuid };
}
