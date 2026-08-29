/**
 * OmiseService — ตัวห่อ (wrapper) เรียก Omise payment gateway ผ่าน REST API (PYG-281)
 *
 * ทำไมเรียก REST เองแทนใช้ SDK `omise`?
 * - โปรเจกต์นี้ไม่ได้ติดตั้ง SDK ของ Omise (webhook controller ก็ hand-roll HMAC เองด้วย crypto)
 * - capture เป็น request เดียวง่ายๆ → ใช้ global fetch (Node 18+) พอ ไม่ต้องเพิ่ม dependency
 *
 * หน้าที่ตอนนี้:
 * - captureCharge(omiseChargeId) — PYG-281: ตัดเงินจริงจากวงเงินที่ "held"
 * - createCharge(amount, token) — PYG-281: กันวงเงิน (authorize) capture=false
 * - reverseCharge(omiseChargeId) — PYG-281: ยกเลิกการกัน hold (expire / void)
 * - voidCharge(omiseChargeId) — PYG-286: semantic alias ของ reverseCharge สำหรับ auto-void on cancel
 * - createRefund(omiseChargeId, amountSatangs?) — PYG-286: คืนเงินจาก charge ที่ capture แล้ว (เต็ม/บางส่วน)
 * - createPromptPayCharge(amount) — PYG-278: สร้าง PromptPay charge (source[type]=promptpay) + คืน QR
 * - retrieveCharge(omiseChargeId) — PYG-278: GET /charges/:id สำหรับ polling / webhook reconciliation
 * - createTransfer(amountSatangs, recipientId, idempotencyKey) — PYG-330 ก้อน B:
 *     โอนเงินไปยัง Omise recipient (ใช้ Omise-Idempotency-Key กันโอนซ้ำ)
 *
 * Auth ของ Omise = HTTP Basic โดยใช้ secret key เป็น username, password ว่าง
 *   → header: Authorization: Basic base64("<SECRET_KEY>:")
 *
 * ทุก error (ไม่มี key / network / Omise ตอบ error / charge ไม่ successful)
 *   จะถูกแปลงเป็น CaptureFailedError พร้อม details เพื่อให้ชั้นบน log + แจ้ง admin ได้
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CaptureFailedError } from '../errors/capture-failed.error';
import { mapOmiseError } from '../errors/omise-error-mapper';

/** PYG-330 (ก้อน B): ผลลัพธ์จาก POST /transfers */
export type OmiseTransferResult = {
  /** transfer id ของ Omise (เก็บลง payouts.omise_transfer_id) */
  id: string;
  /** สถานะ transfer หลังสร้าง — Omise ปกติคืน pending → ต้องรอ webhook ยืนยัน sent/paid */
  status: string;
  /** จำนวนเงิน (satangs) ตามที่ Omise บันทึก */
  amount: number;
  /** recipient id ที่โอนไปถึง */
  recipient: string;
  /** สกุลเงิน (uppercase) */
  currency: string;
  /** โอนสำเร็จหรือยัง */
  sent: boolean;
  /** เงินเข้าบัญชีปลายทางแล้วหรือยัง */
  paid: boolean;
  failure_code?: string;
  failure_message?: string;
};

/** PYG-278: ผลลัพธ์จาก POST /charges กับ source[type]=promptpay (เน้นที่ QR + chargeId) */
export type OmisePromptPayResult = {
  /** charge id ของ Omise — เก็บลง payment.omiseChargeId */
  id: string;
  /** สถานะหลังสร้าง — PromptPay จะเป็น 'pending' จนกว่าจะ scan + bank confirm */
  status: string;
  /** จำนวนเงิน (satangs) ตามที่ Omise บันทึก */
  amount: number;
  /** captured/paid/authorized — PromptPay ตอนสร้างจะเป็น false ทั้งหมด */
  captured: boolean;
  paid: boolean;
  authorized: boolean;
  /** QR code image URL จาก source.scannable_code.image.download_uri (อาจ undefined ถ้า Omise ไม่ส่ง) */
  qrCodeUrl?: string;
  failure_code?: string;
  failure_message?: string;
};

/** PYG-286: ผลลัพธ์จาก /charges/:id/refunds (เอาเฉพาะ field ที่ต้องบันทึก audit) */
export type OmiseRefundResult = {
  /** refund id ของ Omise (เก็บใน payment.metadata.omiseRefundId) */
  id: string;
  /** จำนวนเงินที่คืน (หน่วย satangs ตามที่ Omise บันทึก) */
  amount: number;
  /** charge id ของ Omise ที่ refund อ้างถึง */
  charge: string;
  /** สกุลเงิน (3-letter ISO) */
  currency: string;
  /** Omise คืน voided=true เมื่อ refund เป็นการ void ก่อน settle */
  voided: boolean;
};

