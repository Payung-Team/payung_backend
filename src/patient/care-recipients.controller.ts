import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CareRecipientsService } from './care-recipients.service';
import { CreateCareRecipientDto, UpdateCareRecipientDto } from './dto/care-recipient.dto';
import { SupabaseHttpAuthGuard } from '../common/guards/supabase-http-auth.guard';
import { HttpRolesGuard } from '../common/guards/http-roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentHttpUser, AuthUser } from '../common/decorators/current-user.decorator';
import { ROLE_ID } from '../common/constants/roles.constant';

/**
 * Care Recipients REST Controller
 *
 * GET /api/v1/patient/care-recipients        — list profiles
 * POST /api/v1/patient/care-recipients       — สร้าง profile ใหม่
 * PUT  /api/v1/patient/care-recipients/:id   — แก้ไข profile
 */
@Controller('api/v1/patient/care-recipients')
@UseGuards(SupabaseHttpAuthGuard, HttpRolesGuard)
@Roles(ROLE_ID.PATIENT)
export class CareRecipientsController {
  constructor(private readonly service: CareRecipientsService) {}

  @Get()
  list(@CurrentHttpUser() user: AuthUser) {
    return this.service.list(user.id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body() dto: CreateCareRecipientDto,
    @CurrentHttpUser() user: AuthUser,
  ) {
    return this.service.create(user.id, dto);
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCareRecipientDto,
    @CurrentHttpUser() user: AuthUser,
  ) {
    return this.service.update(user.id, id, dto);
  }
}
