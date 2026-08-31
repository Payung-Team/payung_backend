import { Module } from '@nestjs/common';
import { ReviewService } from './review.service';
import { ReviewResolver } from './review.resolver';
import { CommonModule } from '../common/common.module';

/**
 * ReviewModule — ฟีเจอร์รีวิว/เรตติ้ง (PYG-297)
 * CommonModule เป็น @Global อยู่แล้ว แต่ import ตามธรรมเนียมของ module อื่น (เช่น BookingModule)
 * เพื่อความชัดเจนว่าใช้ PrismaService
 */
@Module({
  imports: [CommonModule],
  providers: [ReviewResolver, ReviewService],
})
export class ReviewModule {}
