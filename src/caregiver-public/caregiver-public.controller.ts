import { Controller, Get, Param } from '@nestjs/common';
import { CaregiverPublicService } from './caregiver-public.service';
import { CaregiverPublicDto } from './dto/caregiver-public.dto';

/**
 * GET /api/v1/caregivers/:id/public
 *
 * Public endpoint — no authentication required.
 * Returns a sanitised caregiver profile; throws 404 if the caregiver
 * is not searchable or not yet KYC-verified.
 */
@Controller('api/v1/caregivers')
export class CaregiverPublicController {
  constructor(private readonly service: CaregiverPublicService) {}

  @Get(':id/public')
  getPublicProfile(@Param('id') id: string): Promise<CaregiverPublicDto> {
    return this.service.getPublicProfile(id);
  }
}
