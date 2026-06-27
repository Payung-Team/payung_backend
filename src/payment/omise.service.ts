import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// ── Minimal Omise types (SDK has no official @types package) ─────────────────
export interface OmiseCharge {
  id: string;
  status: string; // 'pending' | 'successful' | 'failed' | 'reversed'
  authorized: boolean;
  captured: boolean;
  amount: number; // satangs
  currency: string;
  failure_code: string | null;
  failure_message: string | null;
  card?: { id: string; last_digits: string; brand: string };
  source?: {
    type: string; // 'promptpay' | 'internet_banking_...' etc.
    scannable_code?: {
      image?: {
        download_uri?: string; // QR code image URL for PromptPay
      };
    };
  };
}

export interface OmiseRefund {
  id: string;
  amount: number;
  currency: string;
  charge: string;
  status: string;
}

interface OmiseChargesResource {
  create(data: Record<string, unknown>): Promise<OmiseCharge>;
  retrieve(chargeId: string): Promise<OmiseCharge>;
  capture(chargeId: string): Promise<OmiseCharge>;
  reverse(chargeId: string): Promise<OmiseCharge>;
  createRefund(
    chargeId: string,
    data: Record<string, unknown>,
  ): Promise<OmiseRefund>;
}

interface OmiseSdkClient {
  charges: OmiseChargesResource;
}

// ── Thai error messages keyed by Omise failure_code ─────────────────────────
const OMISE_FAILURE_MESSAGES: Record<string, string> = {
  // ── ยอดเงิน / วงเงิน ───────────────────────────────────────────────────────
  insufficient_fund:    'ยอดเงินในบัตรไม่เพียงพอ กรุณาเติมเงินหรือใช้บัตรอื่น',
  insufficient_balance: 'ยอดเงินในบัตรไม่เพียงพอ กรุณาเติมเงินหรือใช้บัตรอื่น',
  limit_exceeded:       'วงเงินบัตรเต็ม กรุณาชำระยอดบัตรหรือใช้บัตรอื่น',

  // ── ข้อมูลบัตรไม่ถูกต้อง ──────────────────────────────────────────────────
  invalid_account_number: 'หมายเลขบัตรไม่ถูกต้อง กรุณาตรวจสอบและลองใหม่',
  invalid_security_code:  'รหัส CVV ไม่ถูกต้อง กรุณาตรวจสอบตัวเลข 3 หลักหลังบัตร',
  invalid_expiry_date:    'วันหมดอายุบัตรไม่ถูกต้อง กรุณาตรวจสอบและลองใหม่',
  expired_card:           'บัตรเครดิตนี้หมดอายุแล้ว กรุณาใช้บัตรใบใหม่',

  // ── บัตรถูกปฏิเสธ / ระงับ ─────────────────────────────────────────────────
  card_declined:                'บัตรถูกปฏิเสธ กรุณาใช้บัตรอื่น',
  do_not_honor:                 'ธนาคารปฏิเสธรายการ กรุณาใช้บัตรอื่น',
  do_not_honor_security:        'ธนาคารปฏิเสธรายการด้วยเหตุผลด้านความปลอดภัย กรุณาใช้บัตรอื่น',
  restricted_card:              'บัตรนี้ถูกจำกัดการใช้งาน กรุณาใช้บัตรอื่น',
  revocation_of_authorization:  'ธนาคารยกเลิกการอนุมัติ กรุณาใช้บัตรอื่น',
  pickup_card:                  'ธนาคารระงับบัตรนี้ไว้ กรุณาใช้บัตรอื่น',
  transaction_not_permitted:    'รายการนี้ไม่ได้รับอนุญาตสำหรับบัตรใบนี้ กรุณาใช้บัตรอื่น',
  card_not_supported:           'บัตรประเภทนี้ไม่รองรับ กรุณาใช้บัตร Visa, Mastercard หรือ JCB',

  // ── บัตรหาย / ถูกขโมย ─────────────────────────────────────────────────────
  stolen_or_lost_card: 'บัตรถูกแจ้งว่าหายหรือถูกขโมย กรุณาใช้บัตรอื่น',
  lost_card:           'บัตรถูกแจ้งว่าหาย กรุณาใช้บัตรอื่น',
  stolen_card:         'บัตรถูกแจ้งว่าถูกขโมย กรุณาใช้บัตรอื่น',

  // ── ความปลอดภัย / 3DS ─────────────────────────────────────────────────────
  failed_fraud_check:     'การชำระเงินถูกปฏิเสธด้วยเหตุผลด้านความปลอดภัย กรุณาใช้บัตรอื่น',
  authentication_failure: 'การยืนยันตัวตน 3D Secure ล้มเหลว กรุณาลองใหม่',
  no_card_enrolled:       'บัตรนี้ยังไม่ได้ลงทะเบียน 3D Secure กรุณาใช้บัตรอื่น',

  // ── การปฏิเสธทั่วไป ────────────────────────────────────────────────────────
  payment_rejected: 'การชำระเงินถูกปฏิเสธ กรุณาใช้บัตรอื่น',

  // ── เครือข่าย / timeout ────────────────────────────────────────────────────
  timeout: 'หมดเวลาการเชื่อมต่อ กรุณาลองใหม่อีกครั้ง',
};

