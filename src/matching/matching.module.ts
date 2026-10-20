import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { SearchModule } from '../search/search.module';
import { MatchingResolver } from './matching.resolver';
import { MatchingService } from './matching.service';
@Module({
  imports: [CommonModule, SearchModule],
  providers: [MatchingService, MatchingResolver],
})
export class MatchingModule {}
