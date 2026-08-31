import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { CareRecipientsController } from './care-recipients.controller';
import { CareRecipientsService } from './care-recipients.service';
import { SavedCaregiversController } from './saved-caregivers.controller';
import { SavedCaregiversService } from './saved-caregivers.service';

/**
 * PatientModule — Care Recipients + Saved Caregivers
 *
 * GET  /api/v1/patient/care-recipients
 * POST /api/v1/patient/care-recipients
 * PUT  /api/v1/patient/care-recipients/:id
 *
 * GET    /api/v1/patient/saved-caregivers
 * POST   /api/v1/patient/saved-caregivers
 * DELETE /api/v1/patient/saved-caregivers/:caregiver_id
 */
@Module({
  imports: [CommonModule],
  controllers: [CareRecipientsController, SavedCaregiversController],
  providers: [CareRecipientsService, SavedCaregiversService],
})
export class PatientModule {}
