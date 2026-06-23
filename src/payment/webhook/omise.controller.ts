import * as crypto from 'node:crypto';
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
  ) {}

  @Post('omise')
  @HttpCode(200)
  async handle(
    @Body() body: OmiseWebhookBody,
    @Headers('x-omise-signature') signature?: string,
  ): Promise<{ received: boolean }> {
    const secret = this.configService.get<string>('OMISE_WEBHOOK_SECRET');

    if (!secret) {
      this.logger.warn('[OmiseWebhook] OMISE_WEBHOOK_SECRET not configured — skipping signature check');
    } else if (signature) {
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
        const chargeId = data?.['id'] as string | undefined;
        if (chargeId) {
          await this.paymentService.captureFromWebhook(chargeId);
        }
        break;
      }

      case 'charge.reverse': {
        const chargeId = data?.['id'] as string | undefined;
        if (chargeId) {
          await this.paymentService.voidFromWebhook(chargeId);
        }
        break;
      }

      case 'refund.create': {
        // data.charge = parent charge id, data.id = refund id, data.amount = refund satangs
        const chargeId  = data?.['charge'] as string | undefined;
        const refundId  = data?.['id']     as string | undefined;
        const amount    = data?.['amount'] as number | undefined;
        if (chargeId) {
          await this.paymentService.refundFromWebhook(chargeId, { refundId, amount });
        }
        break;
      }

      default:
        this.logger.log(`[OmiseWebhook] unhandled event key=${key ?? 'undefined'}`);
    }

    return { received: true };
  }
}
