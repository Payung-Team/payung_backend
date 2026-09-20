/**
 * PYG-4xx — เก็บบัตรเป็น opt-in (CreatePaymentInput.saveCard) ★ default = ไม่เก็บ
 *
 * ที่ต้องคุม: การจ่ายด้วยบัตร "ทุกครั้ง" เคยสร้าง Omise Customer ถาวรโดยผู้ใช้ไม่ได้เลือก
 * เทสชุดนี้ตรึงไว้ว่าเส้นทาง default ต้องไม่แตะ Customer API เลย และ omise_customer_id
 * ต้องเป็น null (ซึ่งเป็นหลักฐานเดียวที่บอกว่า "ไม่ได้ยินยอม" — ไม่มีคอลัมน์ consent แยก)
 *
 * ★ OmiseService ถูก mock ทั้งตัว ไม่มีการยิง Omise จริง
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PaymentService } from './payment.service';
import { PrismaService } from '../common/prisma.service';
import { PaymentStateMachine } from './payment-state-machine';
import { OmiseService } from './omise/omise.service';
import { RefundService } from './refund.service';
import { ClockService } from '../common/clock.service';
import { ROLE_ID } from '../common/constants/roles.constant';
import { AuthUser } from '../common/decorators/current-user.decorator';

const NOW_BEFORE_START = new Date('2026-06-30T00:00:00.000Z');
const fixedClock = {
  now: () => NOW_BEFORE_START,
  nowMs: () => NOW_BEFORE_START.getTime(),
};

const BOOKING_ID = 'book-0001';
const PATIENT_ID = 'patient-0001';
const CAREGIVER_ID = 'cg-0001';

const acceptedBooking = {
  id: BOOKING_ID,
  patientId: PATIENT_ID,
  status: 'accepted',
  durationHours: 2,
  caregiverId: CAREGIVER_ID,
  caregiver: { userId: CAREGIVER_ID, hourlyRate: 550 },
  bookingDate: new Date('2026-07-01'),
  startTime: new Date('1970-01-01T09:00:00.000Z'),
};

const patient = { id: PATIENT_ID, role: ROLE_ID.PATIENT } as AuthUser;
const CARD_INPUT = {
  bookingId: BOOKING_ID,
  paymentMethod: 'credit_card',
  omiseToken: 'tokn_test_1',
};

describe('PaymentService.createPayment — saveCard (opt-in เก็บบัตร)', () => {
  let service: PaymentService;
  let prisma: {
    booking: { findUnique: jest.Mock };
    payment: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: {
    booking: { update: jest.Mock };
    payment: { create: jest.Mock; update: jest.Mock };
    paymentStatusHistory: { create: jest.Mock };
  };
  let omise: {
    createCharge: jest.Mock;
    createCustomerWithCard: jest.Mock;
    createChargeForCustomer: jest.Mock;
    createPromptPayCharge: jest.Mock;
    retrieveCharge: jest.Mock;
  };

  /** ข้อมูลที่ถูกเขียนลงแถว payment จริง ๆ (อ่านจาก tx.payment.create) */
  const persisted = (): Record<string, unknown> =>
    tx.payment.create.mock.calls[0][0].data as Record<string, unknown>;

  beforeEach(async () => {
    tx = {
      booking: { update: jest.fn() },
      payment: {
        create: jest.fn().mockImplementation((args) => ({ id: 'pay-0001', ...args.data })),
        update: jest.fn(),
      },
      paymentStatusHistory: { create: jest.fn() },
    };
    prisma = {
      booking: { findUnique: jest.fn().mockResolvedValue(acceptedBooking) },
      payment: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn().mockImplementation((cb) => cb(tx)),
    };
    omise = {
      createCharge: jest.fn().mockResolvedValue({ id: 'chrg_plain', status: 'pending' }),
      createCustomerWithCard: jest
        .fn()
        .mockResolvedValue({ customerId: 'cust_1', cardId: 'card_1' }),
      createChargeForCustomer: jest
        .fn()
        .mockResolvedValue({ id: 'chrg_saved', status: 'pending' }),
      createPromptPayCharge: jest
        .fn()
        .mockResolvedValue({ id: 'chrg_qr', status: 'pending', qrCodeUrl: 'https://qr' }),
      retrieveCharge: jest.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: PaymentStateMachine,
          useValue: { transition: jest.fn(), recordInitialStatus: jest.fn() },
        },
        { provide: OmiseService, useValue: omise },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: RefundService, useValue: { refund: jest.fn() } },
        { provide: ClockService, useValue: fixedClock },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(PaymentService);
  });

  describe('★ default — ไม่ส่ง saveCard มาเลย (FE ปัจจุบัน)', () => {
    it('ชาร์จด้วย token ทางเดิม ไม่แตะ Omise Customer API', async () => {
      await service.createPayment(CARD_INPUT, patient);

      expect(omise.createCharge).toHaveBeenCalledTimes(1);
      expect(omise.createCharge).toHaveBeenCalledWith(expect.any(Number), 'tokn_test_1');
      expect(omise.createCustomerWithCard).not.toHaveBeenCalled();
      expect(omise.createChargeForCustomer).not.toHaveBeenCalled();
    });

    it('omiseCustomerId / omiseCardId ถูกเขียนเป็น null', async () => {
      await service.createPayment(CARD_INPUT, patient);

      expect(persisted().omiseCustomerId).toBeNull();
      expect(persisted().omiseCardId).toBeNull();
    });

    it('ยังเก็บ chargeId ของ charge ทางเดิม และ booking ถูก confirm ตามปกติ', async () => {
      await service.createPayment(CARD_INPUT, patient);

      expect(persisted().omiseChargeId).toBe('chrg_plain');
      expect(tx.booking.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'confirmed' }) }),
      );
    });
  });

  describe('saveCard: false — ส่งมาแต่ไม่เลือก', () => {
    it('เหมือน default ทุกอย่าง', async () => {
      await service.createPayment({ ...CARD_INPUT, saveCard: false }, patient);

      expect(omise.createCharge).toHaveBeenCalledTimes(1);
      expect(omise.createCustomerWithCard).not.toHaveBeenCalled();
      expect(persisted().omiseCustomerId).toBeNull();
      expect(persisted().omiseCardId).toBeNull();
    });
  });

  describe('saveCard: true — ผู้ใช้เลือกเก็บบัตร', () => {
    it('ใช้ flow customer+card ไม่ชาร์จด้วย token ตรง ๆ', async () => {
      await service.createPayment({ ...CARD_INPUT, saveCard: true }, patient);

      expect(omise.createCustomerWithCard).toHaveBeenCalledWith('tokn_test_1');
      expect(omise.createChargeForCustomer).toHaveBeenCalledWith(
        expect.any(Number),
        'cust_1',
        'card_1',
      );
      expect(omise.createCharge).not.toHaveBeenCalled();
    });

    it('เก็บ omiseCustomerId / omiseCardId ลงแถว payment', async () => {
      await service.createPayment({ ...CARD_INPUT, saveCard: true }, patient);

      expect(persisted().omiseCustomerId).toBe('cust_1');
      expect(persisted().omiseCardId).toBe('card_1');
      expect(persisted().omiseChargeId).toBe('chrg_saved');
    });
  });

  describe('PromptPay ไม่เกี่ยวกับ flag นี้', () => {
    it.each([undefined, false, true])('saveCard=%p → ไม่แตะ Customer API', async (flag) => {
      await service.createPayment(
        { bookingId: BOOKING_ID, paymentMethod: 'promptpay', ...(flag === undefined ? {} : { saveCard: flag }) },
        patient,
      );

      expect(omise.createPromptPayCharge).toHaveBeenCalledTimes(1);
      expect(omise.createCustomerWithCard).not.toHaveBeenCalled();
      expect(omise.createChargeForCustomer).not.toHaveBeenCalled();
      expect(omise.createCharge).not.toHaveBeenCalled();
    });
  });
});
