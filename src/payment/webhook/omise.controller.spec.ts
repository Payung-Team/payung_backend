import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { OmiseController } from './omise.controller';
import { PaymentService } from '../payment.service';
import { RefundService } from '../refund.service';
import { PayoutAccountService } from '../payout-account.service';

describe('OmiseController recipient webhooks', () => {
  let controller: OmiseController;
  let payoutAccounts: { reconcileRecipient: jest.Mock };

  beforeEach(async () => {
    payoutAccounts = { reconcileRecipient: jest.fn().mockResolvedValue(null) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [OmiseController],
      providers: [
        { provide: ConfigService, useValue: { get: jest.fn() } },
        {
          provide: PaymentService,
          useValue: {
            captureFromWebhook: jest.fn(),
            voidFromWebhook: jest.fn(),
          },
        },
        {
          provide: RefundService,
          useValue: { reconcileFromWebhook: jest.fn() },
        },
        { provide: PayoutAccountService, useValue: payoutAccounts },
      ],
    }).compile();

    controller = moduleRef.get(OmiseController);
  });

  it.each([
    'recipient.create',
    'recipient.update',
    'recipient.verify',
    'recipient.activate',
    'recipient.deactivate',
  ])('reconciles official Omise event %s', async (key) => {
    await expect(
      controller.handle({ key, data: { id: 'recp_test_1' } }),
    ).resolves.toEqual({ received: true });

    expect(payoutAccounts.reconcileRecipient).toHaveBeenCalledWith(
      'recp_test_1',
      key,
    );
  });

  it('does not treat the old recipient.verified name as an official event', async () => {
    await controller.handle({
      key: 'recipient.verified',
      data: { id: 'recp_test_1' },
    });

    expect(payoutAccounts.reconcileRecipient).not.toHaveBeenCalled();
  });
});
