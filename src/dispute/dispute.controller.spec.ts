/**
 * Unit tests for DisputeController (REST admin endpoints)
 *
 * DisputeService is mocked entirely — these tests only assert that the
 * controller delegates to the service with the right arguments, including
 * the REST resolution → GraphQL DisputeDecision mapping.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { DisputeController } from './dispute.controller';
import { DisputeService } from './dispute.service';
import { DisputeResolutionAction } from './dto/resolve-dispute.dto';
import { DisputeDecision } from './entities/dispute-decision.enum';
import { ROLE_ID } from '../common/constants/roles.constant';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { SupabaseService } from '../common/supabase.service';
import { PrismaService } from '../common/prisma.service';

const BOOKING_ID = '00000000-0000-0000-0000-000000000001';
const ADMIN_AUTHUSER: AuthUser = {
  id: 'adm-001',
  role: ROLE_ID.ADMIN,
  email: 'admin@payung.local',
} as AuthUser;

describe('DisputeController', () => {
  let controller: DisputeController;
  let service: {
    getDisputeDetail: jest.Mock;
    addNote: jest.Mock;
    resolveDispute: jest.Mock;
  };

  beforeEach(async () => {
    service = {
      getDisputeDetail: jest.fn(),
      addNote: jest.fn(),
      resolveDispute: jest.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [DisputeController],
      providers: [
        { provide: DisputeService, useValue: service },
        // guards ทดสอบแยกอยู่แล้ว (http-roles.guard / supabase-http-auth.guard) —
        // ที่นี่แค่ให้ SupabaseHttpAuthGuard/HttpRolesGuard construct ได้ตอน compile module
        // (Nest instantiate @UseGuards() ทันทีตอน compile แม้เราจะเรียก method ตรง ไม่ผ่าน HTTP)
        { provide: SupabaseService, useValue: {} },
        { provide: PrismaService, useValue: {} },
      ],
    }).compile();

    controller = moduleRef.get(DisputeController);
  });

  describe('getDetail', () => {
    it('delegates to disputeService.getDisputeDetail(id)', () => {
      service.getDisputeDetail.mockResolvedValue({ id: BOOKING_ID });
      controller.getDetail(BOOKING_ID);
      expect(service.getDisputeDetail).toHaveBeenCalledWith(BOOKING_ID);
    });
  });

  describe('addNote', () => {
    it('delegates to disputeService.addNote(id, body, admin)', () => {
      service.addNote.mockResolvedValue({ id: 'audit-001' });
      controller.addNote(
        BOOKING_ID,
        { body: 'contacted patient' },
        ADMIN_AUTHUSER,
      );
      expect(service.addNote).toHaveBeenCalledWith(
        BOOKING_ID,
        'contacted patient',
        ADMIN_AUTHUSER,
      );
    });
  });

  describe('resolve', () => {
    it.each([
      [DisputeResolutionAction.full_refund, DisputeDecision.refund_full],
      [DisputeResolutionAction.partial_refund, DisputeDecision.refund_partial],
      [DisputeResolutionAction.reject, DisputeDecision.no_refund],
    ])(
      'maps resolution=%s → decision=%s and delegates to resolveDispute',
      (resolution, decision) => {
        service.resolveDispute.mockResolvedValue({ id: BOOKING_ID });

        controller.resolve(
          BOOKING_ID,
          { resolution, amount: 500, reason: 'test reason' },
          ADMIN_AUTHUSER,
        );

        expect(service.resolveDispute).toHaveBeenCalledWith(
          BOOKING_ID,
          decision,
          500,
          'test reason',
          ADMIN_AUTHUSER,
        );
      },
    );
  });
});
