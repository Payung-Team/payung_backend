import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SupabaseHttpAuthGuard } from '../common/guards/supabase-http-auth.guard';
import { HttpRolesGuard } from '../common/guards/http-roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentHttpUser, AuthUser } from '../common/decorators/current-user.decorator';
import { ROLE_ID } from '../common/constants/roles.constant';
import { DisputeService } from './dispute.service';
import { AddDisputeNoteDto } from './dto/add-note.dto';
import { ResolveDisputeDto } from './dto/resolve-dispute.dto';
import { RESOLUTION_TO_DECISION } from './dispute.constants';

/**
 * Dispute REST Controller (admin only)
 *
 * GET   /api/v1/admin/disputes/:id           ① Full detail: parties, booking, payment history, evidence, notes, audit
 * POST  /api/v1/admin/disputes/:id/notes     ② Add internal note
 * PATCH /api/v1/admin/disputes/:id/resolve   ③ Resolve + issue refund via Omise
 */
@Controller('api/v1/admin/disputes')
@UseGuards(SupabaseHttpAuthGuard, HttpRolesGuard)
@Roles(ROLE_ID.ADMIN, ROLE_ID.SUPER_ADMIN)
export class DisputeController {
  constructor(private readonly disputeService: DisputeService) {}

  // ── ① GET /api/v1/admin/disputes/:id ────────────────────────────────────
  @Get(':id')
  getDetail(@Param('id', ParseUUIDPipe) id: string) {
    return this.disputeService.getDisputeDetail(id);
  }

  // ── ② POST /api/v1/admin/disputes/:id/notes ─────────────────────────────
  @Post(':id/notes')
  addNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddDisputeNoteDto,
    @CurrentHttpUser() admin: AuthUser,
  ) {
    return this.disputeService.addNote(id, dto.body, admin);
  }

  // ── ③ PATCH /api/v1/admin/disputes/:id/resolve ──────────────────────────
  @Patch(':id/resolve')
  resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveDisputeDto,
    @CurrentHttpUser() admin: AuthUser,
  ) {
    const decision = RESOLUTION_TO_DECISION[dto.resolution];
    return this.disputeService.resolveDispute(
      id,
      decision,
      dto.amount,
      dto.reason,
      admin,
    );
  }
}
