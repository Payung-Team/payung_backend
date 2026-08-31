import { Module } from '@nestjs/common';
import { CaregiverPublicController } from './caregiver-public.controller';
import { CaregiverPublicService } from './caregiver-public.service';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [CommonModule],
  controllers: [CaregiverPublicController],
  providers: [CaregiverPublicService],
})
export class CaregiverPublicModule {}
