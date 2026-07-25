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
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../common/prisma.service';
import { SupabaseService } from '../common/supabase.service';
import { PaymentService } from '../payment/payment.service';
import { DisputeService } from './dispute.service';
import { DisputeDecision } from './entities/dispute-decision.enum';
import { DisputeStatus } from './entities/dispute-status.enum';
import { DisputeFiledBy } from './entities/dispute-filed-by.enum';
import { DisputeSortBy } from './dto/dispute-sort.enum';
import { DISPUTE_AUDIT_ACTION } from './dispute.constants';
import { ROLE_ID } from '../common/constants/roles.constant';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { BOOKING_EVENTS } from '../notification/events/booking-event';

const PATIENT_ID = 'pat-001';
const ADMIN_ID = 'adm-001';
const BOOKING_ID = '00000000-0000-0000-0000-000000000001';
const PAYMENT_ID = '00000000-0000-0000-0000-000000000099';

// PYG-286: refundPayment ใหม่รับ AuthUser ไม่ใช่ string id
const ADMIN_AUTHUSER: AuthUser = {
  id: ADMIN_ID,
  role: ROLE_ID.ADMIN,
  email: 'admin@payung.local',
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
    disputeAuditLog: { create: jest.Mock; findMany: jest.Mock };
    disputeEvidence: { findMany: jest.Mock };
    paymentStatusHistory: { findMany: jest.Mock };
    user: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let payments: { refundPayment: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let supabase: { getAdminClient: jest.Mock };

  beforeEach(async () => {
    prisma = {
      booking: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
      },
      disputeAuditLog: { create: jest.fn(), findMany: jest.fn() },
      disputeEvidence: { findMany: jest.fn() },
      paymentStatusHistory: { findMany: jest.fn() },
      user: { findMany: jest.fn() },
      // Prisma $transaction([...]) รับ array ของ promise ที่ถูกเรียกไปแล้ว → mock ด้วย Promise.all
      $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
    };
    payments = {
      refundPayment: jest.fn(),
    };
    eventEmitter = { emit: jest.fn() };
    supabase = { getAdminClient: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        DisputeService,
        { provide: PrismaService, useValue: prisma },
        { provide: PaymentService, useValue: payments },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: SupabaseService, useValue: supabase },
      ],
    }).compile();

    service = moduleRef.get(DisputeService);
  });

  // ─── flagBookingDispute ──────────────────────────────────────────────────

  describe('flagBookingDispute', () => {
    it('Pass — completed + patient + reason≥20 → flagged + audit row + emits dispute.created', async () => {
      prisma.booking.findUnique
        .mockResolvedValueOnce({
          patientId: PATIENT_ID,
          caregiverId: 'cg-001',
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
      prisma.disputeAuditLog.create.mockResolvedValue({});

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
      // audit trail: บันทึก state change none → flagged อัตโนมัติ
      expect(prisma.disputeAuditLog.create).toHaveBeenCalledWith({
        data: {
          bookingId: BOOKING_ID,
          action: DISPUTE_AUDIT_ACTION.FILED,
          fromStatus: DisputeStatus.none,
          toStatus: DisputeStatus.flagged,
          actorId: PATIENT_ID,
          actorRole: 'patient',
          note: REASON_LONG,
        },
      });
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        BOOKING_EVENTS.DISPUTE_CREATED,
        expect.objectContaining({
          bookingId: BOOKING_ID,
          eventType: BOOKING_EVENTS.DISPUTE_CREATED,
          patientId: PATIENT_ID,
          caregiverId: 'cg-001',
        }),
      );
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
    it('Pass — no_refund → booking resolved, audit row written, refundPayment NOT called', async () => {
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
      prisma.disputeAuditLog.create.mockResolvedValue({});

      const result = await service.resolveDispute(
        BOOKING_ID,
        DisputeDecision.no_refund,
        undefined,
        'caregiver clarified the issue',
        ADMIN_AUTHUSER,
      );

      expect(payments.refundPayment).not.toHaveBeenCalled();
      expect(prisma.booking.update).toHaveBeenCalledWith({
        where: { id: BOOKING_ID },
        data: expect.objectContaining({ disputeStatus: 'resolved' }),
      });
      // audit trail: resolvedBy derive จาก actorId ของแถวนี้ (ไม่มี column disputeResolvedBy แยก)
      expect(prisma.disputeAuditLog.create).toHaveBeenCalledWith({
        data: {
          bookingId: BOOKING_ID,
          action: DISPUTE_AUDIT_ACTION.RESOLVED,
          fromStatus: 'flagged',
          toStatus: DisputeStatus.resolved,
          actorId: ADMIN_ID,
          actorRole: 'admin',
          note: 'caregiver clarified the issue',
          metadata: { decision: DisputeDecision.no_refund, refundAmount: null },
        },
      });
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        BOOKING_EVENTS.DISPUTE_RESOLVED,
        expect.objectContaining({
          bookingId: BOOKING_ID,
          eventType: BOOKING_EVENTS.DISPUTE_RESOLVED,
          patientId: PATIENT_ID,
          caregiverId: 'cg-001',
        }),
      );
      expect(result.disputeStatus).toBe(DisputeStatus.resolved);
    });

    it('Pass — under_review status also accepted by resolve guard', async () => {
      prisma.booking.findUnique
        .mockResolvedValueOnce({
          disputeStatus: 'under_review',
          patientId: PATIENT_ID,
          caregiverId: 'cg-001',
          payment: { id: PAYMENT_ID, amount: { toNumber: () => 1500 } },
        })
        .mockResolvedValueOnce(
          fakeBookingRow({ disputeStatus: 'resolved' }),
        );
      prisma.booking.update.mockResolvedValue({});
      prisma.disputeAuditLog.create.mockResolvedValue({});

      const result = await service.resolveDispute(
        BOOKING_ID,
        DisputeDecision.no_refund,
        undefined,
        'reviewed and rejected',
        ADMIN_AUTHUSER,
      );

      expect(result.disputeStatus).toBe(DisputeStatus.resolved);
    });

    it('Fail — non-flagged/under_review booking → UnprocessableEntityException', async () => {
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

    it('Fail — idempotency: repeat resolve on already-resolved dispute → UnprocessableEntityException (422)', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce({
        disputeStatus: 'resolved',
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
      expect(payments.refundPayment).not.toHaveBeenCalled();
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

    // PYG-286 merged: refund_full / refund_partial → calls real refundPayment

    it('refund_full → calls PaymentService.refundPayment with DTO (no amount = full) + admin AuthUser', async () => {
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
      payments.refundPayment.mockResolvedValue({});
      prisma.booking.update.mockResolvedValue({});

      const result = await service.resolveDispute(
        BOOKING_ID,
        DisputeDecision.refund_full,
        undefined,
        'full refund',
        ADMIN_AUTHUSER,
      );

      // signature ใหม่: { paymentId, reason } + admin AuthUser (no amount = full refund)
      expect(payments.refundPayment).toHaveBeenCalledWith(
        {
          paymentId: PAYMENT_ID,
          reason: expect.stringContaining('full refund'),
        },
        ADMIN_AUTHUSER,
      );
      expect(result.disputeStatus).toBe(DisputeStatus.resolved);
    });

    it('refund_partial → calls PaymentService.refundPayment with amount + admin AuthUser', async () => {
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
      payments.refundPayment.mockResolvedValue({});
      prisma.booking.update.mockResolvedValue({});

      const result = await service.resolveDispute(
        BOOKING_ID,
        DisputeDecision.refund_partial,
        500,
        'partial refund 500',
        ADMIN_AUTHUSER,
      );

      expect(payments.refundPayment).toHaveBeenCalledWith(
        {
          paymentId: PAYMENT_ID,
          amount: 500,
          reason: expect.stringContaining('partial refund 500'),
        },
        ADMIN_AUTHUSER,
      );
      expect(result.disputeStatus).toBe(DisputeStatus.resolved);
    });
  });

  // ─── getDisputeDetail ────────────────────────────────────────────────────

  describe('getDisputeDetail', () => {
    const AUDIT_ROW_FILED = {
      id: 'audit-001',
      bookingId: BOOKING_ID,
      action: DISPUTE_AUDIT_ACTION.FILED,
      fromStatus: 'none',
      toStatus: 'flagged',
      actorId: PATIENT_ID,
      actorRole: 'patient',
      note: REASON_LONG,
      metadata: null,
      createdAt: new Date('2026-06-01T09:00:00Z'),
    };
    const AUDIT_ROW_NOTE = {
      id: 'audit-002',
      bookingId: BOOKING_ID,
      action: DISPUTE_AUDIT_ACTION.NOTE_ADDED,
      fromStatus: null,
      toStatus: null,
      actorId: ADMIN_ID,
      actorRole: 'admin',
      note: 'contacted patient',
      metadata: null,
      createdAt: new Date('2026-06-02T09:00:00Z'),
    };
    const AUDIT_ROW_RESOLVED = {
      id: 'audit-003',
      bookingId: BOOKING_ID,
      action: DISPUTE_AUDIT_ACTION.RESOLVED,
      fromStatus: 'flagged',
      toStatus: 'resolved',
      actorId: ADMIN_ID,
      actorRole: 'admin',
      note: 'refunded in full',
      metadata: { decision: 'refund_full', refundAmount: null },
      createdAt: new Date('2026-06-03T09:00:00Z'),
    };
    const EVIDENCE_ROW = {
      id: 'evid-001',
      bookingId: BOOKING_ID,
      uploadedBy: PATIENT_ID,
      uploaderRole: 'patient',
      fileUrl:
        'https://proj.supabase.co/storage/v1/object/dispute-evidence/abc.png',
      fileName: 'proof.png',
      fileSize: 1024,
      mimeType: 'image/png',
      note: null,
      createdAt: new Date('2026-06-01T09:30:00Z'),
    };
    const USERS = [
      { id: PATIENT_ID, displayName: 'Patient One', email: 'p1@x.test' },
      { id: ADMIN_ID, displayName: 'Admin One', email: 'admin@payung.local' },
    ];

    it('Fail — booking not found → NotFoundException', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(null);
      await expect(service.getDisputeDetail(BOOKING_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('Pass — assembles booking + payment history + evidence (signed) + notes + audit + resolvedBy', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(fakeBookingRow());
      prisma.paymentStatusHistory.findMany.mockResolvedValueOnce([
        {
          id: 'psh-001',
          paymentId: PAYMENT_ID,
          fromStatus: null,
          toStatus: 'captured',
          changedBy: null,
          reason: null,
          metadata: null,
          createdAt: new Date('2026-06-01T08:30:00Z'),
        },
      ]);
      prisma.disputeEvidence.findMany.mockResolvedValueOnce([EVIDENCE_ROW]);
      prisma.disputeAuditLog.findMany.mockResolvedValueOnce([
        AUDIT_ROW_RESOLVED,
        AUDIT_ROW_NOTE,
        AUDIT_ROW_FILED,
      ]);
      prisma.user.findMany.mockResolvedValueOnce(USERS);

      const signedUrl = 'https://proj.supabase.co/storage/v1/object/sign/...';
      const createSignedUrl = jest
        .fn()
        .mockResolvedValue({ data: { signedUrl }, error: null });
      supabase.getAdminClient.mockReturnValue({
        storage: { from: jest.fn().mockReturnValue({ createSignedUrl }) },
      });

      const detail = await service.getDisputeDetail(BOOKING_ID);

      expect(detail.paymentHistory).toHaveLength(1);
      expect(detail.evidence).toHaveLength(1);
      expect(detail.evidence[0].fileUrl).toBe(signedUrl);
      expect(detail.evidence[0].uploadedBy).toEqual(
        expect.objectContaining({ id: PATIENT_ID }),
      );
      expect(detail.notes).toHaveLength(1);
      expect(detail.notes[0].note).toBe('contacted patient');
      expect(detail.audit).toHaveLength(3);
      expect(detail.resolvedBy).toEqual(
        expect.objectContaining({ id: ADMIN_ID }),
      );
    });

    it('Pass — evidence signing failure falls back to raw fileUrl', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(fakeBookingRow());
      prisma.paymentStatusHistory.findMany.mockResolvedValueOnce([]);
      prisma.disputeEvidence.findMany.mockResolvedValueOnce([EVIDENCE_ROW]);
      prisma.disputeAuditLog.findMany.mockResolvedValueOnce([]);
      prisma.user.findMany.mockResolvedValueOnce(USERS);

      const createSignedUrl = jest
        .fn()
        .mockResolvedValue({ data: null, error: new Error('sign failed') });
      supabase.getAdminClient.mockReturnValue({
        storage: { from: jest.fn().mockReturnValue({ createSignedUrl }) },
      });

      const detail = await service.getDisputeDetail(BOOKING_ID);

      expect(detail.evidence[0].fileUrl).toBe(EVIDENCE_ROW.fileUrl);
    });

    it('Pass — no resolved audit row → resolvedBy is undefined', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(fakeBookingRow());
      prisma.paymentStatusHistory.findMany.mockResolvedValueOnce([]);
      prisma.disputeEvidence.findMany.mockResolvedValueOnce([]);
      prisma.disputeAuditLog.findMany.mockResolvedValueOnce([AUDIT_ROW_FILED]);
      prisma.user.findMany.mockResolvedValueOnce(USERS);

      const detail = await service.getDisputeDetail(BOOKING_ID);

      expect(detail.resolvedBy).toBeUndefined();
    });
  });

  // ─── addNote ─────────────────────────────────────────────────────────────

  describe('addNote', () => {
    it('Fail — booking not found → NotFoundException', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.addNote(BOOKING_ID, 'a note', ADMIN_AUTHUSER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('Pass — creates exactly one dispute_audit_logs row with action=note_added', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce({ id: BOOKING_ID });
      prisma.disputeAuditLog.create.mockResolvedValueOnce({
        id: 'audit-100',
        bookingId: BOOKING_ID,
        action: DISPUTE_AUDIT_ACTION.NOTE_ADDED,
        fromStatus: null,
        toStatus: null,
        actorId: ADMIN_ID,
        actorRole: 'admin',
        note: 'contacted patient for evidence',
        metadata: null,
        createdAt: new Date('2026-06-05T10:00:00Z'),
      });

      const result = await service.addNote(
        BOOKING_ID,
        'contacted patient for evidence',
        ADMIN_AUTHUSER,
      );

      expect(prisma.disputeAuditLog.create).toHaveBeenCalledTimes(1);
      expect(prisma.disputeAuditLog.create).toHaveBeenCalledWith({
        data: {
          bookingId: BOOKING_ID,
          action: DISPUTE_AUDIT_ACTION.NOTE_ADDED,
          actorId: ADMIN_ID,
          actorRole: 'admin',
          note: 'contacted patient for evidence',
        },
      });
      expect(result.action).toBe(DISPUTE_AUDIT_ACTION.NOTE_ADDED);
      expect(result.note).toBe('contacted patient for evidence');
      expect(result.actor).toEqual(
        expect.objectContaining({ id: ADMIN_ID, email: ADMIN_AUTHUSER.email }),
      );
    });
  });
});
