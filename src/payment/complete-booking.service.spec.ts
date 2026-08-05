/**
 * Unit tests สำหรับ CompleteBookingService (PYG-281)
 *
 * ครอบคลุม:
 * - happy path: confirmed + held → capture + transition captured + booking completed
 * - guards: ไม่พบ booking, ไม่ใช่ patient/caregiver, booking ไม่ confirmed, payment ไม่ held
 * - capture fail: บันทึก failure + แจ้ง admin + โยน CaptureFailedError และไม่ปิด booking
 *
 * mock PrismaService / PaymentStateMachine / OmiseService ทั้งหมด → ไม่แตะ DB/network จริง
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CompleteBookingService } from './complete-booking.service';
import { PrismaService } from '../common/prisma.service';
import { PaymentStateMachine } from './payment-state-machine';
import { OmiseService } from './omise/omise.service';
import { IdempotencyService } from './idempotency.service';
import { CaptureFailedError } from './errors/capture-failed.error';
import { PaymentStatus } from './entities/payment-status.enum';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { ROLE_ID } from '../common/constants/roles.constant';
import { BOOKING_EVENTS } from '../notification/events/booking-event';

const BOOKING_ID = 'book-0001';
const PAYMENT_ID = 'pay-0001';
const PATIENT_ID = 'patient-0001';
const CAREGIVER_USER_ID = 'cg-user-0001';

/** booking 1 แถวพร้อม payment + caregiver.userId (รูปทรงที่ service select มา) */
function fakeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    patientId: PATIENT_ID,
    status: 'confirmed',
    caregiver: { userId: CAREGIVER_USER_ID },
    payment: {
      id: PAYMENT_ID,
      paymentStatus: 'held',
      // PYG-278: default = card (existing card tests behavior unchanged)
      paymentMethod: 'credit_card',
      omiseChargeId: 'chrg_test_1',
      amount: 1200,
    },
    ...overrides,
  };
}

/** ผลลัพธ์ capture สำเร็จจาก Omise */
function fakeCaptureOk() {
  return {
    id: 'chrg_test_1',
    status: 'successful',
    amount: 120000,
    captured: true,
    paid: true,
  };
}

const asUser = (id: string, role: number): AuthUser =>
  ({ id, role } as AuthUser);

