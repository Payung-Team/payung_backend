import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { ClockService } from '../common/clock.service';
import { SetTaskDoneInput } from './dto/set-task-done.input';
import { BookingTask } from './dto/booking-task.types';
import { BOOKING_STATUS } from '../monitoring/monitoring.constants';

type BookingTaskRow = {
  id: string;
  description: string;
  time_note: string | null;
  sort_order: number;
  done_at: Date | null;
  done_by: string | null;
};

/**
 * BookingTaskService — รายการงานย่อยของ booking (PYG-361)
 *
 * ★ SCOPE BOUNDARY: ไฟล์นี้ต้องไม่ยุ่งกับ proofOfWork.verdict / review_reasons / การปล่อยเงินเลย
 *   แม้แต่นิดเดียว — ข้อมูลตรงนี้เป็น display-only สำหรับความสบายใจของผู้รับบริการเท่านั้น
 *   ผู้ดูแลทำงานครบถ้วนแต่ลืมติ๊กก็ต้องได้รับเงินตามปกติ ห้ามมีเงื่อนไขไหนอ่านค่าจากตารางนี้
 *   ไปเข้าสมการตัดสินใจของ MonitoringService เด็ดขาด
 */
@Injectable()
export class BookingTaskService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  /**
   * อ่านอย่างเดียว — ใช้โดย @ResolveField bookingTasks บน BookingSummary/CaregiverBookingSummary
   * ไม่เช็คสิทธิ์ซ้ำที่นี่: parent query (myBooking/caregiverBooking) เช็คความเป็นเจ้าของ booking
   * ไปแล้วก่อนที่ field resolver นี้จะถูกเรียก
   */
  async listForBooking(bookingId: string): Promise<BookingTask[]> {
    const rows = await this.prisma.booking_tasks.findMany({
      where: { booking_id: bookingId },
      orderBy: { sort_order: 'asc' },
    });
    return rows.map((r) => this.toEntity(r));
  }

  /**
   * caregiver ติ๊ก/ยกเลิกติ๊กว่าทำรายการงานย่อยนี้แล้ว
   * @param userId  users.id จาก JWT (ปลอม caregiverId ผ่าน input ไม่ได้)
   */
  async setTaskDone(userId: string, input: SetTaskDoneInput): Promise<BookingTask> {
    const caregiver = await this.prisma.caregiver.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!caregiver) {
      throw new ForbiddenException('ไม่พบโปรไฟล์ผู้ดูแลของบัญชีนี้');
    }

    const task = await this.prisma.booking_tasks.findUnique({
      where: { id: input.taskId },
      include: { bookings: { select: { caregiverId: true, status: true } } },
    });

    // ─── ด่านที่ 1: มีรายการงานนี้จริงไหม ─────────────────────────────
    if (!task) {
      throw new NotFoundException('ไม่พบรายการงานนี้');
    }

    // ─── ด่านที่ 2: เป็นงานของ caregiver คนนี้ไหม ─────────────────────
    if (task.bookings.caregiverId !== caregiver.id) {
      throw new ForbiddenException('งานนี้ไม่ใช่ของคุณ');
    }

    // ─── ด่านที่ 3: สถานะงาน ──────────────────────────────────────────
    // เงื่อนไขเดียวครอบคลุมทั้ง "ยังไม่เช็คอิน" และ "เช็คเอาท์ไปแล้ว" — ตั้งใจไม่แยกข้อความ
    if (task.bookings.status !== BOOKING_STATUS.IN_PROGRESS) {
      throw new BadRequestException('ต้องเช็คอินก่อนจึงจะบันทึกความคืบหน้าได้');
    }

    // ─── idempotent จริง ๆ: ค่าที่ขอมาตรงกับสถานะปัจจุบันอยู่แล้ว → คืนแถวเดิม ไม่เขียนซ้ำ ───
    const alreadyInDesiredState = input.done ? task.done_at !== null : task.done_at === null;
    if (alreadyInDesiredState) {
      return this.toEntity(task);
    }

    const updated = await this.prisma.booking_tasks.update({
      where: { id: input.taskId },
      data: input.done
        ? { done_at: this.clock.now(), done_by: caregiver.id }
        : { done_at: null, done_by: null },
    });

    return this.toEntity(updated);
  }

  private toEntity(row: BookingTaskRow): BookingTask {
    return {
      id: row.id,
      description: row.description,
      timeNote: row.time_note ?? undefined,
      sortOrder: row.sort_order,
      doneAt: row.done_at ?? undefined,
      doneBy: row.done_by ?? undefined,
    };
  }
}
