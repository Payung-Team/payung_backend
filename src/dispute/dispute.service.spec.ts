/**
 * Unit tests for DisputeService (PYG-287)
 *
 * Covers:
 *  - flagBookingDispute: happy path + every guard (status/owner/reason/dup)
 *  - adminDisputes: default filter = 'flagged', pagination math
 *  - resolveDispute: no_refund / refund_full / refund_partial — calls real
 *    PaymentService.refundPayment (PYG-286 merged into dev — DTO + AuthUser signature)
 *  - guards: non-flagged → 422
 *
 * Prisma + PaymentService are mocked → no DB or network.
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { RefundService } from '../payment/refund.service';
import { DisputeService } from './dispute.service';
import { DisputeDecision } from './entities/dispute-decision.enum';
import { DisputeStatus } from './entities/dispute-status.enum';
import { DisputeFiledBy } from './entities/dispute-filed-by.enum';
import { DisputeSortBy } from './dto/dispute-sort.enum';
import { ROLE_ID } from '../common/constants/roles.constant';
import { AuthUser } from '../common/decorators/current-user.decorator';

const PATIENT_ID = 'pat-001';
const ADMIN_ID = 'adm-001';
const BOOKING_ID = '00000000-0000-0000-0000-000000000001';
const PAYMENT_ID = '00000000-0000-0000-0000-000000000099';

// PYG-286: refundPayment ใหม่รับ AuthUser ไม่ใช่ string id
const ADMIN_AUTHUSER: AuthUser = {
  id: ADMIN_ID,
  role: ROLE_ID.ADMIN,
} as AuthUser;

// reason ที่มี ≥ 20 ตัวอักษร (default ใช้ในเคสปกติ)
const REASON_LONG = 'caregiver ไม่มาตามนัด รอเก้อทั้งวัน';

function fakeBookingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    patientId: PATIENT_ID,
    caregiverId: 'cg-001',
    status: 'completed',
    serviceType: 'general_care',
    timeSlot: 'morning',
    locationAddress: '123 main',
    bookingDate: new Date('2026-06-01T00:00:00Z'),
    estimatedCost: { toNumber: () => 1500 },
    disputeStatus: DisputeStatus.none,
    disputeReason: null,
    disputeResolvedAt: null,
    disputeFiledAt: null,
    disputeFiledBy: null,
    createdAt: new Date('2026-06-01T08:00:00Z'),
    updatedAt: new Date('2026-06-02T08:00:00Z'),
    patient: { id: PATIENT_ID, displayName: 'Patient One', email: 'p1@x.test' },
    caregiver: {
      id: 'cg-001',
      user: { id: 'cg-user-001', displayName: 'CG One', email: 'cg1@x.test' },
    },
    payment: {
      id: PAYMENT_ID,
      amount: { toNumber: () => 1500 },
      currency: 'THB',
      paymentStatus: 'captured',
    },
    ...overrides,
  };
}

describe('DisputeService', () => {
  let service: DisputeService;
  let prisma: {
    booking: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
    };
  };
  let refundSvc: { refund: jest.Mock };

  beforeEach(async () => {
    prisma = {
      booking: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
      },
    };
    refundSvc = {
      refund: jest.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        DisputeService,
        { provide: PrismaService, useValue: prisma },
        { provide: RefundService, useValue: refundSvc },
      ],
    }).compile();

    service = moduleRef.get(DisputeService);
  });

  // ─── flagBookingDispute ──────────────────────────────────────────────────

  describe('flagBookingDispute', () => {
    it('Pass — completed + patient + reason≥20 → flagged + emits dispute.created', async () => {
      prisma.booking.findUnique
        .mockResolvedValueOnce({
          patientId: PATIENT_ID,
          status: 'completed',
          disputeStatus: 'none',
        })
        .mockResolvedValueOnce(
          fakeBookingRow({
            disputeStatus: 'flagged',
            disputeReason: REASON_LONG,
          }),
        );
      prisma.booking.update.mockResolvedValue({});

      const result = await service.flagBookingDispute(
        BOOKING_ID,
        REASON_LONG,
        PATIENT_ID,
      );

      // PYG-316: flag ต้องบันทึก filed_at (เวลาปัจจุบัน) + filed_by='customer' ด้วย
      expect(prisma.booking.update).toHaveBeenCalledWith({
        where: { id: BOOKING_ID },
        data: {
          disputeStatus: 'flagged',
          disputeReason: REASON_LONG,
          disputeFiledAt: expect.any(Date),
          disputeFiledBy: 'customer',
        },
      });
      expect(result.disputeStatus).toBe(DisputeStatus.flagged);
      expect(result.disputeReason).toBe(REASON_LONG);
    });

    it('Fail — booking not found → NotFoundException', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.flagBookingDispute(BOOKING_ID, REASON_LONG, PATIENT_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('Fail — non-patient owner → ForbiddenException', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce({
        patientId: 'someone-else',
        status: 'completed',
        disputeStatus: 'none',
      });
      await expect(
        service.flagBookingDispute(BOOKING_ID, REASON_LONG, PATIENT_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('Fail — non-completed booking → UnprocessableEntityException', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce({
        patientId: PATIENT_ID,
        status: 'confirmed',
        disputeStatus: 'none',
      });
      await expect(
        service.flagBookingDispute(BOOKING_ID, REASON_LONG, PATIENT_ID),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('Fail — duplicate flag → UnprocessableEntityException', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce({
        patientId: PATIENT_ID,
        status: 'completed',
        disputeStatus: 'flagged',
      });
      await expect(
        service.flagBookingDispute(BOOKING_ID, REASON_LONG, PATIENT_ID),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('Fail — reason < 20 chars → BadRequestException', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce({
        patientId: PATIENT_ID,
        status: 'completed',
        disputeStatus: 'none',
      });
      await expect(
        service.flagBookingDispute(BOOKING_ID, 'too short', PATIENT_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── adminDisputes ───────────────────────────────────────────────────────

  describe('adminDisputes', () => {
    it('Pass — default: all disputes (exclude none), sla_asc, maps summary + SLA', async () => {
      const filedAt = new Date('2026-06-01T09:00:00Z');
      prisma.booking.findMany.mockResolvedValue([
        fakeBookingRow({
          disputeStatus: 'flagged',
          disputeFiledAt: filedAt,
          disputeFiledBy: 'customer',
        }),
      ]);
      prisma.booking.count.mockResolvedValue(35);

      const result = await service.adminDisputes({});

      // default where = ทุก dispute ยกเว้น 'none'; sort = filed_at asc (sla_asc)
      expect(prisma.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            disputeStatus: { not: DisputeStatus.none },
          }),
          orderBy: { disputeFiledAt: 'asc' },
          skip: 0,
          take: 20,
        }),
      );
      expect(result.totalCount).toBe(35);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(result.hasNextPage).toBe(true);

      // summary mapping
      const node = result.nodes[0];
      expect(node.id).toBe(BOOKING_ID);
      expect(node.bookingId).toBe(BOOKING_ID);
      expect(node.filedBy).toBe(DisputeFiledBy.customer);
      expect(node.amount).toBe(1500);
      expect(node.status).toBe(DisputeStatus.flagged);
      expect(node.filedAt).toEqual(filedAt);
      // sla_due_at = filed_at + 72h
      expect(node.slaDueAt).toEqual(
        new Date(filedAt.getTime() + 72 * 60 * 60 * 1000),
      );
    });

    it('Pass — explicit status filter + pagination offset', async () => {
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.count.mockResolvedValue(0);

      await service.adminDisputes({
        disputeStatus: DisputeStatus.resolved,
        page: 2,
        limit: 5,
      });

      expect(prisma.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            disputeStatus: DisputeStatus.resolved,
          }),
          skip: 5,
          take: 5,
        }),
      );
    });

    it('Pass — filedBy + date range → WHERE clauses', async () => {
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.count.mockResolvedValue(0);
      const dateFrom = new Date('2026-06-01T00:00:00Z');
      const dateTo = new Date('2026-06-30T00:00:00Z');

      await service.adminDisputes({
        filedBy: DisputeFiledBy.customer,
        dateFrom,
        dateTo,
      });

      expect(prisma.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            disputeFiledBy: DisputeFiledBy.customer,
            disputeFiledAt: { gte: dateFrom, lte: dateTo },
          }),
        }),
      );
    });

    it('Pass — search q (UUID) → adds id equals to OR', async () => {
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.count.mockResolvedValue(0);

      await service.adminDisputes({ q: BOOKING_ID });

      expect(prisma.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([{ id: BOOKING_ID }]),
          }),
        }),
      );
    });

    it('Pass — search q (non-UUID) → name/email OR only, no id clause', async () => {
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.count.mockResolvedValue(0);

      await service.adminDisputes({ q: 'john' });

      expect(prisma.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            // มี clause ค้นชื่อ/อีเมล แต่ต้องไม่มี id clause (q ไม่ใช่ UUID)
            OR: expect.arrayContaining([
              { patient: { email: { contains: 'john', mode: 'insensitive' } } },
            ]),
          }),
        }),
      );
      expect(prisma.booking.findMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({ id: expect.anything() }),
            ]),
          }),
        }),
      );
    });

    it('Pass — sortBy sla_desc → orderBy disputeFiledAt desc', async () => {
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.count.mockResolvedValue(0);

      await service.adminDisputes({ sortBy: DisputeSortBy.sla_desc });

      expect(prisma.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { disputeFiledAt: 'desc' } }),
      );
    });
  });

  // ─── resolveDispute ──────────────────────────────────────────────────────

  describe('resolveDispute', () => {
    it('Pass — no_refund → booking resolved, refundPayment NOT called', async () => {
      prisma.booking.findUnique
        .mockResolvedValueOnce({
          disputeStatus: 'flagged',
          patientId: PATIENT_ID,
          caregiverId: 'cg-001',
          payment: { id: PAYMENT_ID, amount: { toNumber: () => 1500 } },
        })
        .mockResolvedValueOnce(
          fakeBookingRow({
            disputeStatus: 'resolved',
            disputeResolvedAt: new Date('2026-06-21T10:00:00Z'),
          }),
        );
      prisma.booking.update.mockResolvedValue({});

      const result = await service.resolveDispute(
        BOOKING_ID,
        DisputeDecision.no_refund,
        undefined,
        'caregiver clarified the issue',
        ADMIN_AUTHUSER,
      );

      expect(refundSvc.refund).not.toHaveBeenCalled();
      expect(prisma.booking.update).toHaveBeenCalledWith({
        where: { id: BOOKING_ID },
        data: expect.objectContaining({ disputeStatus: 'resolved' }),
      });
      expect(result.disputeStatus).toBe(DisputeStatus.resolved);
    });

    it('Fail — non-flagged booking → UnprocessableEntityException', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce({
        disputeStatus: 'none',
        patientId: PATIENT_ID,
        caregiverId: 'cg-001',
        payment: { id: PAYMENT_ID, amount: { toNumber: () => 1500 } },
      });
      await expect(
        service.resolveDispute(
          BOOKING_ID,
          DisputeDecision.no_refund,
          undefined,
          'note',
          ADMIN_AUTHUSER,
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('Fail — booking not found → NotFoundException', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.resolveDispute(
          BOOKING_ID,
          DisputeDecision.no_refund,
          undefined,
          'note',
          ADMIN_AUTHUSER,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('Fail — refund_partial without refundAmount → BadRequestException', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce({
        disputeStatus: 'flagged',
        patientId: PATIENT_ID,
        caregiverId: 'cg-001',
        payment: { id: PAYMENT_ID, amount: { toNumber: () => 1500 } },
      });
      await expect(
        service.resolveDispute(
          BOOKING_ID,
          DisputeDecision.refund_partial,
          undefined,
          'note',
          ADMIN_AUTHUSER,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('Fail — refund_partial with refundAmount > payment.amount → BadRequestException', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce({
        disputeStatus: 'flagged',
        patientId: PATIENT_ID,
        caregiverId: 'cg-001',
        payment: { id: PAYMENT_ID, amount: { toNumber: () => 1500 } },
      });
      await expect(
        service.resolveDispute(
          BOOKING_ID,
          DisputeDecision.refund_partial,
          2000,
          'note',
          ADMIN_AUTHUSER,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    // PYG-374: refund_full / refund_partial → calls RefundService.refund (source=dispute)

    it('refund_full → calls RefundService.refund (no amount = full, source=dispute, actorId)', async () => {
      prisma.booking.findUnique
        .mockResolvedValueOnce({
          disputeStatus: 'flagged',
          patientId: PATIENT_ID,
          caregiverId: 'cg-001',
          payment: { id: PAYMENT_ID, amount: { toNumber: () => 1500 } },
        })
        // getDisputeBooking ที่ resolveDispute เรียกท้ายสุดสำหรับ build response
        .mockResolvedValueOnce(
          fakeBookingRow({
            disputeStatus: 'resolved',
            disputeResolvedAt: new Date('2026-06-28T10:00:00Z'),
          }),
        );
      refundSvc.refund.mockResolvedValue({});
      prisma.booking.update.mockResolvedValue({});

      const result = await service.resolveDispute(
        BOOKING_ID,
        DisputeDecision.refund_full,
        undefined,
        'full refund',
        ADMIN_AUTHUSER,
      );

      // PYG-374: refund({ paymentId, reason, source:'dispute', actorId }) — no amount = full
      expect(refundSvc.refund).toHaveBeenCalledWith({
        paymentId: PAYMENT_ID,
        reason: expect.stringContaining('full refund'),
        source: 'dispute',
        actorId: ADMIN_ID,
      });
      expect(result.disputeStatus).toBe(DisputeStatus.resolved);
    });

    it('refund_partial → calls RefundService.refund with amount + source=dispute + actorId', async () => {
      prisma.booking.findUnique
        .mockResolvedValueOnce({
          disputeStatus: 'flagged',
          patientId: PATIENT_ID,
          caregiverId: 'cg-001',
          payment: { id: PAYMENT_ID, amount: { toNumber: () => 1500 } },
        })
        .mockResolvedValueOnce(
          fakeBookingRow({
            disputeStatus: 'resolved',
            disputeResolvedAt: new Date('2026-06-28T10:00:00Z'),
          }),
        );
      refundSvc.refund.mockResolvedValue({});
      prisma.booking.update.mockResolvedValue({});

      const result = await service.resolveDispute(
        BOOKING_ID,
        DisputeDecision.refund_partial,
        500,
        'partial refund 500',
        ADMIN_AUTHUSER,
      );

      expect(refundSvc.refund).toHaveBeenCalledWith({
        paymentId: PAYMENT_ID,
        amount: 500,
        reason: expect.stringContaining('partial refund 500'),
        source: 'dispute',
        actorId: ADMIN_ID,
      });
      expect(result.disputeStatus).toBe(DisputeStatus.resolved);
    });
  });
});
