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
  insufficient_fund: 'ยอดเงินในบัตรไม่เพียงพอ',
  stolen_or_lost_card: 'บัตรถูกแจ้งว่าหายหรือถูกขโมย กรุณาติดต่อธนาคาร',
  failed_fraud_check: 'การชำระเงินถูกปฏิเสธด้วยเหตุผลด้านความปลอดภัย',
  payment_rejected: 'การชำระเงินถูกปฏิเสธ กรุณาติดต่อธนาคารผู้ออกบัตร',
  invalid_account_number: 'หมายเลขบัตรไม่ถูกต้อง',
  invalid_security_code: 'รหัสความปลอดภัยของบัตร (CVV) ไม่ถูกต้อง',
  expired_card: 'บัตรเครดิตนี้หมดอายุแล้ว',
  card_declined: 'บัตรถูกปฏิเสธ กรุณาใช้บัตรอื่นหรือติดต่อธนาคาร',
  timeout: 'หมดเวลาการเชื่อมต่อ กรุณาลองใหม่อีกครั้ง',
};

export function mapOmiseFailureCode(code: string | null | undefined): string {
  if (!code) return 'การชำระเงินล้มเหลว กรุณาลองใหม่หรือใช้บัตรอื่น';
  return (
    OMISE_FAILURE_MESSAGES[code] ??
    'การชำระเงินล้มเหลว กรุณาลองใหม่หรือใช้บัตรอื่น'
  );
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
