/**
 * OmiseService — ตัวห่อ (wrapper) เรียก Omise payment gateway ผ่าน REST API (PYG-281)
 *
 * ทำไมเรียก REST เองแทนใช้ SDK `omise`?
 * - โปรเจกต์นี้ไม่ได้ติดตั้ง SDK ของ Omise (webhook controller ก็ hand-roll HMAC เองด้วย crypto)
 * - capture เป็น request เดียวง่ายๆ → ใช้ global fetch (Node 18+) พอ ไม่ต้องเพิ่ม dependency
 *
 * หน้าที่ตอนนี้ (PYG-281):
 * - captureCharge(omiseChargeId) — ตัดเงินจริงจากวงเงินที่ "held" ไว้ตอน checkout
 *   (Omise เรียกขั้นนี้ว่า "capture" ของ charge ที่ authorize ไว้แบบ capture=false)
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
    };
  }
}
