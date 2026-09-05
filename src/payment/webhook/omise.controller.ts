import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
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
      // dev/local เท่านั้น — บน environment ที่มีเงินจริงต้องตั้งเสมอ
      // webhook recipient.verified เป็นประตูเดียวที่ปลดล็อกบัญชีรับเงินให้พร้อมรับโอน
      // ไม่ตั้ง secret = ใครก็ปลอม event นี้เข้ามาได้
      this.logger.warn(
        '[OmiseWebhook] ⚠️ OMISE_WEBHOOK_SECRET ไม่ได้ตั้ง — ข้ามการตรวจลายเซ็น ' +
          '(ห้ามใช้สภาพนี้บน production)',
      );
    } else {
      const verdict = verifyOmiseSignature(
        req.rawBody,
        signature,
        signatureTimestamp,
        secret,
      );

      if (!verdict.ok) {
        // ตอบ 200 เพื่อไม่ให้ Omise retry ถล่ม แต่ log เป็น ERROR ไม่ใช่ WARN:
        // ถ้าการตรวจของเราพังเอง อาการจะเหมือนกันเป๊ะ (webhook ถูกทิ้งเงียบ ๆ)
        // แล้วบัญชีรับเงินจะไม่มีวันเป็น active — ต้องเห็นใน log ทันที
        this.logger.error(
          `[OmiseWebhook] ปฏิเสธ webhook — ลายเซ็นไม่ผ่าน (${verdict.reason}) ` +
            `key=${body?.key ?? 'unknown'} — ไม่ประมวลผล payload`,
        );
        return { received: true };
      }
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
