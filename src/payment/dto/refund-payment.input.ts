/**
 * RefundPaymentInput — admin refund (PYG-286 / PYG-374)
 *
 * - paymentId : payment ที่ต้องการคืนเงิน (ต้องอยู่สถานะ "captured")
 * - amount    : optional. ไม่ระบุ = คืนเต็มจำนวน. ระบุ = partial refund
 *               ต้องอยู่ในช่วง (0, payment.amount] — service ตรวจอีกชั้น
 * - reason    : REQUIRED, อย่างน้อย 10 ตัวอักษร (PYG-374)
 *               RefundService บังคับ reason >= 10 ทุกเส้นทาง → validate ที่ boundary นี้
 *               ให้ bad request ตกที่ API พร้อมข้อความไทยชัดเจน ไม่ใช่ตกลึกใน service
 *               หลัง FE คิดว่าส่งสำเร็จไปแล้ว
 */
import { Field, Float, ID, InputType } from '@nestjs/graphql';
import {
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/** ข้อความเดียวกันทุก constraint ของ reason → FE เห็นข้อความไทยชัดเจนไม่ว่าพลาดแบบไหน */
const REASON_MESSAGE = 'กรุณาระบุเหตุผลอย่างน้อย 10 ตัวอักษร';

@InputType()
export class RefundPaymentInput {
  @Field(() => ID, { description: 'UUID ของ payment ที่ต้องการคืนเงิน' })
  @IsUUID('4')
  paymentId!: string;

  @Field(() => Float, {
    nullable: true,
    description: 'จำนวนเงินที่คืน (THB) — ไม่ระบุ = คืนเต็มจำนวน, ระบุ = partial refund',
  })
  @IsOptional()
  @IsPositive()
  amount?: number;

  @Field({ description: 'เหตุผลการคืนเงิน (audit) — ต้องมีอย่างน้อย 10 ตัวอักษร' })
  @IsString({ message: REASON_MESSAGE })
  @IsNotEmpty({ message: REASON_MESSAGE })
  @MinLength(10, { message: REASON_MESSAGE })
  @MaxLength(500)
  reason!: string;
}
