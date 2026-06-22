/**
 * CompleteBookingService — จบงาน booking + ตัดเงินจริง (PYG-281)
 *
 * flow ของ completeBooking:
 *  1) โหลด booking + payment + ตรวจสิทธิ์ (ต้องเป็น patient หรือ caregiver ของ booking)
 *  2) validate: booking ต้อง 'confirmed' และ payment ต้อง 'held'
 *  3) เรียก Omise capture เงินจากวงเงินที่กันไว้ (external I/O — อยู่นอก transaction)
 *  4) สำเร็จ → atomic transaction: payment held→captured (ผ่าน FSM + history) และ
 *     booking confirmed→completed + completed_at
 *  5) emit 'booking.completed' / 'payment.captured' + schedule review prompt (1 ชม.)
 *  6) ถ้า capture พัง → บันทึก history + failureCode/Message + แจ้ง admin แล้วโยน error
 *
 * ทำไม capture อยู่ "นอก" transaction?
 * - การยิง Omise เป็น network call ที่อาจช้า/พลาด การถือ DB transaction ค้างไว้รอ
 *   external call = ล็อกแถวนานเกินจำเป็น → เปิด transaction "หลัง" capture สำเร็จเท่านั้น
 */
import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { PaymentStatus } from './entities/payment-status.enum';
import { PaymentStateMachine } from './payment-state-machine';
import { OmiseService, OmiseCaptureResult } from './omise/omise.service';
import { CaptureFailedError } from './errors/capture-failed.error';
import { CompleteBookingResult } from './dto/complete-booking-result.type';

/** Decimal ของ Prisma มี .toNumber(); รองรับ number/string เผื่อ map มาแล้ว */
type DecimalLike = { toNumber(): number } | number | string;

@Injectable()
export class CompleteBookingService {
  private readonly logger = new Logger(CompleteBookingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fsm: PaymentStateMachine,
    private readonly omise: OmiseService,
  ) {}

