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
import { PayoutAccountService } from '../payout-account.service';

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
    private readonly payoutAccountService: PayoutAccountService,
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
      case 'charge.complete': {
        // PYG-278: PromptPay async confirm — Omise webhook = user สแกน + bank ยืนยันแล้ว
        // captureFromWebhook idempotent + re-fetch จาก Omise (กัน tamper) + skip ถ้า process แล้ว
        const chargeId = typeof data?.id === 'string' ? data.id : undefined;
        if (chargeId) {
          try {
            await this.paymentService.captureFromWebhook(chargeId);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.error(
              `[OmiseWebhook] charge.complete handler failed chargeId=${chargeId}: ${msg}`,
            );
            // ตอบ 200 เพื่อกัน retry flood — error ถูก log ไปแล้ว
          }
        } else {
          this.logger.warn(
            `[OmiseWebhook] charge.complete missing data.id — payload: ${JSON.stringify(data)}`,
          );
        }
        break;
      }

      case 'charge.reverse':
        // TODO (out of scope ของ PYG-278): handler ของ async reverse จาก Omise dashboard
        // — PYG-286 ทำ void/refund ผ่าน mutation อยู่แล้ว ครอบคลุม flow ปัจจุบัน
        this.logger.log(`[OmiseWebhook] charge.reverse: ${JSON.stringify(data)}`);
        break;

      case 'refund.create':
        // TODO (out of scope ของ PYG-278): sync refund ที่ทำใน Omise dashboard กลับเข้า DB
        this.logger.log(`[OmiseWebhook] refund.create: ${JSON.stringify(data)}`);
        break;

      case 'recipient.verified':
      case 'recipient.failed': {
        // PYG-266: Omise ยืนยัน/ปฏิเสธบัญชีรับเงินของ caregiver
        const recipientId = typeof data?.id === 'string' ? data.id : undefined;
        if (recipientId) {
          try {
            await this.payoutAccountService.handleRecipientWebhook(recipientId, key);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.error(
              `[OmiseWebhook] ${key} handler failed recipientId=${recipientId}: ${msg}`,
            );
          }
        } else {
          this.logger.warn(
            `[OmiseWebhook] ${key} missing data.id — payload: ${JSON.stringify(data)}`,
          );
        }
        break;
      }

      default:
        this.logger.log(`[OmiseWebhook] unhandled event key=${key ?? 'undefined'}`);
    }

    return { received: true };
  }
}
