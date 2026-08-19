import * as crypto from 'crypto';
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentService } from '../payment.service';
import { RefundService } from '../refund.service';

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

  @Post('omise')
  @HttpCode(200)
  async handle(
    @Body() body: OmiseWebhookBody,
    @Headers('x-omise-signature') signature?: string,
  ): Promise<{ received: boolean }> {
    const secret = this.configService.get<string>('OMISE_WEBHOOK_SECRET');

    if (!secret) {
      // TODO: set OMISE_WEBHOOK_SECRET in .env to enable signature verification
      this.logger.warn('[OmiseWebhook] OMISE_WEBHOOK_SECRET not configured — skipping signature check');
    } else if (signature) {
      // NOTE: for byte-accurate verification, configure NestJS to preserve rawBody
      // (app.use(express.json({ verify: (req, _, buf) => { req['rawBody'] = buf; } })))
      // Current implementation re-serialises the parsed JSON which may differ from the original bytes.
      const expected = crypto
        .createHmac('sha256', secret)
        .update(JSON.stringify(body))
        .digest('hex');
      const sigBuffer = Buffer.from(signature);
      const expBuffer = Buffer.from(expected);
      if (
        sigBuffer.length !== expBuffer.length ||
        !crypto.timingSafeEqual(sigBuffer, expBuffer)
      ) {
        this.logger.warn('[OmiseWebhook] Signature mismatch — ignoring payload (returning 200 to prevent retry flood)');
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
