import { Module } from '@nestjs/common';
import { SearchService } from './search.service';
import { SearchResolver } from './search.resolver';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [CommonModule],
  providers: [SearchService, SearchResolver],
})
export class SearchModule {}