describe('CompleteBookingService', () => {
  let service: CompleteBookingService;

  let tx: {
    booking: { update: jest.Mock };
    payment: { findUnique: jest.Mock; update: jest.Mock };
    $queryRaw: jest.Mock;
  };
  let prisma: {
    booking: { findUnique: jest.Mock; update: jest.Mock };
    payment: { update: jest.Mock };
    $transaction: jest.Mock;
  };
  let fsm: { transition: jest.Mock; recordCaptureFailure: jest.Mock };
  let omise: { captureCharge: jest.Mock };
  let emitter: { emit: jest.Mock };
  // PYG-375: runOnce ที่เรียก fn(key) ตรง ๆ (ทดสอบ idempotency table แยกใน idempotency.service.spec)
  let idempotency: { runOnce: jest.Mock };

  beforeEach(async () => {
    tx = {
      booking: { update: jest.fn() },
      // lock re-read: default = ยัง held (ยังไม่มีใคร capture)
      payment: {
        findUnique: jest.fn().mockResolvedValue({
          paymentStatus: 'held',
          omiseChargeId: 'chrg_test_1',
        }),
        update: jest.fn(),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    // default booking.update result (tests may override completedAt)
    tx.booking.update.mockResolvedValue({
      id: BOOKING_ID,
      status: 'completed',
      completedAt: new Date('2026-06-22T10:00:00Z'),
    });
    prisma = {
      booking: {
        findUnique: jest.fn(),
        // PYG-375: PromptPay flow ปิด booking ผ่าน prisma.booking.update ตรง ๆ (ไม่ capture)
        update: jest.fn().mockResolvedValue({
          id: BOOKING_ID,
          status: 'completed',
          completedAt: new Date('2026-06-22T10:00:00Z'),
        }),
      },
      payment: { update: jest.fn() },
      // จำลอง $transaction: เรียก callback ด้วย tx mock (รับ opts ตัวที่ 2 ได้)
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    fsm = { transition: jest.fn(), recordCaptureFailure: jest.fn() };
    omise = { captureCharge: jest.fn() };
    emitter = { emit: jest.fn() };
    idempotency = {
      runOnce: jest.fn((params: { key: string; fn: (k: string) => unknown }) =>
        params.fn(params.key),
      ),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        CompleteBookingService,
        { provide: PrismaService, useValue: prisma },
        { provide: PaymentStateMachine, useValue: fsm },
        { provide: OmiseService, useValue: omise },
        // PYG-292: completeBooking ยิง booking.completed/payment.captured — mock EventEmitter2
        { provide: EventEmitter2, useValue: emitter },
        { provide: IdempotencyService, useValue: idempotency },
      ],
    }).compile();

    service = moduleRef.get(CompleteBookingService);
  });

  // ─── happy path ────────────────────────────────────────────────────────────

  it('capture + ปิดงาน เมื่อ booking=confirmed และ payment=held (เรียกโดย patient)', async () => {
    prisma.booking.findUnique.mockResolvedValue(fakeBooking());
    omise.captureCharge.mockResolvedValue(fakeCaptureOk());
    fsm.transition.mockResolvedValue({});
    const completedAt = new Date('2026-06-22T10:00:00Z');
    tx.booking.update.mockResolvedValue({
      id: BOOKING_ID,
      status: 'completed',
      completedAt,
    });

    const result = await service.completeBooking(
      asUser(PATIENT_ID, ROLE_ID.PATIENT),
      BOOKING_ID,
    );

    // capture ถูกยิงด้วย charge id ของ payment
    // PYG-375: capture ส่ง idempotency key (capture:{bookingId}) เป็น Omise header ด้วย
    expect(omise.captureCharge).toHaveBeenCalledWith('chrg_test_1', 'capture:book-0001');

    // payment held → captured ผ่าน FSM และส่ง tx เดียวกันเข้าไป (atomic)
    expect(fsm.transition).toHaveBeenCalledWith(
      PAYMENT_ID,
      PaymentStatus.captured,
      expect.objectContaining({ changedBy: PATIENT_ID }),
      tx,
    );

    // booking confirmed → completed + completed_at
    expect(tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BOOKING_ID },
        data: expect.objectContaining({ status: 'completed' }),
      }),
    );

    // ผลลัพธ์ที่คืนให้ frontend
    expect(result).toEqual(
      expect.objectContaining({
        bookingId: BOOKING_ID,
        status: 'completed',
        paymentStatus: PaymentStatus.captured,
        amount: 1200,
        omiseChargeId: 'chrg_test_1',
        completedAt,
      }),
    );
  });

  it('อนุญาตให้ caregiver ของ booking กดจบงานได้เช่นกัน', async () => {
    prisma.booking.findUnique.mockResolvedValue(fakeBooking());
    omise.captureCharge.mockResolvedValue(fakeCaptureOk());
    fsm.transition.mockResolvedValue({});
    tx.booking.update.mockResolvedValue({
      id: BOOKING_ID,
      status: 'completed',
      completedAt: new Date(),
    });

    await expect(
      service.completeBooking(
        asUser(CAREGIVER_USER_ID, ROLE_ID.CAREGIVER),
        BOOKING_ID,
      ),
    ).resolves.toBeDefined();
    expect(omise.captureCharge).toHaveBeenCalled();
  });

  // ─── guards ──────────────────────────────────────────────────────────────

  it('โยน NotFoundException เมื่อไม่พบ booking', async () => {
    prisma.booking.findUnique.mockResolvedValue(null);

    await expect(
      service.completeBooking(asUser(PATIENT_ID, ROLE_ID.PATIENT), BOOKING_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(omise.captureCharge).not.toHaveBeenCalled();
  });

  it('โยน ForbiddenException เมื่อไม่ใช่ patient/caregiver ของ booking', async () => {
    prisma.booking.findUnique.mockResolvedValue(fakeBooking());

    await expect(
      service.completeBooking(asUser('intruder-9', ROLE_ID.PATIENT), BOOKING_ID),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(omise.captureCharge).not.toHaveBeenCalled();
  });

  it('โยน UnprocessableEntity เมื่อ booking ไม่ใช่ confirmed', async () => {
    prisma.booking.findUnique.mockResolvedValue(
      fakeBooking({ status: 'pending' }),
    );

    await expect(
      service.completeBooking(asUser(PATIENT_ID, ROLE_ID.PATIENT), BOOKING_ID),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(omise.captureCharge).not.toHaveBeenCalled();
  });

  it('โยน UnprocessableEntity เมื่อ payment ไม่ใช่ held', async () => {
    prisma.booking.findUnique.mockResolvedValue(
      fakeBooking({
        payment: {
          id: PAYMENT_ID,
          paymentStatus: 'captured',
          omiseChargeId: 'chrg_test_1',
          amount: 1200,
        },
      }),
    );

    await expect(
      service.completeBooking(asUser(PATIENT_ID, ROLE_ID.PATIENT), BOOKING_ID),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(omise.captureCharge).not.toHaveBeenCalled();
  });

  // ─── capture failure ───────────────────────────────────────────────────────

  it('เมื่อ Omise capture พัง → บันทึก failure, history, แจ้ง admin และไม่ปิด booking', async () => {
    prisma.booking.findUnique.mockResolvedValue(fakeBooking());
    omise.captureCharge.mockRejectedValue(
      new CaptureFailedError('Omise ปฏิเสธการ capture เงิน', {
        omiseChargeId: 'chrg_test_1',
        omiseCode: 'failed_capture',
        omiseMessage: 'insufficient funds',
      }),
    );

    await expect(
      service.completeBooking(asUser(PATIENT_ID, ROLE_ID.PATIENT), BOOKING_ID),
    ).rejects.toBeInstanceOf(CaptureFailedError);

    // บันทึกสาเหตุลง payment + เขียน history failure
    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PAYMENT_ID },
        data: expect.objectContaining({ failureCode: 'failed_capture' }),
      }),
    );
    expect(fsm.recordCaptureFailure).toHaveBeenCalledWith(
      PAYMENT_ID,
      PaymentStatus.held,
      expect.objectContaining({ changedBy: PATIENT_ID }),
    );

    // ต้องไม่ transition/ปิด booking เมื่อ capture พัง (PYG-375: capture อยู่ใน tx แล้ว
    // แต่ Omise พังก่อน → ไม่ถึง fsm.transition และ booking ไม่ถูกปิด — tx rollback)
    expect(fsm.transition).not.toHaveBeenCalled();
    expect(tx.booking.update).not.toHaveBeenCalled();
  });

  // ─── PromptPay flow (PYG-278) ──────────────────────────────────────────────

  describe('PromptPay flow', () => {
    /** PromptPay payment: paymentMethod='promptpay' + status='captured' (จ่ายผ่าน webhook ไปแล้ว) */
    function promptPayBooking(overrides: Record<string, unknown> = {}) {
      return fakeBooking({
        payment: {
          id: PAYMENT_ID,
          paymentStatus: 'captured',
          paymentMethod: 'promptpay',
          omiseChargeId: 'chrg_test_promptpay',
          amount: 1200,
        },
        ...overrides,
      });
    }

    it('completeBooking สำเร็จ — ไม่เรียก Omise capture, ไม่ FSM transition, แค่ปิด booking', async () => {
      prisma.booking.findUnique.mockResolvedValue(promptPayBooking());
      const completedAt = new Date('2026-06-22T10:00:00Z');
      tx.booking.update.mockResolvedValue({
        id: BOOKING_ID,
        status: 'completed',
        completedAt,
      });

      const result = await service.completeBooking(
        asUser(PATIENT_ID, ROLE_ID.PATIENT),
        BOOKING_ID,
      );

      // ❌ skip Omise capture (เงินอยู่ในมือเราแล้วตั้งแต่ webhook)
      expect(omise.captureCharge).not.toHaveBeenCalled();
      // ❌ skip FSM transition (payment เป็น captured อยู่แล้ว)
      expect(fsm.transition).not.toHaveBeenCalled();
      // ✅ booking confirmed → completed (PYG-375: PromptPay ปิดผ่าน prisma.booking.update ตรง ๆ)
      expect(prisma.booking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: BOOKING_ID },
          data: expect.objectContaining({ status: 'completed' }),
        }),
      );
      // ผลลัพธ์: paymentStatus = captured, omiseChargeId ใช้ของเดิม
      expect(result).toEqual(
        expect.objectContaining({
          bookingId: BOOKING_ID,
          status: 'completed',
          paymentStatus: PaymentStatus.captured,
          omiseChargeId: 'chrg_test_promptpay',
          completedAt,
        }),
      );
    });

    it('emit COMPLETED แต่ไม่ emit PAYMENT_CAPTURED (webhook ยิงไปแล้วตอน user สแกน)', async () => {
      prisma.booking.findUnique.mockResolvedValue(promptPayBooking());
      tx.booking.update.mockResolvedValue({
        id: BOOKING_ID,
        status: 'completed',
        completedAt: new Date(),
      });

      await service.completeBooking(
        asUser(PATIENT_ID, ROLE_ID.PATIENT),
        BOOKING_ID,
      );

      const emittedKeys = emitter.emit.mock.calls.map((c) => c[0] as string);
      expect(emittedKeys).toContain(BOOKING_EVENTS.COMPLETED);
      expect(emittedKeys).not.toContain(BOOKING_EVENTS.PAYMENT_CAPTURED);
    });

    it('PromptPay payment status="pending" → 422 (ยังไม่ได้จ่าย ปิดงานไม่ได้)', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        promptPayBooking({
          payment: {
            id: PAYMENT_ID,
            paymentStatus: 'pending',
            paymentMethod: 'promptpay',
            omiseChargeId: 'chrg_test_promptpay',
            amount: 1200,
          },
        }),
      );

      await expect(
        service.completeBooking(asUser(PATIENT_ID, ROLE_ID.PATIENT), BOOKING_ID),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(omise.captureCharge).not.toHaveBeenCalled();
    });

    it('caregiver กดจบงาน PromptPay → ปิดได้เช่นกัน', async () => {
      prisma.booking.findUnique.mockResolvedValue(promptPayBooking());
      tx.booking.update.mockResolvedValue({
        id: BOOKING_ID,
        status: 'completed',
        completedAt: new Date(),
      });

      await expect(
        service.completeBooking(
          asUser(CAREGIVER_USER_ID, ROLE_ID.CAREGIVER),
          BOOKING_ID,
        ),
      ).resolves.toBeDefined();
      expect(omise.captureCharge).not.toHaveBeenCalled();
    });
  });
});
