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
  async captureCharge(omiseChargeId: string): Promise<OmiseCaptureResult> {
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

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: authHeader },
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
    const captured = body.captured === true;
    const paid = body.paid === true;
    if (status !== 'successful' || !captured) {
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
      failure_code: typeof body.failure_code === 'string' ? body.failure_code : undefined,
      failure_message: typeof body.failure_message === 'string' ? body.failure_message : undefined,
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
  async createCharge(amount: number, token: string): Promise<OmiseCaptureResult> {
    if (!this.secretKey) {
      throw mapOmiseError('config_error', 'ยังไม่ได้ตั้งค่า OMISE_SECRET_KEY');
    }

    const url = `${this.apiBase}/charges`;
    const authHeader = 'Basic ' + Buffer.from(`${this.secretKey}:`).toString('base64');

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
      throw mapOmiseError('network_error', 'ติดต่อ Omise ไม่สำเร็จขณะสร้าง charge', { omiseMessage: message });
    }

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    // กรณี HTTP ไม่สำเร็จ (เช่น token ผิด, invalid request)
    if (!res.ok || body.object === 'error') {
      const omiseCode = typeof body.code === 'string' ? body.code : undefined;
      const omiseMessage = typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
      this.logger.error(`[Omise] createCharge failed status=${res.status} code=${omiseCode} message=${omiseMessage}`);
      throw mapOmiseError(omiseCode, omiseMessage, {
        omiseCode,
        omiseMessage,
        httpStatus: res.status,
      });
    }

    const status = typeof body.status === 'string' ? body.status : 'unknown';
    const authorized = body.authorized === true;
    const failureCode = typeof body.failure_code === 'string' ? body.failure_code : undefined;
    const failureMessage = typeof body.failure_message === 'string' ? body.failure_message : undefined;

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
      captured: body.captured === true,
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
    const authHeader = 'Basic ' + Buffer.from(`${this.secretKey}:`).toString('base64');

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: authHeader },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[Omise] reverseCharge network error chargeId=${omiseChargeId}: ${message}`);
      throw new Error(`ติดต่อ Omise ไม่สำเร็จขณะ reverse เงิน: ${message}`);
    }

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    if (!res.ok || body.object === 'error') {
      const omiseCode = typeof body.code === 'string' ? body.code : undefined;
      const omiseMessage = typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
      this.logger.error(
        `[Omise] reverseCharge failed chargeId=${omiseChargeId} status=${res.status} code=${omiseCode} message=${omiseMessage}`,
      );
      throw new Error(`Omise ปฏิเสธการ reverse เงิน: ${omiseMessage}`);
    }

    return {
      id: typeof body.id === 'string' ? body.id : omiseChargeId,
      status: typeof body.status === 'string' ? body.status : 'unknown',
      amount: typeof body.amount === 'number' ? body.amount : 0,
      captured: body.captured === true,
      paid: body.paid === true,
      authorized: body.authorized === true,
      failure_code: typeof body.failure_code === 'string' ? body.failure_code : undefined,
      failure_message: typeof body.failure_message === 'string' ? body.failure_message : undefined,
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
      throw mapOmiseError('invalid_request', 'ไม่มี omiseChargeId — ไม่สามารถคืนเงินได้');
    }

    const url = `${this.apiBase}/charges/${encodeURIComponent(omiseChargeId)}/refunds`;
    const authHeader = 'Basic ' + Buffer.from(`${this.secretKey}:`).toString('base64');

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

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

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
}