  /**
   * completeBooking — patient หรือ caregiver กดจบงาน → capture เงิน + ปิด booking
   *
   * @param user      - ผู้ใช้ที่ login (จาก JWT) — ต้องเป็น patient/caregiver ของ booking
   * @param bookingId - id ของ booking ที่จะจบงาน
   * @throws NotFoundException             ไม่พบ booking
   * @throws ForbiddenException            ไม่ใช่ patient/caregiver ของ booking นี้
   * @throws UnprocessableEntityException  สถานะ booking/payment ไม่พร้อมจบงาน
   * @throws CaptureFailedError            Omise capture เงินไม่สำเร็จ
   */
  async completeBooking(
    user: AuthUser,
    bookingId: string,
  ): Promise<CompleteBookingResult> {
    // 1) โหลด booking + payment + caregiver.userId (ไว้เช็คสิทธิ์ฝั่ง caregiver)
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        patientId: true,
        status: true,
        caregiver: { select: { userId: true } },
        payment: {
          select: {
            id: true,
            paymentStatus: true,
            omiseChargeId: true,
            amount: true,
          },
        },
      },
    });

    if (!booking) throw new NotFoundException('Booking not found');

    // 2) auth: patient เจ้าของ หรือ caregiver ที่ถูก assign เท่านั้น
    const isPatient = booking.patientId === user.id;
    const isCaregiver = booking.caregiver?.userId === user.id;
    if (!isPatient && !isCaregiver) {
      throw new ForbiddenException('Access denied');
    }

    // 3) booking ต้องอยู่สถานะ confirmed (ยืนยัน + จ่ายเงินกันวงเงินแล้ว)
    if (booking.status !== 'confirmed') {
      throw new UnprocessableEntityException(
        'Only bookings with status "confirmed" can be completed',
      );
    }

    // 4) payment ต้องเป็น held (กันวงเงินไว้ รอ capture)
    const payment = booking.payment;
    if (!payment) {
      throw new UnprocessableEntityException(
        'ไม่พบรายการชำระเงินสำหรับ booking นี้',
      );
    }
    if ((payment.paymentStatus as PaymentStatus) !== PaymentStatus.held) {
      throw new UnprocessableEntityException(
        `Only payments with status "held" can be captured (current: "${payment.paymentStatus}")`,
      );
    }

    // 5) capture เงินกับ Omise (นอก transaction) — พังเมื่อไหร่ helper จัดการ audit + แจ้ง admin
    const captureResult = await this.capture(
      payment.id,
      payment.omiseChargeId ?? '',
      user,
    );

    // 6) capture สำเร็จ → atomic: payment captured + booking completed (transaction เดียว)
    const completedAt = new Date();
    const updatedBooking = await this.prisma.$transaction(async (tx) => {
      // 6a) payment held → captured (ผ่าน FSM: ตรวจกฎ + insert history ใน tx เดียวกัน)
      await this.fsm.transition(
        payment.id,
        PaymentStatus.captured,
        {
          changedBy: user.id,
          reason: 'งานเสร็จสมบูรณ์ — capture เงินจากวงเงินที่กันไว้',
          metadata: {
            omiseChargeId: captureResult.id,
            capturedAt: completedAt.toISOString(),
            completedBy: isPatient ? 'patient' : 'caregiver',
          },
        },
        tx,
      );

      // 6b) booking confirmed → completed + completed_at
      return tx.booking.update({
        where: { id: bookingId },
        data: { status: 'completed', completedAt },
        select: { id: true, status: true, completedAt: true },
      });
    });

    // 7) emit events — ตอนนี้ log ไว้ก่อน (ยังไม่มี EventEmitter2 ในโปรเจกต์)
    // TODO: PYG-292 — replace ด้วย EventEmitter2.emit('booking.completed' / 'payment.captured')
    this.logger.log(
      JSON.stringify({ event: 'booking.completed', bookingId, by: user.id }),
    );
    this.logger.log(
      JSON.stringify({
        event: 'payment.captured',
        paymentId: payment.id,
        bookingId,
        amount: this.toNumber(payment.amount),
      }),
    );

    // 8) นัดส่ง review prompt อีก 1 ชม. (listener จะมาใน PYG-292/297)
    this.scheduleReviewPrompt(bookingId);

    return {
      bookingId: updatedBooking.id,
      status: updatedBooking.status,
      paymentStatus: PaymentStatus.captured,
      amount: this.toNumber(payment.amount),
      omiseChargeId: captureResult.id,
      completedAt: updatedBooking.completedAt ?? completedAt,
    };
  }

  // ── private helpers ─────────────────────────────────────────────────────

  /**
   * capture — ห่อการเรียก Omise capture: ถ้าพังให้บันทึก audit + แจ้ง admin แล้วโยนต่อ
   * แยกออกมาเพื่อให้ completeBooking อ่านง่าย และ TS มั่นใจว่าได้ผลลัพธ์เมื่อผ่านบรรทัดนี้
   */
  private async capture(
    paymentId: string,
    omiseChargeId: string,
    user: AuthUser,
  ): Promise<OmiseCaptureResult> {
    try {
      return await this.omise.captureCharge(omiseChargeId);
    } catch (err) {
      await this.handleCaptureFailure(paymentId, user, err);
      throw err; // โยน CaptureFailedError ต่อให้ resolver แปลงเป็น error response
    }
  }

  /**
   * handleCaptureFailure — เมื่อ Omise capture ไม่สำเร็จ:
   *  1) บันทึก failureCode/Message ลง payment (FE เห็นสาเหตุ) + history (audit)
   *  2) แจ้ง admin ผ่าน structured log (PYG-292 จะต่อ in-app/email ภายหลัง)
   * ห้ามโยน error ซ้อนในนี้ — ไม่งั้นจะกลบ CaptureFailedError เดิม
   */
  private async handleCaptureFailure(
    paymentId: string,
    user: AuthUser,
    err: unknown,
  ): Promise<void> {
    const details = err instanceof CaptureFailedError ? err.details : {};
    const message = err instanceof Error ? err.message : String(err);

    // 1) persist สาเหตุ + เขียน history (payment ยังคงเป็น held — capture แค่ไม่สำเร็จ)
    try {
      await this.prisma.payment.update({
        where: { id: paymentId },
        data: {
          failureCode: details.omiseCode ?? 'CAPTURE_FAILED',
          failureMessage: details.omiseMessage ?? message,
        },
      });
      await this.fsm.recordCaptureFailure(paymentId, PaymentStatus.held, {
        changedBy: user.id,
        reason: 'Omise capture failed',
        metadata: { ...details, error: message },
      });
    } catch (persistErr) {
      this.logger.error(
        `บันทึก capture failure ลง DB ไม่สำเร็จ (paymentId=${paymentId}): ${String(persistErr)}`,
      );
    }

    // 2) แจ้ง admin — alert log (มี monitoring คอยจับ); งานเสร็จแต่ตัดเงินไม่ได้ = ต้องมีคนเข้ามาดู
    // TODO: PYG-292 — ส่ง in-app notification / email หา admin เมื่อมี payment notification types
    this.logger.error(
      JSON.stringify({
        alert: 'payment.capture_failed',
        paymentId,
        triggeredBy: user.id,
        ...details,
        message,
      }),
    );
  }

  /**
   * scheduleReviewPrompt — นัดส่ง "ขอให้รีวิว" หลังจบงาน 1 ชั่วโมง
   * ตอนนี้ระบบ review (PYG-297) + event listener (PYG-292) ยังไม่พร้อม จึง log เจตนาไว้ก่อน
   */
  private scheduleReviewPrompt(bookingId: string): void {
    // TODO: PYG-292/297 — ลงทะเบียน delayed job (SchedulerRegistry) ที่ emit 'review.prompt'
    const runAt = new Date(Date.now() + 60 * 60 * 1000); // +1 ชั่วโมง
    this.logger.log(
      JSON.stringify({
        event: 'review.prompt.scheduled',
        bookingId,
        runAt: runAt.toISOString(),
      }),
    );
  }

  /** รองรับทั้ง Prisma Decimal (.toNumber()), number, และ string */
  private toNumber(v: DecimalLike): number {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return Number(v);
    return v.toNumber();
  }
}
