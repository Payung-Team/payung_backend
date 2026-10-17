import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { ConsentModule } from '../consent/consent.module';
import { AssessmentService } from './assessment.service';
import { AssessmentResolver } from './assessment.resolver';

@Module({
  imports: [CommonModule, ConsentModule],
  providers: [AssessmentService, AssessmentResolver],
})
export class AssessmentModule {}
