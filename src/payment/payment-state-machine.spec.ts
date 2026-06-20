/**
 * Unit tests สำหรับ PaymentStateMachine (PYG-277)
 *
 * ครอบคลุม:
 * - canTransition: คู่ที่ "ถูกต้อง" และ "ผิด" (รวม same→same, terminal states)
 * - transition: happy path (update + insert history), not found, invalid transition,
 *   และการส่ง changedBy/reason/metadata ลง history
 * - recordInitialStatus: เขียนแถวแรกด้วย fromStatus = null
 *
 * mock PrismaService ทั้งหมด → ไม่แตะ DB จริง (เร็ว + ไม่ต้องตั้ง connection)
 */
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PaymentStateMachine } from './payment-state-machine';
import { PrismaService } from '../common/prisma.service';
import { PaymentStatus } from './entities/payment-status.enum';
import { InvalidPaymentTransitionError } from './errors/invalid-payment-transition.error';

const PAYMENT_ID = 'pay-0001';

/** payment 1 แถว (รูปทรงพอใช้สำหรับ logic ของ state machine) */
function fakePayment(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    paymentStatus: 'held',
    updatedAt: new Date('2026-06-19T00:00:00Z'),
    ...overrides,
  };
}

describe('PaymentStateMachine', () => {
  let machine: PaymentStateMachine;

  // tx = client ที่ $transaction ส่งเข้า callback
  let tx: {
    payment: { findUnique: jest.Mock; update: jest.Mock };
    paymentStatusHistory: { create: jest.Mock };
  };
  let prisma: {
    $transaction: jest.Mock;
    paymentStatusHistory: { create: jest.Mock };
  };

  beforeEach(async () => {
    tx = {
      payment: { findUnique: jest.fn(), update: jest.fn() },
      paymentStatusHistory: { create: jest.fn() },
    };
    prisma = {
      // เรียก callback ด้วย tx mock (จำลองพฤติกรรม $transaction)
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
      paymentStatusHistory: { create: jest.fn() },
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentStateMachine,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    machine = moduleRef.get(PaymentStateMachine);
  });

  // ─── canTransition ─────────────────────────────────────────────────────────

  describe('canTransition', () => {
    it.each([
      [PaymentStatus.pending, PaymentStatus.held],
      [PaymentStatus.pending, PaymentStatus.failed],
      [PaymentStatus.held, PaymentStatus.captured],
      [PaymentStatus.held, PaymentStatus.voided],
      [PaymentStatus.held, PaymentStatus.expired],
      [PaymentStatus.captured, PaymentStatus.transferred],
      [PaymentStatus.captured, PaymentStatus.refunded],
      [PaymentStatus.captured, PaymentStatus.partially_refunded],
    ])('อนุญาต %s → %s', (from, to) => {
      expect(machine.canTransition(from, to)).toBe(true);
    });

    it.each([
      [PaymentStatus.held, PaymentStatus.pending], // ย้อนกลับ
      [PaymentStatus.captured, PaymentStatus.held], // ย้อนกลับ
      [PaymentStatus.pending, PaymentStatus.captured], // ข้ามขั้น
      [PaymentStatus.failed, PaymentStatus.captured], // ออกจาก terminal
      [PaymentStatus.refunded, PaymentStatus.captured], // ออกจาก terminal
      [PaymentStatus.held, PaymentStatus.held], // same → same
    ])('ปฏิเสธ %s → %s', (from, to) => {
      expect(machine.canTransition(from, to)).toBe(false);
    });
  });

  // ─── transition (happy path) ───────────────────────────────────────────────

  describe('transition', () => {
    it('อัปเดตสถานะ + เขียน history เมื่อ transition ถูกต้อง', async () => {
      tx.payment.findUnique.mockResolvedValue(fakePayment({ paymentStatus: 'held' }));
      const updatedRow = fakePayment({ paymentStatus: 'captured' });
      tx.payment.update.mockResolvedValue(updatedRow);
      tx.paymentStatusHistory.create.mockResolvedValue({});

      const result = await machine.transition(PAYMENT_ID, PaymentStatus.captured, {
        changedBy: 'admin-1',
        reason: 'งานเสร็จ',
        metadata: { omiseChargeId: 'chrg_x' },
      });

      // คืน payment ที่อัปเดตแล้ว
      expect(result).toBe(updatedRow);

      // update ไปสถานะปลายทาง
      expect(tx.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: PAYMENT_ID },
          data: expect.objectContaining({ paymentStatus: PaymentStatus.captured }),
        }),
      );

      // history บันทึก from/to + audit fields ครบ
      expect(tx.paymentStatusHistory.create).toHaveBeenCalledWith({
        data: {
          paymentId: PAYMENT_ID,
          fromStatus: PaymentStatus.held,
          toStatus: PaymentStatus.captured,
          changedBy: 'admin-1',
          reason: 'งานเสร็จ',
          metadata: { omiseChargeId: 'chrg_x' },
        },
      });
    });

    it('โยน NotFoundException เมื่อไม่พบ payment', async () => {
      tx.payment.findUnique.mockResolvedValue(null);

      await expect(
        machine.transition(PAYMENT_ID, PaymentStatus.held),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(tx.payment.update).not.toHaveBeenCalled();
      expect(tx.paymentStatusHistory.create).not.toHaveBeenCalled();
    });

    it('โยน InvalidPaymentTransitionError + ไม่แตะ DB เมื่อ transition ผิดกฎ', async () => {
      tx.payment.findUnique.mockResolvedValue(fakePayment({ paymentStatus: 'held' }));

      await expect(
        machine.transition(PAYMENT_ID, PaymentStatus.pending), // held → pending ผิด
      ).rejects.toBeInstanceOf(InvalidPaymentTransitionError);

      expect(tx.payment.update).not.toHaveBeenCalled();
      expect(tx.paymentStatusHistory.create).not.toHaveBeenCalled();
    });

    it('metadata เป็น undefined เมื่อไม่ได้ส่ง options', async () => {
      tx.payment.findUnique.mockResolvedValue(fakePayment({ paymentStatus: 'pending' }));
      tx.payment.update.mockResolvedValue(fakePayment({ paymentStatus: 'held' }));
      tx.paymentStatusHistory.create.mockResolvedValue({});

      await machine.transition(PAYMENT_ID, PaymentStatus.held);

      expect(tx.paymentStatusHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          fromStatus: PaymentStatus.pending,
          toStatus: PaymentStatus.held,
          changedBy: undefined,
          reason: undefined,
          metadata: undefined,
        }),
      });
    });
  });

  // ─── recordInitialStatus ───────────────────────────────────────────────────

  describe('recordInitialStatus', () => {
    it('เขียน history แถวแรกด้วย fromStatus = null', async () => {
      prisma.paymentStatusHistory.create.mockResolvedValue({});

      await machine.recordInitialStatus(PAYMENT_ID, PaymentStatus.pending, {
        reason: 'สร้าง payment',
      });

      expect(prisma.paymentStatusHistory.create).toHaveBeenCalledWith({
        data: {
          paymentId: PAYMENT_ID,
          fromStatus: null,
          toStatus: PaymentStatus.pending,
          changedBy: undefined,
          reason: 'สร้าง payment',
          metadata: undefined,
        },
      });
    });
  });
});
