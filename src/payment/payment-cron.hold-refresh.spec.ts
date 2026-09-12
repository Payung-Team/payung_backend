/**
 * PYG-4xx — เทสเฉพาะ "ประตู" ของ refreshExpiringHolds: kill-switch + เพดานใบต่อรอบ
 *
 * ขอบเขตตั้งใจแคบ: ไม่เทส logic การต่ออายุของเจ้าของงาน (void/re-authorize/transition)
 * เทสแค่ว่า cron ที่ยิงเงินจริงบนบัตรผู้ใช้ "ปิดอยู่โดย default" และ "ปิดได้จริง"
 *
 * ★ ไม่มีการยิง Omise จริงทุกกรณี — OmiseService ถูก mock ทั้งตัว
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  PaymentCronService,
  HOLD_REFRESH_ENABLED_ENV,
  HOLD_REFRESH_BATCH_CAP,
} from './payment-cron.service';
import { PrismaService } from '../common/prisma.service';
import { OmiseService } from './omise/omise.service';
import { PaymentStateMachine } from './payment-state-machine';
import { IdempotencyService } from './idempotency.service';

describe('PaymentCronService.refreshExpiringHolds — kill-switch + batch cap', () => {
  let service: PaymentCronService;
  let prisma: { payment: { findMany: jest.Mock }; paymentStatusHistory: { findFirst: jest.Mock }; $transaction: jest.Mock };
  let omise: { voidCharge: jest.Mock; createChargeForCustomer: jest.Mock; reverseCharge: jest.Mock; retrieveCharge: jest.Mock };
  let idempotency: { runOnce: jest.Mock; pruneOlderThan: jest.Mock };
  let envValues: Record<string, string | undefined>;

  /** สร้าง service ใหม่ต่อเทส โดยกำหนดค่า env ที่ ConfigService จะคืน */
  const build = async (env: Record<string, string | undefined>): Promise<void> => {
    envValues = env;
    prisma = {
      payment: { findMany: jest.fn().mockResolvedValue([]) },
      paymentStatusHistory: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(),
    };
    omise = {
      voidCharge: jest.fn(),
      createChargeForCustomer: jest.fn(),
      reverseCharge: jest.fn(),
      retrieveCharge: jest.fn(),
    };
    idempotency = { runOnce: jest.fn(), pruneOlderThan: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentCronService,
        { provide: PrismaService, useValue: prisma },
        { provide: OmiseService, useValue: omise },
        { provide: PaymentStateMachine, useValue: { transition: jest.fn() } },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, fallback?: unknown) =>
              key in envValues ? envValues[key] : fallback,
            ),
          },
        },
        { provide: IdempotencyService, useValue: idempotency },
      ],
    }).compile();

    service = moduleRef.get(PaymentCronService);
  };

  describe('ปิดอยู่ (fail-closed)', () => {
    it('ไม่ตั้ง env เลย → ไม่แตะ DB ไม่ยิง Omise', async () => {
      await build({});
      await service.refreshExpiringHolds();

      expect(prisma.payment.findMany).not.toHaveBeenCalled();
      expect(omise.voidCharge).not.toHaveBeenCalled();
      expect(omise.createChargeForCustomer).not.toHaveBeenCalled();
      expect(idempotency.runOnce).not.toHaveBeenCalled();
    });

    it.each(['false', 'no', '0', '', '   ', 'enabled'])(
      'ตั้งเป็น %p → ยังถือว่าปิด',
      async (raw) => {
        await build({ [HOLD_REFRESH_ENABLED_ENV]: raw });
        await service.refreshExpiringHolds();

        expect(prisma.payment.findMany).not.toHaveBeenCalled();
        expect(omise.createChargeForCustomer).not.toHaveBeenCalled();
      },
    );

    it('log บอกว่าข้ามเพราะ kill-switch ไม่ใช่เพราะไม่มีงาน', async () => {
      await build({});
      const warn = jest
        .spyOn(service['logger'], 'warn')
        .mockImplementation(() => undefined);

      await service.refreshExpiringHolds();

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(HOLD_REFRESH_ENABLED_ENV),
      );
      expect(warn.mock.calls[0][0]).toContain('ข้ามรอบนี้');
    });
  });

  describe('เปิด', () => {
    it.each(['true', 'TRUE', ' True ', '1', 'yes', 'YES'])(
      'ตั้งเป็น %p → ทำงาน (คิวรี candidate จริง)',
      async (raw) => {
        await build({ [HOLD_REFRESH_ENABLED_ENV]: raw });
        await service.refreshExpiringHolds();

        expect(prisma.payment.findMany).toHaveBeenCalledTimes(1);
      },
    );

    it('ไม่มีใบเข้าเงื่อนไข → จบเงียบ ไม่ยิง Omise', async () => {
      await build({ [HOLD_REFRESH_ENABLED_ENV]: 'true' });
      prisma.payment.findMany.mockResolvedValue([]);

      await service.refreshExpiringHolds();

      expect(omise.voidCharge).not.toHaveBeenCalled();
      expect(idempotency.runOnce).not.toHaveBeenCalled();
    });
  });

  describe('เพดานใบต่อรอบ', () => {
    it('ส่ง take = HOLD_REFRESH_BATCH_CAP และเรียงเก่าสุดก่อน', async () => {
      await build({ [HOLD_REFRESH_ENABLED_ENV]: 'true' });
      await service.refreshExpiringHolds();

      expect(prisma.payment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: HOLD_REFRESH_BATCH_CAP,
          orderBy: { createdAt: 'asc' },
        }),
      );
    });

    it('เพดานเป็นค่าคงที่ที่ตั้งไว้ (กันแก้หลุดโดยไม่ตั้งใจ)', () => {
      expect(HOLD_REFRESH_BATCH_CAP).toBe(50);
    });
  });
});
