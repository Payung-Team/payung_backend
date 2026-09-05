import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  InternalServerErrorException,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { PaymentService } from '../payment.service';
import { RefundService } from '../refund.service';
import { verifyOmiseSignature } from './omise-signature';

interface OmiseWebhookBody {
  key: string;
  data?: Record<string, unknown>;
}

/**
 * แปลงเหตุผลที่ตรวจไม่ผ่านเป็น HTTP status ที่สื่อความหมาย
 *   400 = คำขอมาไม่ครบ/รูปแบบผิด (ฝั่งผู้ส่ง)
 *   401 = ครบแต่พิสูจน์ตัวตนไม่ผ่าน
 *   500 = ฝั่งเราตั้งค่าผิด (secret decode ไม่ออก)
 */
function signatureErrorFor(reason: string): Error {
  if (reason === 'invalid_secret') {
    return new InternalServerErrorException('webhook secret is not valid base64');
  }
  if (
    reason === 'missing_raw_body' ||
    reason === 'missing_signature_header' ||
    reason === 'missing_timestamp_header' ||
    reason === 'invalid_timestamp'
  ) {
    return new BadRequestException(`webhook signature: ${reason}`);
  }
  // signature_mismatch, timestamp_out_of_tolerance:*
  return new UnauthorizedException('webhook signature verification failed');
}

@Controller('webhooks')
export class OmiseController {
  private readonly logger = new Logger(OmiseController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly paymentService: PaymentService,
    private readonly refundService: RefundService,
  ) {}