/** PYG-266: ผลลัพธ์จาก POST/GET /recipients (เอาเฉพาะ field ที่ต้องใช้ต่อ) */
export type OmiseRecipientResult = {
  /** recipient id ของ Omise (เก็บใน caregiver_payout_accounts.omise_recipient_id) */
  id: string;
  /** Omise ยืนยันบัญชีนี้แล้วหรือยัง (recipient.verified webhook เปลี่ยนค่านี้) */
  verified: boolean;
  /** recipient พร้อมรับโอนไหม (Omise-side active flag) */
  active: boolean;
  bankAccount: {
    brand: string;
    lastDigits: string;
    name: string;
  };
};

/** ผลลัพธ์ที่ normalize แล้วจากการ capture (เอาเฉพาะ field ที่เราต้องใช้ต่อ) */
export type OmiseCaptureResult = {
  /** charge id ของ Omise */
  id: string;
  /** สถานะ charge หลัง capture — คาดหวัง 'successful' */
  status: string;
  /** จำนวนเงิน (หน่วยเล็กสุด เช่น สตางค์) ที่ Omise บันทึก */
  amount: number;
  /** capture แล้วจริงหรือยัง */
  captured: boolean;
  /** จ่ายเงินสำเร็จหรือยัง */
  paid: boolean;
  /** สถานะการ authorize */
  authorized: boolean;
  /** ข้อมูล error ถ้าการจ่ายเงินล้มเหลว */
  failure_code?: string;
  failure_message?: string;
  /**
   * PYG-375: charge หมดอายุเมื่อไหร่ (ISO string) — Omise ส่งมากับ PromptPay/source charges
   * ใช้ตัดสิน "charge ตายจริง" (expiresAt < now && !paid) แทนการเดาจากอายุ wall-clock
   */
  expiresAt?: string | null;
};

@Injectable()
export class OmiseService {
  private readonly logger = new Logger(OmiseService.name);

  /** base url ของ Omise API — override ได้ผ่าน env (ใช้ mock ตอนทดสอบ) */
  private readonly apiBase: string;
  /** secret key — undefined ได้ถ้ายังไม่ตั้งค่า (dev/test) → capture จะ throw อย่างชัดเจน */
  private readonly secretKey?: string;

  constructor(private readonly config: ConfigService) {
    this.apiBase = this.config.get<string>(
      'OMISE_API_BASE',
      'https://api.omise.co',
    );
    this.secretKey = this.config.get<string>('OMISE_SECRET_KEY');
  }

