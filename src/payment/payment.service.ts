/**
 * PaymentService — query ฝั่งอ่านสำหรับ payment (PYG-277)
 *
 * ตอนนี้มีเมธอดเดียว: getHistory() — ดึง audit trail ของ payment 1 ใบ
 * (การ "เปลี่ยนสถานะ" อยู่ที่ PaymentStateMachine แยกความรับผิดชอบกัน)
 *
 * Security (PDPA — กันคนแอบดู payment ของคนอื่น):
 * - เห็น history ได้เฉพาะ "คู่กรณีของ payment ใบนั้น" (patient หรือ caregiver)
 *   หรือ admin (role=3) เท่านั้น — คนอื่น → ForbiddenException
 */
import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { ADMIN_ROLE } from '../common/guards/admin.guard';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { PaymentStatus } from './entities/payment-status.enum';
import { PaymentStatusHistory } from './entities/payment-status-history.entity';

/** shape ของ history ที่ Prisma คืนมา (paymentStatus เป็น string-union) */
type PrismaHistoryRow = {
  id: string;
  paymentId: string;
  fromStatus: PaymentStatus | null;
  toStatus: PaymentStatus;
  changedBy: string | null;
  reason: string | null;
  metadata: Prisma.JsonValue | null;
  createdAt: Date;
};

@Injectable()
export class PaymentService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * แปลง Prisma row → GraphQL entity
   * - metadata (jsonb) → JSON string (ตามแนว Notification.data — ยังไม่มี JSON scalar)
   * - null → undefined ให้ตรงกับ field nullable ของ GraphQL
   */
  private mapToEntity(row: PrismaHistoryRow): PaymentStatusHistory {
    return {
      id: row.id,
      paymentId: row.paymentId,
      fromStatus: row.fromStatus ?? undefined,
      toStatus: row.toStatus,
      changedBy: row.changedBy ?? undefined,
      reason: row.reason ?? undefined,
      metadata: row.metadata === null ? undefined : JSON.stringify(row.metadata),
      createdAt: row.createdAt,
    };
  }

  /**
   * getHistory — ดึงประวัติการเปลี่ยนสถานะของ payment 1 ใบ (เรียงเก่า → ใหม่)
   *
   * เรียงจากเก่าไปใหม่ (createdAt ASC) เพื่ออ่านเป็น "ไทม์ไลน์" จากบนลงล่าง
   *
   * @param paymentId - UUID ของ payment
   * @param user      - ผู้เรียก (จาก JWT) ใช้ตรวจสิทธิ์
   * @throws NotFoundException   ถ้าไม่พบ payment
   * @throws ForbiddenException  ถ้า user ไม่ใช่คู่กรณีและไม่ใช่ admin
   */
  async getHistory(
    paymentId: string,
    user: AuthUser,
  ): Promise<PaymentStatusHistory[]> {
    // โหลดเฉพาะ field ที่ใช้ตรวจสิทธิ์ (ไม่ต้องดึงทั้ง record)
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: { patientId: true, caregiverId: true },
    });

    if (!payment) {
      throw new NotFoundException(`ไม่พบ payment "${paymentId}"`);
    }

    // เห็นได้เฉพาะคู่กรณี (patient/caregiver) หรือ admin
    const isParty =
      payment.patientId === user.id || payment.caregiverId === user.id;
    const isAdmin = user.role === ADMIN_ROLE;

    if (!isParty && !isAdmin) {
      throw new ForbiddenException('คุณไม่มีสิทธิ์ดูประวัติการชำระเงินนี้');
    }

    const rows = await this.prisma.paymentStatusHistory.findMany({
      where: { paymentId },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((row) => this.mapToEntity(row as PrismaHistoryRow));
  }
}