  /**
   * ⚠️ header ต้องเป็น `Omise-Signature` / `Omise-Signature-Timestamp` ตามสเปคจริง
   *    ของเดิมอ่าน `x-omise-signature` ซึ่งไม่มีอยู่จริง → ค่าเป็น undefined เสมอ
   *    → ตกเข้า else ที่ปล่อยผ่าน แปลว่าต่อให้ตั้ง secret แล้วก็ยังไม่ได้ตรวจอะไร
   *
   *    rawBody มาจาก NestFactory.create(AppModule, { rawBody: true }) ใน main.ts
   *    ห้ามกลับไปใช้ JSON.stringify(body) เด็ดขาด — re-serialise แล้วไบต์ไม่ตรงของเดิม
   *
   * ── FAIL CLOSED ────────────────────────────────────────────────────────────
   * ★ ทุกเส้นทางที่ "ตรวจไม่ได้" ต้องจบด้วยการโยน error ห้ามมี else ไหนไหลลงไป
   *   ประมวลผล payload ได้เลย บั๊กเดิมคือ fail-open (ไม่มี secret = ข้ามการตรวจ)
   *   ถ้าเหลือทางไหลผ่านแม้ทางเดียว = ยังไม่ได้ปิดช่อง แค่ย้ายที่
   *
   *   ไม่ตั้ง secret            → 500 (server misconfig — ห้ามรับ webhook เลย)
   *   secret decode ไม่ออก      → 500
   *   header หาย / timestamp เพี้ยน → 400
   *   ไม่มี rawBody             → 400 (ห้าม fallback ไป JSON.stringify เด็ดขาด)
   *   ลายเซ็นไม่ตรง / เก่าเกิน    → 401
   *
   * ★ ตอบ non-2xx = Omise จะ retry ซึ่ง "ต้องการ" ในเคสตั้งค่าผิด:
   *   พอแก้ config เสร็จ event เดิมจะถูกส่งซ้ำมาให้เอง ไม่หายไปเฉย ๆ
   *   ส่วน request ปลอม ผู้โจมตีคุม retry เองอยู่แล้ว การตอบ 200 ไม่ได้ช่วยอะไร
   */
  @Post('omise')
  @HttpCode(200)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: OmiseWebhookBody,
    @Headers('omise-signature') signature?: string,
    @Headers('omise-signature-timestamp') signatureTimestamp?: string,
  ): Promise<{ received: boolean }> {
    const secret = this.configService.get<string>('OMISE_WEBHOOK_SECRET');

    if (!secret) {
      // webhook recipient.verified เป็นประตูเดียวที่ปลดล็อกบัญชีรับเงินให้พร้อมรับโอน
      // ไม่ตั้ง secret = ใครก็ปลอม event นี้เข้ามาได้ → ห้ามรับ webhook เลยดีกว่ารับมั่ว
      this.logger.error(
        '[OmiseWebhook] ปฏิเสธทุก webhook — OMISE_WEBHOOK_SECRET ไม่ได้ตั้ง ' +
          '(ตรวจลายเซ็นไม่ได้ = ยืนยันไม่ได้ว่า Omise ส่งมาจริง)',
      );
      throw new InternalServerErrorException('webhook signature verification not configured');
    }

    const verdict = verifyOmiseSignature(
      req.rawBody,
      signature,
      signatureTimestamp,
      secret,
    );

    if (!verdict.ok) {
      // log เป็น ERROR ไม่ใช่ WARN: ถ้าการตรวจของเราพังเอง อาการจะเหมือนถูกโจมตีเป๊ะ
      // (webhook ถูกทิ้งทั้งหมด) แล้วบัญชีรับเงินจะไม่มีวันเป็น active — ต้องเห็นทันที
      this.logger.error(
        `[OmiseWebhook] ปฏิเสธ webhook — ลายเซ็นไม่ผ่าน (${verdict.reason}) ` +
          `key=${body?.key ?? 'unknown'} — ไม่ประมวลผล payload`,
      );
      throw signatureErrorFor(verdict.reason);
    }

    const { key, data } = body ?? {};
    this.logger.log(`[OmiseWebhook] received event key=${key}`);

    switch (key) {
      case 'charge.complete':
        // PYG-278: PromptPay async confirm — Omise webhook = user สแกน + bank ยืนยันแล้ว
        // captureFromWebhook idempotent + re-fetch จาก Omise (กัน tamper) + skip ถ้า process แล้ว
        // data = Charge object → chargeId = data.id
        await this.dispatch(key, data, 'id', (chargeId) =>
          this.paymentService.captureFromWebhook(chargeId),
        );
        break;

      case 'charge.reverse':
        // charge ถูก reverse "นอกแอป" (เช่น admin กดผ่าน Omise dashboard) → sync ให้ตรงความจริง
        // data = Charge object → chargeId = data.id
        await this.dispatch(key, data, 'id', (chargeId) =>
          this.paymentService.voidFromWebhook(chargeId),
        );
        break;

      case 'refund.create':
        // refund ที่ทำ "นอกแอป" (เช่น admin กด refund ผ่าน Omise dashboard) → sync กลับเข้า DB
        // data = Refund object (ต่างจาก Charge object) → chargeId = data.charge
        await this.dispatch(key, data, 'charge', (chargeId) =>
          this.refundService.reconcileFromWebhook(chargeId),
        );
        break;

      default:
        this.logger.log(`[OmiseWebhook] unhandled event key=${key ?? 'undefined'}`);
    }

    return { received: true };
  }

  /**
   * dispatch — ดึง chargeId จาก data[idField], เรียก handler, log error แบบ 200 เสมอ
   * (กัน retry flood — Omise ยิงซ้ำถ้า response ไม่ใช่ 2xx)
   */
  private async dispatch(
    key: string,
    data: Record<string, unknown> | undefined,
    idField: 'id' | 'charge',
    handler: (chargeId: string) => Promise<void>,
  ): Promise<void> {
    const rawId = data?.[idField];
    const chargeId = typeof rawId === 'string' ? rawId : undefined;
    if (!chargeId) {
      this.logger.warn(
        `[OmiseWebhook] ${key} missing data.${idField} — payload: ${JSON.stringify(data)}`,
      );
      return;
    }

    try {
      await handler(chargeId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[OmiseWebhook] ${key} handler failed chargeId=${chargeId}: ${msg}`,
      );
      // ตอบ 200 เพื่อกัน retry flood — error ถูก log ไปแล้ว
    }
  }
}