  /**
   * captureCharge — สั่ง Omise ตัดเงินจริงจาก charge ที่ held ไว้
   *
   * @param omiseChargeId - charge id ที่ได้ตอน authorize/hold (เช่น 'chrg_xxx')
   * @returns ข้อมูล charge หลัง capture (normalize แล้ว)
   * @throws CaptureFailedError ถ้า capture ไม่สำเร็จไม่ว่าด้วยเหตุใด
   */
  async captureCharge(
    omiseChargeId: string,
    idempotencyKey?: string,
  ): Promise<OmiseCaptureResult> {
    // 0) ยังไม่ตั้งค่า secret key → fail ชัดเจน (ไม่เงียบ ไม่แกล้งสำเร็จ)
    if (!this.secretKey) {
      throw new CaptureFailedError(
        'ยังไม่ได้ตั้งค่า OMISE_SECRET_KEY — ไม่สามารถ capture เงินได้',
        { omiseChargeId },
      );
    }
    // กันเคส charge id หาย (payment ยังไม่เคย authorize/hold)
    if (!omiseChargeId) {
      throw new CaptureFailedError(
        'payment ไม่มี omiseChargeId — ยังไม่ได้กันวงเงิน',
        {},
      );
    }

    const url = `${this.apiBase}/charges/${encodeURIComponent(omiseChargeId)}/capture`;
    // Basic auth: base64("<secret>:") — password ว่างตามสเปก Omise
    const authHeader =
      'Basic ' + Buffer.from(`${this.secretKey}:`).toString('base64');

    // PYG-375: ส่ง Omise-Idempotency-Key เพื่อกัน capture ซ้ำ (layer ที่ 2 ต่อจาก idempotency_keys)
    const captureHeaders: Record<string, string> = { Authorization: authHeader };
    if (idempotencyKey) {
      captureHeaders['Omise-Idempotency-Key'] = idempotencyKey;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: captureHeaders,
      });
    } catch (err) {
      // network error / DNS / timeout — Omise ติดต่อไม่ได้
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[Omise] capture network error chargeId=${omiseChargeId}: ${message}`,
      );
      throw new CaptureFailedError('ติดต่อ Omise ไม่สำเร็จขณะ capture เงิน', {
        omiseChargeId,
        omiseMessage: message,
      });
    }

    // อ่าน body แบบปลอดภัย (เผื่อ Omise ตอบ non-JSON)
    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    // 1) Omise ตอบ error object หรือ HTTP ไม่ใช่ 2xx → capture พัง
    if (!res.ok || body.object === 'error') {
      const omiseCode = typeof body.code === 'string' ? body.code : undefined;
      const omiseMessage =
        typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
      this.logger.error(
        `[Omise] capture failed chargeId=${omiseChargeId} status=${res.status} code=${omiseCode} message=${omiseMessage}`,
      );
      throw new CaptureFailedError('Omise ปฏิเสธการ capture เงิน', {
        omiseChargeId,
        omiseCode,
        omiseMessage,
        httpStatus: res.status,
      });
    }

    // 2) HTTP 200 แต่ charge ไม่ได้ capture/ไม่สำเร็จ → ถือว่าพังเช่นกัน
    const status = typeof body.status === 'string' ? body.status : 'unknown';
    const paid = body.paid === true;
    const captured = paid; // Omise ไม่มี field "captured" — paid คือ field ที่ถูกต้องตาม docs (docs.omise.co/charges-api: "paid: Whether charge has been captured (paid)")
    if (status !== 'successful' || !paid) {
      const omiseCode =
        typeof body.failure_code === 'string' ? body.failure_code : undefined;
      const omiseMessage =
        typeof body.failure_message === 'string'
          ? body.failure_message
          : `charge status=${status}, captured=${captured}`;
      this.logger.error(
        `[Omise] capture not successful chargeId=${omiseChargeId} status=${status} captured=${captured} code=${omiseCode}`,
      );
      throw new CaptureFailedError('Omise capture ไม่สำเร็จ', {
        omiseChargeId,
        omiseCode,
        omiseMessage,
      });
    }

    return {
      id: typeof body.id === 'string' ? body.id : omiseChargeId,
      status,
      amount: typeof body.amount === 'number' ? body.amount : 0,
      captured,
      paid,
      authorized: body.authorized === true,
      failure_code:
        typeof body.failure_code === 'string' ? body.failure_code : undefined,
      failure_message:
        typeof body.failure_message === 'string'
          ? body.failure_message
          : undefined,
    };
  }

  /**
   * createCharge — สั่งกันวงเงิน (authorize) จาก Omise แบบ capture=false
   *
   * @param amount - จำนวนเงิน (หน่วย satangs)
   * @param token - Omise token ของบัตร
   * @returns ข้อมูล charge ที่เพิ่งสร้าง
   * @throws PaymentError ถ้ากันวงเงินไม่สำเร็จ
   */
  async createCharge(
    amount: number,
    token: string,
  ): Promise<OmiseCaptureResult> {
    if (!this.secretKey) {
      throw mapOmiseError('config_error', 'ยังไม่ได้ตั้งค่า OMISE_SECRET_KEY');
    }

    const url = `${this.apiBase}/charges`;
    const authHeader =
      'Basic ' + Buffer.from(`${this.secretKey}:`).toString('base64');

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          amount: amount.toString(),
          currency: 'thb',
          card: token,
          capture: 'false',
        }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[Omise] createCharge network error: ${message}`);
      throw mapOmiseError(
        'network_error',
        'ติดต่อ Omise ไม่สำเร็จขณะสร้าง charge',
        { omiseMessage: message },
      );
    }

    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    // กรณี HTTP ไม่สำเร็จ (เช่น token ผิด, invalid request)
    if (!res.ok || body.object === 'error') {
      const omiseCode = typeof body.code === 'string' ? body.code : undefined;
      const omiseMessage =
        typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
      this.logger.error(
        `[Omise] createCharge failed status=${res.status} code=${omiseCode} message=${omiseMessage}`,
      );
      throw mapOmiseError(omiseCode, omiseMessage, {
        omiseCode,
        omiseMessage,
        httpStatus: res.status,
      });
    }

    const status = typeof body.status === 'string' ? body.status : 'unknown';
    const authorized = body.authorized === true;
    const failureCode =
      typeof body.failure_code === 'string' ? body.failure_code : undefined;
    const failureMessage =
      typeof body.failure_message === 'string'
        ? body.failure_message
        : undefined;

    // ตรวจสอบว่าสำเร็จไหม: สำหรับ capture=false, authorized ควรเป็น true หรือ status เป็น 'pending' / 'successful'
    // ถ้าระบุว่า failed ก็จัดการด้วย PaymentError
    if (status === 'failed' || !authorized) {
      this.logger.error(
        `[Omise] createCharge not authorized status=${status} authorized=${authorized} failureCode=${failureCode}`,
      );
      throw mapOmiseError(failureCode || 'not_authorized', failureMessage, {
        omiseCode: failureCode,
        omiseMessage: failureMessage,
      });
    }

    return {
      id: typeof body.id === 'string' ? body.id : '',
      status,
      amount: typeof body.amount === 'number' ? body.amount : 0,
      captured: body.paid === true,
      paid: body.paid === true,
      authorized,
      failure_code: failureCode,
      failure_message: failureMessage,
    };
  }

  /**
   * reverseCharge — ยกเลิกการกันวงเงิน (authorize) ที่เกินเวลาหรือไม่ได้ใช้งาน
   *
   * @param omiseChargeId - charge id ของ Omise
   * @returns ผลลัพธ์จากการ reverse
   */
  async reverseCharge(omiseChargeId: string): Promise<OmiseCaptureResult> {
    if (!this.secretKey) {
      throw new Error('ยังไม่ได้ตั้งค่า OMISE_SECRET_KEY');
    }

    const url = `${this.apiBase}/charges/${encodeURIComponent(omiseChargeId)}/reverse`;
    const authHeader =
      'Basic ' + Buffer.from(`${this.secretKey}:`).toString('base64');

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: authHeader },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[Omise] reverseCharge network error chargeId=${omiseChargeId}: ${message}`,
      );
      throw new Error(`ติดต่อ Omise ไม่สำเร็จขณะ reverse เงิน: ${message}`);
    }

    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    if (!res.ok || body.object === 'error') {
      const omiseCode = typeof body.code === 'string' ? body.code : undefined;
      const omiseMessage =
        typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
      this.logger.error(
        `[Omise] reverseCharge failed chargeId=${omiseChargeId} status=${res.status} code=${omiseCode} message=${omiseMessage}`,
      );
      throw new Error(`Omise ปฏิเสธการ reverse เงิน: ${omiseMessage}`);
    }

    return {
      id: typeof body.id === 'string' ? body.id : omiseChargeId,
      status: typeof body.status === 'string' ? body.status : 'unknown',
      amount: typeof body.amount === 'number' ? body.amount : 0,
      captured: body.paid === true,
      paid: body.paid === true,
      authorized: body.authorized === true,
      failure_code:
        typeof body.failure_code === 'string' ? body.failure_code : undefined,
      failure_message:
        typeof body.failure_message === 'string'
          ? body.failure_message
          : undefined,
    };
  }

  /**
   * voidCharge — PYG-286 alias ของ reverseCharge สำหรับ semantic ที่ใช้ใน auto-void on cancel
   *
   * Omise treats "void" (ยกเลิก authorize hold ก่อน capture) เป็นการ reverse charge อันเดียวกัน
   * เราแยกชื่อเพื่อให้ตอนอ่านโค้ดของ booking.cancelBooking ชัดว่าเป็นการคืน hold ไม่ใช่ expire
   */
  async voidCharge(omiseChargeId: string): Promise<OmiseCaptureResult> {
    return this.reverseCharge(omiseChargeId);
  }

  /**
   * createRefund — PYG-286: คืนเงินจาก charge ที่ capture แล้ว (refund_full / refund_partial)
   *
   * @param omiseChargeId  - charge id ของ Omise ที่อยู่ในสถานะ captured/successful
   * @param amountSatangs  - จำนวนเงินที่จะคืน (หน่วย satangs). undefined = คืนเต็มจำนวน
   * @param idempotencyKey - (recommended) ส่ง Omise-Idempotency-Key เพื่อกัน double-refund race
   *                         Omise dedup ที่ฝั่งเขา: same key + same charge → return cached response
   *                         (ไม่ส่ง = MVP fallback, ใช้ status pre-check + FSM ป้องกันแทน)
   * @returns ข้อมูล refund (refund id ใช้สำหรับ audit + บันทึก metadata)
   * @throws PaymentError ถ้า Omise ปฏิเสธหรือ network ติดต่อไม่ได้
   *
   * หมายเหตุ:
   * - amount = undefined → ไม่ส่ง param `amount` ไปให้ Omise = refund เต็มจำนวน
   *   ถ้าระบุ → Omise ตรวจสอบ amount ≤ captured ปัจจุบัน (ชั้นบนตรวจอีกชั้น)
   * - การคืนเงินซ้ำป้องกัน 3 ชั้น: (1) status pre-check, (2) re-check ก่อนเรียก Omise,
   *   (3) Omise-Idempotency-Key (ถ้าส่ง), + FSM transition กัน state ผิด
   */
  async createRefund(
    omiseChargeId: string,
    amountSatangs?: number,
    idempotencyKey?: string,
  ): Promise<OmiseRefundResult> {
    if (!this.secretKey) {
      throw mapOmiseError('config_error', 'ยังไม่ได้ตั้งค่า OMISE_SECRET_KEY');
    }
    if (!omiseChargeId) {
      throw mapOmiseError(
        'invalid_request',
        'ไม่มี omiseChargeId — ไม่สามารถคืนเงินได้',
      );
    }

    const url = `${this.apiBase}/charges/${encodeURIComponent(omiseChargeId)}/refunds`;
    const authHeader =
      'Basic ' + Buffer.from(`${this.secretKey}:`).toString('base64');

    const formBody = new URLSearchParams();
    if (amountSatangs !== undefined) {
      formBody.set('amount', String(amountSatangs));
    }

    const headers: Record<string, string> = {
      Authorization: authHeader,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (idempotencyKey) {
      headers['Omise-Idempotency-Key'] = idempotencyKey;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: formBody,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[Omise] createRefund network error chargeId=${omiseChargeId}: ${message}`,
      );
      throw mapOmiseError('network_error', 'ติดต่อ Omise ไม่สำเร็จขณะคืนเงิน', {
        omiseChargeId,
        omiseMessage: message,
      });
    }

    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    if (!res.ok || body.object === 'error') {
      const omiseCode = typeof body.code === 'string' ? body.code : undefined;
      const omiseMessage =
        typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
      this.logger.error(
        `[Omise] createRefund failed chargeId=${omiseChargeId} status=${res.status} code=${omiseCode} message=${omiseMessage}`,
      );
      throw mapOmiseError(omiseCode ?? 'refund_failed', omiseMessage, {
        omiseChargeId,
        omiseCode,
        omiseMessage,
        httpStatus: res.status,
      });
    }

    return {
      id: typeof body.id === 'string' ? body.id : '',
      amount: typeof body.amount === 'number' ? body.amount : 0,
      charge: typeof body.charge === 'string' ? body.charge : omiseChargeId,
      currency:
        typeof body.currency === 'string' ? body.currency.toUpperCase() : 'THB',
      voided: body.voided === true,
    };
  }

  /**
   * createPromptPayCharge — PYG-278: สร้าง PromptPay charge (Omise คืน QR code URL)
   *
   * ต่างจาก createCharge (บัตร):
   * - ใช้ source[type]=promptpay (ไม่ใช่ card token)
   * - ไม่มี capture=false — PromptPay จ่ายเต็มทันทีเมื่อ user สแกน (charge.complete webhook)
   * - คืน QR URL จาก source.scannable_code.image.download_uri
   *
   * @param amountSatangs - จำนวนเงิน (หน่วย satangs)
   * @returns charge ที่เพิ่งสร้าง (status='pending' จนกว่า user จะ scan + bank confirm)
   * @throws PaymentError ถ้าสร้าง charge ไม่สำเร็จ
   */
  async createPromptPayCharge(
    amountSatangs: number,
  ): Promise<OmisePromptPayResult> {
    if (!this.secretKey) {
      throw mapOmiseError('config_error', 'ยังไม่ได้ตั้งค่า OMISE_SECRET_KEY');
    }

    const url = `${this.apiBase}/charges`;
    const authHeader =
      'Basic ' + Buffer.from(`${this.secretKey}:`).toString('base64');

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        // x-www-form-urlencoded ของ Omise รับ nested key แบบ source[type]=promptpay
        body: new URLSearchParams({
          amount: amountSatangs.toString(),
          currency: 'thb',
          'source[type]': 'promptpay',
        }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[Omise] createPromptPayCharge network error: ${message}`,
      );
      throw mapOmiseError(
        'network_error',
        'ติดต่อ Omise ไม่สำเร็จขณะสร้าง PromptPay charge',
        {
          omiseMessage: message,
        },
      );
    }

    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    if (!res.ok || body.object === 'error') {
      const omiseCode = typeof body.code === 'string' ? body.code : undefined;
      const omiseMessage =
        typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
      this.logger.error(
        `[Omise] createPromptPayCharge failed status=${res.status} code=${omiseCode} message=${omiseMessage}`,
      );
      throw mapOmiseError(omiseCode, omiseMessage, {
        omiseCode,
        omiseMessage,
        httpStatus: res.status,
      });
    }

    // ดึง QR URL จาก nested source.scannable_code.image.download_uri (safe access)
    const source = (body.source ?? {}) as Record<string, unknown>;
    const scannable = (source.scannable_code ?? {}) as Record<string, unknown>;
    const image = (scannable.image ?? {}) as Record<string, unknown>;
    const qrCodeUrl =
      typeof image.download_uri === 'string' ? image.download_uri : undefined;

    return {
      id: typeof body.id === 'string' ? body.id : '',
      status: typeof body.status === 'string' ? body.status : 'unknown',
      amount: typeof body.amount === 'number' ? body.amount : 0,
      captured: body.paid === true,
      paid: body.paid === true,
      authorized: body.authorized === true,
      qrCodeUrl,
      failure_code:
        typeof body.failure_code === 'string' ? body.failure_code : undefined,
      failure_message:
        typeof body.failure_message === 'string'
          ? body.failure_message
          : undefined,
    };
  }

  /**
   * retrieveCharge — PYG-278: GET /charges/:id (read-only)
   *
   * ใช้สำหรับ:
   *  - polling fallback ของ PromptPay (paymentByBooking query)
   *  - reconciliation จาก webhook
   *
   * คืน OmiseCaptureResult format เดียวกับ captureCharge/createCharge เพื่อให้
   * ผู้เรียกประมวลผลด้วย logic เดียวกัน
   *
   * @param omiseChargeId - charge id ของ Omise (เช่น 'chrg_xxx')
   * @returns สถานะ charge ปัจจุบัน
   * @throws Error ถ้า Omise ตอบ error หรือ network ติดต่อไม่ได้
   */
  async retrieveCharge(omiseChargeId: string): Promise<OmiseCaptureResult> {
    if (!this.secretKey) {
      throw new Error('ยังไม่ได้ตั้งค่า OMISE_SECRET_KEY');
    }
    if (!omiseChargeId) {
      throw new Error('ไม่มี omiseChargeId — ไม่สามารถ retrieve charge ได้');
    }

    const url = `${this.apiBase}/charges/${encodeURIComponent(omiseChargeId)}`;
    const authHeader =
      'Basic ' + Buffer.from(`${this.secretKey}:`).toString('base64');

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: authHeader },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[Omise] retrieveCharge network error chargeId=${omiseChargeId}: ${message}`,
      );
      throw new Error(`ติดต่อ Omise ไม่สำเร็จขณะ retrieve charge: ${message}`);
    }

    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    if (!res.ok || body.object === 'error') {
      const omiseCode = typeof body.code === 'string' ? body.code : undefined;
      const omiseMessage =
        typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
      this.logger.error(
        `[Omise] retrieveCharge failed chargeId=${omiseChargeId} status=${res.status} code=${omiseCode} message=${omiseMessage}`,
      );
      throw new Error(`Omise ปฏิเสธการ retrieve charge: ${omiseMessage}`);
    }

    return {
      id: typeof body.id === 'string' ? body.id : omiseChargeId,
      status: typeof body.status === 'string' ? body.status : 'unknown',
      amount: typeof body.amount === 'number' ? body.amount : 0,
      captured: body.paid === true,
      paid: body.paid === true,
      authorized: body.authorized === true,
      failure_code:
        typeof body.failure_code === 'string' ? body.failure_code : undefined,
      failure_message:
        typeof body.failure_message === 'string'
          ? body.failure_message
          : undefined,
    };
  }

  /** แปลง raw Omise recipient response object → OmiseRecipientResult ที่ normalize แล้ว */
  private normalizeRecipient(
    body: Record<string, unknown>,
  ): OmiseRecipientResult {
    const bankAccount = (body.bank_account ?? {}) as Record<string, unknown>;
    return {
      id: typeof body.id === 'string' ? body.id : '',
      verified: body.verified === true,
      active: body.active === true,
      bankAccount: {
        brand: typeof bankAccount.brand === 'string' ? bankAccount.brand : '',
        lastDigits:
          typeof bankAccount.last_digits === 'string'
            ? bankAccount.last_digits
            : '',
        name: typeof bankAccount.name === 'string' ? bankAccount.name : '',
      },
      // PYG-375: expires_at ใช้ยืนยันว่า PromptPay charge ตายจริงก่อน mark expired
      expiresAt: typeof body.expires_at === 'string' ? body.expires_at : null,
    };
  }

  /**
   * createRecipient — PYG-266: สร้าง Omise Recipient (type=individual) สำหรับ caregiver
   *
   * @param params.name          - ชื่อบัญชี (accountName ที่ caregiver กรอก)
   * @param params.email         - อีเมลของ caregiver (Omise ต้องการสำหรับ type=individual)
   * @param params.bankCode      - bank_account.brand (เช่น 'kbank', 'scb')
   * @param params.accountNumber - เลขบัญชี (plaintext — decrypt แล้วก่อนเรียกฟังก์ชันนี้)
   * @param params.accountName   - ชื่อเจ้าของบัญชี (bank_account.name)
   * @throws PaymentError ถ้า Omise ปฏิเสธหรือ network ติดต่อไม่ได้
   */
  async createRecipient(params: {
    name: string;
    email: string;
    bankCode: string;
    accountNumber: string;
    accountName: string;
  }): Promise<OmiseRecipientResult> {
    if (!this.secretKey) {
      throw mapOmiseError('config_error', 'ยังไม่ได้ตั้งค่า OMISE_SECRET_KEY');
    }

    const url = `${this.apiBase}/recipients`;
    const authHeader =
      'Basic ' + Buffer.from(`${this.secretKey}:`).toString('base64');

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          type: 'individual',
          name: params.name,
          email: params.email,
          'bank_account[brand]': params.bankCode,
          'bank_account[number]': params.accountNumber,
          'bank_account[name]': params.accountName,
        }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[Omise] createRecipient network error: ${message}`);
      throw mapOmiseError(
        'network_error',
        'ติดต่อ Omise ไม่สำเร็จขณะสร้างบัญชีรับเงิน',
        {
          omiseMessage: message,
        },
      );
    }

    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    if (!res.ok || body.object === 'error') {
      const omiseCode = typeof body.code === 'string' ? body.code : undefined;
      const omiseMessage =
        typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
      this.logger.error(
        `[Omise] createRecipient failed status=${res.status} code=${omiseCode} message=${omiseMessage}`,
      );
      throw mapOmiseError(
        omiseCode ?? 'recipient_creation_failed',
        omiseMessage,
        {
          omiseCode,
          omiseMessage,
          httpStatus: res.status,
        },
      );
    }

    return this.normalizeRecipient(body);
  }

  /**
   * retrieveRecipient — PYG-266: GET /recipients/:id (read-only)
   *
   * ใช้ยืนยันสถานะ recipient ก่อนเชื่อ webhook body ตรง ๆ (defense in depth —
   * เหมือน retrieveCharge ที่ captureFromWebhook ใช้)
   */
  async retrieveRecipient(recipientId: string): Promise<OmiseRecipientResult> {
    if (!this.secretKey) {
      throw mapOmiseError('config_error', 'ยังไม่ได้ตั้งค่า OMISE_SECRET_KEY');
    }
    if (!recipientId) {
      throw mapOmiseError(
        'invalid_request',
        'ไม่มี recipientId — ไม่สามารถ retrieve ได้',
      );
    }

    const url = `${this.apiBase}/recipients/${encodeURIComponent(recipientId)}`;
    const authHeader =
      'Basic ' + Buffer.from(`${this.secretKey}:`).toString('base64');

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: authHeader },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[Omise] retrieveRecipient network error recipientId=${recipientId}: ${message}`,
      );
      throw mapOmiseError(
        'network_error',
        'ติดต่อ Omise ไม่สำเร็จขณะตรวจสอบบัญชีรับเงิน',
        {
          omiseMessage: message,
        },
      );
    }

    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    if (!res.ok || body.object === 'error') {
      const omiseCode = typeof body.code === 'string' ? body.code : undefined;
      const omiseMessage =
        typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
      this.logger.error(
        `[Omise] retrieveRecipient failed recipientId=${recipientId} status=${res.status} code=${omiseCode} message=${omiseMessage}`,
      );
      throw mapOmiseError(
        omiseCode ?? 'recipient_retrieve_failed',
        omiseMessage,
        {
          omiseCode,
          omiseMessage,
          httpStatus: res.status,
        },
      );
    }

    return this.normalizeRecipient(body);
  }

  /**
   * createTransfer — PYG-266 / PYG-330: POST /transfers โอนเงินไปยัง Omise recipient
   *
   * มี 2 caller เดิมที่ implement แยกกันมาด้วยลำดับ argument และ return shape
   * คนละแบบ รวมเป็น overload เดียวเพื่อไม่ต้องแก้ caller ทั้งสองฝั่ง:
   *   - createTransfer(recipientId, amountSatangs, idempotencyKey?) — PaymentService
   *     คืนผลลัพธ์แบบย่อ {id, amount, recipient}
   *   - createTransfer(amountSatangs, recipientId, idempotencyKey) — PayoutWorkerService
   *     คืนผลลัพธ์เต็ม {id, status, amount, recipient, currency, sent, paid, ...}
   *
   * Omise-Idempotency-Key = ค่าที่ caller ส่งมา (stable ต่อ payment/payout เดียว)
   *   ถ้ายิงซ้ำด้วย key เดิม + params เดิม → Omise คืน response เดิม ไม่โอนซ้ำ
   */
  async createTransfer(
    recipientId: string,
    amountSatangs: number,
    idempotencyKey?: string,
  ): Promise<{ id: string; amount: number; recipient: string }>;
  async createTransfer(
    amountSatangs: number,
    recipientId: string,
    idempotencyKey: string,
  ): Promise<OmiseTransferResult>;
  async createTransfer(
    arg1: string | number,
    arg2: string | number,
    idempotencyKey?: string,
  ): Promise<
    OmiseTransferResult | { id: string; amount: number; recipient: string }
  > {
    const legacyOrder = typeof arg1 === 'string';
    const recipientId = legacyOrder ? arg1 : (arg2 as string);
    const amountSatangs = legacyOrder ? (arg2 as number) : arg1;

    if (!this.secretKey) {
      throw mapOmiseError('config_error', 'ยังไม่ได้ตั้งค่า OMISE_SECRET_KEY');
    }
    if (!recipientId) {
      throw mapOmiseError(
        'invalid_request',
        'ไม่มี recipientId — ไม่สามารถโอนเงินได้',
      );
    }
    if (!legacyOrder && !idempotencyKey) {
      throw mapOmiseError(
        'invalid_request',
        'ต้องระบุ idempotencyKey ให้ createTransfer',
      );
    }

    const url = `${this.apiBase}/transfers`;
    const authHeader =
      'Basic ' + Buffer.from(`${this.secretKey}:`).toString('base64');

    const headers: Record<string, string> = {
      Authorization: authHeader,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (idempotencyKey) {
      headers['Omise-Idempotency-Key'] = idempotencyKey;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: new URLSearchParams({
          recipient: recipientId,
          amount: amountSatangs.toString(),
        }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[Omise] createTransfer network error recipientId=${recipientId}: ${message}`,
      );
      throw mapOmiseError('network_error', 'ติดต่อ Omise ไม่สำเร็จขณะโอนเงิน', {
        omiseMessage: message,
      });
    }

    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    if (!res.ok || body.object === 'error') {
      const omiseCode = typeof body.code === 'string' ? body.code : undefined;
      const omiseMessage =
        typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
      this.logger.error(
        `[Omise] createTransfer failed recipientId=${recipientId} status=${res.status} code=${omiseCode} message=${omiseMessage}`,
      );
      throw mapOmiseError(omiseCode ?? 'transfer_failed', omiseMessage, {
        omiseCode,
        omiseMessage,
        httpStatus: res.status,
      });
    }

    if (legacyOrder) {
      return {
        id: typeof body.id === 'string' ? body.id : '',
        amount: typeof body.amount === 'number' ? body.amount : amountSatangs,
        recipient:
          typeof body.recipient === 'string' ? body.recipient : recipientId,
      };
    }

    return {
      id: typeof body.id === 'string' ? body.id : '',
      status: typeof body.status === 'string' ? body.status : 'unknown',
      amount: typeof body.amount === 'number' ? body.amount : amountSatangs,
      recipient:
        typeof body.recipient === 'string' ? body.recipient : recipientId,
      currency:
        typeof body.currency === 'string' ? body.currency.toUpperCase() : 'THB',
      sent: body.sent === true,
      paid: body.paid === true,
      failure_code:
        typeof body.failure_code === 'string' ? body.failure_code : undefined,
      failure_message:
        typeof body.failure_message === 'string'
          ? body.failure_message
          : undefined,
    };
  }
}
