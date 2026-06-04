import { Module } from '@nestjs/common';
import { BookingService } from './booking.service';
import { BookingResolver } from './booking.resolver';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [CommonModule],
  providers: [BookingService, BookingResolver],
})
export class BookingModule {}
