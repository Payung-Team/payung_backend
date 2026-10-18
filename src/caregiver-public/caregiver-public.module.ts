import { Module } from '@nestjs/common';
import { CaregiverPublicController } from './caregiver-public.controller';
import { CaregiverPublicService } from './caregiver-public.service';
import { CommonModule } from '../common/common.module';
import { DrivingLicenseService } from '../identity/kyc/driving-license/driving-license.service';

@Module({
  imports: [CommonModule],
  controllers: [CaregiverPublicController],
  providers: [CaregiverPublicService, DrivingLicenseService],
})
export class CaregiverPublicModule {}
