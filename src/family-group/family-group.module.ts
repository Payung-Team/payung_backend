import { Module } from '@nestjs/common';
import { FamilyGroupService } from './family-group.service';
import { FamilyGroupResolver } from './family-group.resolver';
import { CommonModule } from '../common/common.module';

/**
 * FamilyGroupModule — family group features (PYG-392)
 * CommonModule is @Global but imported for clarity (follows BookingModule/ReviewModule pattern).
 */
@Module({
  imports: [CommonModule],
  providers: [FamilyGroupResolver, FamilyGroupService],
})
export class FamilyGroupModule {}
