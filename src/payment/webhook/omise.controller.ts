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

interface OmiseWebhookBody {
  key: string;
  data?: Record<string, unknown>;
}

@Controller('webhooks')
export class OmiseController {
  private readonly logger = new Logger(OmiseController.name);

  constructor(private readonly configService: ConfigService) {}

  @Post('omise')
  @HttpCode(200)
  handle(
    @Body() body: OmiseWebhookBody,
    @Headers('x-omise-signature') signature?: string,
  ): { received: boolean } {
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
        // TODO: PYG-281 — update payment status to 'captured' when charge completes
        this.logger.log(`[OmiseWebhook] charge.complete: ${JSON.stringify(data)}`);
        break;

      case 'charge.reverse':
        // TODO: update payment status to 'voided'
        this.logger.log(`[OmiseWebhook] charge.reverse: ${JSON.stringify(data)}`);
        break;

      case 'refund.create':
        // TODO: update payment status to 'refunded' or 'partially_refunded'
        this.logger.log(`[OmiseWebhook] refund.create: ${JSON.stringify(data)}`);
        break;

      default:
        this.logger.log(`[OmiseWebhook] unhandled event key=${key ?? 'undefined'}`);
    }

    return { received: true };
  }
}
