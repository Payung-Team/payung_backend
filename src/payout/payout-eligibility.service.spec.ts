/**
 * PayoutEligibilityService tests — ตารางกฎ "ปล่อยเงินได้ไหม"
 *
 * เทสต์ตรงนี้คือหัวใจ: create / worker / reaper เรียกกฎชุดเดียวกัน
 * ถ้าตารางนี้ถูก อีก 3 จุดก็ถูกตาม
 *
 * ★ เราไม่เทสต์ว่า verdict ถูกคำนวณยังไง — นั่นเป็นงานของ MonitoringService
 *   ที่นี่เทสต์ว่า "ได้ verdict มาแล้วแปลเป็นการเคลื่อนไหวของเงินถูกไหม"
 */
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PayoutEligibilityService } from './payout-eligibility.service';
import { PrismaService } from '../common/prisma.service';
import { MonitoringService } from '../monitoring/monitoring.service';
import type { ProofOfWorkSummary } from '../monitoring/entities/proof-of-work.entity';

const BOOKING_ID = 'booking-1';
const CHECK_IN_ID = 'evt-in-1';
const CHECK_OUT_ID = 'evt-out-1';

function makeProof(
  overrides: Partial<ProofOfWorkSummary> = {},
): ProofOfWorkSummary {
  return {
    checkIn: { id: CHECK_IN_ID } as ProofOfWorkSummary['checkIn'],
    checkOut: { id: CHECK_OUT_ID } as ProofOfWorkSummary['checkOut'],
    actualMinutes: 120,
    bookedMinutes: 120,
    durationOk: true,
    noCheckout: false,
    jobCoordsMissing: false,
    reviewReasons: [],
    disputed: false,
    verdict: 'valid',
    ...overrides,
  } as ProofOfWorkSummary;
}

describe('PayoutEligibilityService', () => {
  let service: PayoutEligibilityService;
  let prisma: { payment: { findUnique: jest.Mock } };
  let monitoring: { proofOfWorkForSystem: jest.Mock };

  beforeEach(async () => {
    prisma = { payment: { findUnique: jest.fn() } };
    monitoring = { proofOfWorkForSystem: jest.fn() };

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        PayoutEligibilityService,
        { provide: PrismaService, useValue: prisma },
        { provide: MonitoringService, useValue: monitoring },
      ],
    }).compile();

    service = mod.get(PayoutEligibilityService);
  });

  const noRefund = { refundedAmount: new Prisma.Decimal('0') };

  describe('evaluate — ตารางกฎ', () => {
    it("verdict='valid' + ไม่มี refund → eligible", () => {
      const v = service.evaluate(makeProof(), noRefund);
      expect(v.kind).toBe('eligible');
      expect(v.reason).toBe('proof_valid');
    });

    it("verdict='needs_review' → hold (ห้าม deny — แอดมินอาจตัดสินว่าผู้ดูแลถูก)", () => {
      const v = service.evaluate(
        makeProof({
          verdict: 'needs_review',
          reviewReasons: ['out_of_radius'],
        }),
        noRefund,
      );
      expect(v.kind).toBe('hold');
      expect(v.reason).toBe('proof_needs_review');
    });

    it("verdict='incomplete' + ไม่มีเช็คเอาท์ → hold พร้อมเหตุผล no_checkout", () => {
      const v = service.evaluate(
        makeProof({
          verdict: 'incomplete',
          checkOut: undefined,
          noCheckout: true,
          actualMinutes: undefined,
        }),
        noRefund,
      );
      expect(v.kind).toBe('hold');
      expect(v.reason).toBe('proof_no_checkout');
    });

    it("verdict='incomplete' แบบไม่มีเช็คอิน → hold (proof_incomplete)", () => {
      const v = service.evaluate(
        makeProof({ verdict: 'incomplete', checkIn: undefined }),
        noRefund,
      );
      expect(v.kind).toBe('hold');
      expect(v.reason).toBe('proof_incomplete');
    });

    it('มีข้อพิพาท (verdict กลายเป็น needs_review) → hold ไม่จ่าย', () => {
      const v = service.evaluate(
        makeProof({ verdict: 'needs_review', disputed: true }),
        noRefund,
      );
      expect(v.kind).toBe('hold');
    });

    // ── refund ต้องมาก่อน verdict ─────────────────────────────────────────
    it('คืนเงินลูกค้าไปแล้ว → deny ถึงแม้ verdict จะ valid', () => {
      const v = service.evaluate(makeProof({ verdict: 'valid' }), {
        refundedAmount: new Prisma.Decimal('1000.00'),
      });
      expect(v.kind).toBe('deny');
      expect(v.reason).toBe('payment_refunded');
    });

    it('คืนเงินบางส่วน → deny เช่นกัน', () => {
      const v = service.evaluate(makeProof(), {
        refundedAmount: new Prisma.Decimal('0.01'),
      });
      expect(v.kind).toBe('deny');
    });

    it('ไม่มี payment row → ถือว่าไม่มี refund', () => {
      expect(service.evaluate(makeProof(), null).kind).toBe('eligible');
    });

    it('รับ refundedAmount เป็น number/string ได้', () => {
      expect(service.evaluate(makeProof(), { refundedAmount: 5 }).kind).toBe(
        'deny',
      );
      expect(
        service.evaluate(makeProof(), { refundedAmount: '5.00' }).kind,
      ).toBe('deny');
    });

    // ── evidence ─────────────────────────────────────────────────────────
    it('แนบ checkInId / checkOutId / verdict ลง evidence เสมอ', () => {
      const v = service.evaluate(makeProof(), noRefund);
      expect(v.evidence).toEqual(
        expect.objectContaining({
          checkInId: CHECK_IN_ID,
          checkOutId: CHECK_OUT_ID,
          verdict: 'valid',
        }),
      );
    });

    it('ไม่มีเช็คเอาท์ → checkOutId เป็น null (ไม่ใช่ undefined ที่หายไปตอน JSON)', () => {
      const v = service.evaluate(
        makeProof({
          verdict: 'incomplete',
          checkOut: undefined,
          noCheckout: true,
        }),
        noRefund,
      );
      expect(v.evidence.checkOutId).toBeNull();
    });
  });

  describe('check — โหลดหลักฐานเอง', () => {
    it('อ่านหลักฐานได้ + valid → eligible', async () => {
      monitoring.proofOfWorkForSystem.mockResolvedValue(makeProof());
      prisma.payment.findUnique.mockResolvedValue(noRefund);

      const v = await service.check(BOOKING_ID);

      expect(v.kind).toBe('eligible');
      expect(monitoring.proofOfWorkForSystem).toHaveBeenCalledWith(BOOKING_ID);
    });

    it('booking ไม่มีอยู่ (proofOfWork throw) → hold ไม่ throw ต่อ', async () => {
      monitoring.proofOfWorkForSystem.mockRejectedValue(
        new NotFoundException('ไม่พบงานนี้'),
      );

      const v = await service.check(BOOKING_ID);

      // hold ไม่ใช่ deny — DB ล่มชั่วคราวไม่ควรทำให้ payout ถูกยกเลิกถาวร
      expect(v.kind).toBe('hold');
      expect(v.reason).toBe('proof_unavailable');
    });

    it('ไม่ throw ออกไปหา caller เด็ดขาด (ทุก caller อยู่บน path ที่ห้าม throw)', async () => {
      monitoring.proofOfWorkForSystem.mockRejectedValue(new Error('db down'));

      await expect(service.check(BOOKING_ID)).resolves.toEqual(
        expect.objectContaining({ kind: 'hold' }),
      );
    });
  });
});
