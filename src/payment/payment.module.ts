/**
 * PaymentModule — โมดูลการชำระเงิน (PYG-277 เป็นก้อนแรก)
 *
 * ตอนนี้บรรจุ:
 * - PaymentStateMachine — กฎ FSM + เปลี่ยนสถานะ + เขียน audit (PYG-277)
 * - PaymentService      — query ฝั่งอ่าน (paymentHistory) + ตรวจสิทธิ์
 * - PaymentResolver     — GraphQL endpoint paymentHistory
 *
 * ทำไม export PaymentStateMachine?
 * - ticket อื่นในสปรินต์ (PYG-265 hold, PYG-266 capture, PYG-267 refund)
 *   ต้อง inject PaymentStateMachine เพื่อเรียก transition() ผ่านประตูเดียวกัน
 *
 * SupabaseAuthGuard ใส่ใน providers เพราะใช้ใน @UseGuards บน PaymentResolver
 * (PrismaService มาจาก CommonModule ที่เป็น @Global() อยู่แล้ว)
 */
import { Module } from '@nestjs/common';
import { PaymentStateMachine } from './payment-state-machine';
import { PaymentService } from './payment.service';
import { PaymentResolver } from './payment.resolver';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';

@Module({
  providers: [
    PaymentStateMachine,
    PaymentService,
    PaymentResolver,
    SupabaseAuthGuard,
  ],
  exports: [PaymentStateMachine], // ให้ ticket payment อื่น inject ไปใช้ได้
})
export class PaymentModule {}
