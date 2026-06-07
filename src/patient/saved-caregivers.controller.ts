import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SavedCaregiversService } from './saved-caregivers.service';
import { SaveCaregiverDto } from './dto/saved-caregiver.dto';
import { SupabaseHttpAuthGuard } from '../common/guards/supabase-http-auth.guard';
import { HttpRolesGuard } from '../common/guards/http-roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentHttpUser, AuthUser } from '../common/decorators/current-user.decorator';
import { ROLE_ID } from '../common/constants/roles.constant';

/**
 * Saved Caregivers REST Controller
 *
 * GET    /api/v1/patient/saved-caregivers               — list
 * POST   /api/v1/patient/saved-caregivers               — save
 * DELETE /api/v1/patient/saved-caregivers/:caregiver_id — unsave
 */
@Controller('api/v1/patient/saved-caregivers')
@UseGuards(SupabaseHttpAuthGuard, HttpRolesGuard)
@Roles(ROLE_ID.PATIENT)
export class SavedCaregiversController {
  constructor(private readonly service: SavedCaregiversService) {}

  @Get()
  list(@CurrentHttpUser() user: AuthUser) {
    return this.service.list(user.id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  save(
    @Body() dto: SaveCaregiverDto,
    @CurrentHttpUser() user: AuthUser,
  ) {
    return this.service.save(user.id, dto.caregiverId);
  }

  @Delete(':caregiver_id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unsave(
    @Param('caregiver_id') caregiverId: string,
    @CurrentHttpUser() user: AuthUser,
  ) {
    await this.service.unsave(user.id, caregiverId);
  }
}
