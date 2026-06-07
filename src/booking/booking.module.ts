import { Module } from '@nestjs/common';
import { BookingService } from './booking.service';
import { BookingResolver } from './booking.resolver';
import { BookingController, BookingTaskSuggestionsController } from './booking.controller';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [CommonModule],
  controllers: [BookingController, BookingTaskSuggestionsController],
  providers: [BookingService, BookingResolver],
})
export class BookingModule {}