export function mapOmiseFailureCode(code: string | null | undefined): string {
  if (!code) return 'การชำระเงินล้มเหลว กรุณาลองใหม่หรือใช้บัตรอื่น';
  return OMISE_FAILURE_MESSAGES[code] ?? `การชำระเงินล้มเหลว (${code}) กรุณาลองใหม่หรือใช้บัตรอื่น`;
}

// ── Service ───────────────────────────────────────────────────────────────────
@Injectable()
export class OmiseService {
  private readonly logger = new Logger(OmiseService.name);
  private readonly client: OmiseSdkClient;

  constructor(private readonly config: ConfigService) {
    // omise is a CommonJS module — import via require to avoid ESM issues
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const OmiseSdk = require('omise') as (cfg: {
      publicKey: string;
      secretKey: string;
    }) => OmiseSdkClient;

    this.client = OmiseSdk({
      publicKey: this.config.getOrThrow<string>('OMISE_PUBLIC_KEY'),
      secretKey: this.config.getOrThrow<string>('OMISE_SECRET_KEY'),
    });
  }

  /** สร้าง charge — ใช้ capture:false เพื่อ authorize (hold) ไว้ก่อน */
  createCharge(params: {
    amount: number; // satangs
    currency: string;
    card: string; // Omise token id
    capture: boolean;
    description?: string;
  }): Promise<OmiseCharge> {
    const data: Record<string, unknown> = {
      amount: params.amount,
      currency: params.currency,
      card: params.card,
      capture: params.capture,
    };
    if (params.description) data['description'] = params.description;
    this.logger.debug(
      `createCharge amount=${params.amount} capture=${params.capture}`,
    );
    return this.client.charges.create(data);
  }

  /** Capture a previously authorized charge */
  captureCharge(chargeId: string): Promise<OmiseCharge> {
    this.logger.debug(`captureCharge id=${chargeId}`);
    return this.client.charges.capture(chargeId);
  }

  /** Void (reverse) a held charge before capture */
  voidCharge(chargeId: string): Promise<OmiseCharge> {
    this.logger.debug(`voidCharge id=${chargeId}`);
    return this.client.charges.reverse(chargeId);
  }

  /** ดึง charge ปัจจุบันจาก Omise (ใช้สำหรับ reconciliation polling) */
  retrieveCharge(chargeId: string): Promise<OmiseCharge> {
    this.logger.debug(`retrieveCharge id=${chargeId}`);
    return this.client.charges.retrieve(chargeId);
  }

  /** สร้าง PromptPay charge — Omise คืน QR code image URL ใน source.scannable_code */
  createPromptPayCharge(params: {
    amount: number; // satangs
    currency: string;
  }): Promise<OmiseCharge> {
    this.logger.debug(`createPromptPayCharge amount=${params.amount}`);
    return this.client.charges.create({
      amount: params.amount,
      currency: params.currency,
      source: { type: 'promptpay' },
    });
  }

  /** Refund a captured charge (full refund if amount omitted) */
  createRefund(chargeId: string, amountSatangs?: number): Promise<OmiseRefund> {
    const data: Record<string, unknown> = {};
    if (amountSatangs !== undefined) data['amount'] = amountSatangs;
    this.logger.debug(
      `createRefund chargeId=${chargeId} amount=${amountSatangs ?? 'full'}`,
    );
    return this.client.charges.createRefund(chargeId, data);
  }
}
