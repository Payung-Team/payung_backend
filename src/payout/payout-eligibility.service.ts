/**
 * PayoutEligibilityService — ประตูเดียวที่ตอบว่า "ปล่อยเงินให้ผู้ดูแลได้ไหม"
 *
 * capture = เงินเข้าระบบ, payout = เงินออกจากระบบ — คนละประตูกัน ต้องมียามทั้งสองบาน
 * ถ้าวันหนึ่ง capture หลุดมาได้ (แอดมิน override ผิด หรือบั๊ก) ยามบานที่สองยังกันเงิน
 * ไม่ให้ไหลออกไปหาคนที่ไม่ได้ทำงาน
 *
 * ทำไมต้องแยกเป็น service?
 * - กฎเดียวกันถูกถามจาก 3 จุดคนละเวลา:
 *     1) PayoutService.createFromCompletedBooking — ตอนสร้าง payout
 *     2) PayoutWorkerService.processOne          — ตอนกำลังจะโอนจริง (re-check)
 *     3) PayoutReaperService.run                 — ตอนกวาดของค้าง
 *   ถ้าเขียนกฎซ้ำ 3 ที่ วันหนึ่งจะแก้ไม่ครบ → เงินไหลผิด
 *
 * ★ เราไม่คำนวณ verdict เอง — เรียก MonitoringService.proofOfWorkForSystem()
 *   กฎการตัดสิน (valid/needs_review/incomplete) อยู่ที่ MonitoringService ที่เดียว
 *   ตาม comment ในไฟล์นั้น: "ถ้าใครเผลอเอาสูตรกลับมาใส่ ระบบจะมีกฎสองชุด
 *   แล้ววันหนึ่งสองชุดนั้นจะให้คำตอบไม่ตรงกัน — ซึ่งแปลว่าเงินไหลผิด"
 *
 * ⚠️ ทำไมต้องมี 'hold' แยกจาก 'deny'?
 *   verdict = needs_review / incomplete แปลว่า "ยังไม่รู้" ไม่ใช่ "ไม่จ่ายแน่นอน"
 *   ห้าม cancel payout ทิ้ง เพราะ cancelled เป็น terminal state + payouts.booking_id
 *   เป็น UNIQUE → cancel ผิดครั้งเดียว = สร้าง payout ใหม่ให้ booking นั้นไม่ได้อีกเลย
 *   เงินของผู้ดูแลหายถาวรแม้แอดมินจะตัดสินว่าเขาถูก
 *   hold = ปล่อยค้างที่ scheduled เฉย ๆ พอสถานการณ์คลี่คลายรอบหน้าจะไหลต่อเอง
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { MonitoringService } from '../monitoring/monitoring.service';
import { VERDICT } from '../monitoring/monitoring.constants';
import type { ProofOfWorkSummary } from '../monitoring/entities/proof-of-work.entity';

export type PayoutEligibility = {
  /**
   * eligible — จ่ายได้
   * hold     — ยังไม่จ่าย แต่ห้ามยกเลิก (สถานการณ์อาจกลับมา eligible ได้)
   * deny     — ไม่จ่ายถาวร ยกเลิกได้เลย
   */
  kind: 'eligible' | 'hold' | 'deny';
  /** เหตุผลแบบ machine-readable — ลง log + payout_status_history.reason */
  reason: string;
  /** หลักฐานที่ใช้ตัดสิน — ลง payout_status_history.metadata (ตอบ "ทำไมถึงจ่าย") */
  evidence: Record<string, unknown>;
};

/** สถานะเงินฝั่ง payment ที่กฎต้องใช้ (แยกจาก proof เพราะคนละตาราง) */
export type MoneyState = {
  refundedAmount: Prisma.Decimal | number | string | null;
} | null;

@Injectable()
export class PayoutEligibilityService {
  private readonly logger = new Logger(PayoutEligibilityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly monitoring: MonitoringService,
  ) {}

  /**
   * check — โหลดหลักฐาน + สถานะเงิน แล้วตัดสิน
   *
   * ไม่ throw เด็ดขาด — caller ทุกตัวอยู่บน path ที่ห้าม throw
   * (listener swallow error, worker/reaper อยู่ใน @Cron)
   * proofOfWorkForSystem โยน NotFoundException ได้ → แปลงเป็น deny
   */
  async check(bookingId: string): Promise<PayoutEligibility> {
    let proof: ProofOfWorkSummary;
    try {
      proof = await this.monitoring.proofOfWorkForSystem(bookingId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[PayoutEligibility] อ่านหลักฐานไม่สำเร็จ booking=${bookingId}: ${msg}`,
      );
      // อ่านหลักฐานไม่ได้ = ยืนยันไม่ได้ว่ามีคนทำงานจริง → ห้ามจ่าย
      // แต่เป็น 'hold' ไม่ใช่ 'deny': DB ล่มชั่วคราวไม่ควรทำให้ payout ถูกยกเลิกถาวร
      return {
        kind: 'hold',
        reason: 'proof_unavailable',
        evidence: { bookingId, error: msg },
      };
    }

    const payment = await this.prisma.payment.findUnique({
      where: { bookingId },
      select: { refundedAmount: true },
    });

    return this.evaluate(proof, payment);
  }

  /**
   * evaluate — กฎล้วน ๆ ไม่แตะ DB (เทสต์ง่าย + caller ที่โหลดเองแล้วเรียกตรงได้)
   *
   * ลำดับสำคัญ: เช็ค refund ก่อน verdict เสมอ (ดูเหตุผลในบล็อกที่ 1)
   */
  evaluate(proof: ProofOfWorkSummary, payment: MoneyState): PayoutEligibility {
    const refundedAmount = this.toNumber(payment?.refundedAmount);

    const evidence: Record<string, unknown> = {
      // ★ หลักฐานตัวจริงที่ผูก payout เข้ากับการทำงาน — ตอบข้อร้องเรียนได้ว่า
      //   "เราจ่ายเพราะมีเช็คอินใบนี้ เช็คเอาท์ใบนี้"
      checkInId: proof.checkIn?.id ?? null,
      checkOutId: proof.checkOut?.id ?? null,
      verdict: proof.verdict,
      reviewReasons: proof.reviewReasons,
      noCheckout: proof.noCheckout,
      disputed: proof.disputed,
      refundedAmount,
    };

    // ── 1. คืนเงินลูกค้าไปแล้ว → deny ถาวร ────────────────────────────────
    // ★ ต้องมาก่อน verdict: refund เกิดนอกเส้นทาง dispute ก็ได้ (RefundService
    //   มีหลาย source) — เคสนั้น dispute_status ยังเป็น 'none' และ verdict อาจ
    //   เป็น 'valid' ด้วยซ้ำ ถ้าเช็ค verdict ก่อนจะจ่ายเงินที่คืนลูกค้าไปแล้ว
    // refund ย้อนกลับไม่ได้ → deny ปลอดภัย (ไม่ใช่ hold ที่รอเก้อ)
    if (refundedAmount > 0) {
      return { kind: 'deny', reason: 'payment_refunded', evidence };
    }

    // ── 2. verdict — กฎกลางจาก MonitoringService ─────────────────────────
    if (proof.verdict === VERDICT.VALID) {
      return { kind: 'eligible', reason: 'proof_valid', evidence };
    }

    // TODO(PYG-336/337): เมื่อมี admin override จริง ให้เช็คตรงนี้ —
    //   verdict != valid + มี override ที่บันทึกไว้ → eligible (พร้อมแนบ id ของ
    //   override ลง evidence) ตอนนี้ทั้งระบบยังไม่มีกลไก override ที่ไหนเลย
    //   ห้ามสร้างกลไกใหม่ในการ์ดนี้ — จะกลายเป็นกลไกที่สองที่ไม่มีใครรู้ว่ามี

    // incomplete = ยังปิดงานไม่ครบ — ผู้ดูแลอาจกำลังจะเช็คเอาท์
    // หรือ cron PYG-359 จะมาปิดให้ → hold ไว้ก่อน
    if (proof.verdict === VERDICT.INCOMPLETE) {
      return {
        kind: 'hold',
        // แยกเหตุผล no_checkout ออกมาให้ชัด — เป็นเคสที่พบบ่อยที่สุด
        reason: proof.noCheckout ? 'proof_no_checkout' : 'proof_incomplete',
        evidence,
      };
    }

    // needs_review = ติดธง หรือระบบปิดงานให้ หรือมีข้อพิพาท
    // → รอแอดมิน ห้าม cancel (แอดมินอาจตัดสินว่าผู้ดูแลถูก)
    return { kind: 'hold', reason: 'proof_needs_review', evidence };
  }

  /** Prisma.Decimal | number | string | null → number (0 ถ้าไม่มีค่า) */
  private toNumber(
    v: Prisma.Decimal | number | string | null | undefined,
  ): number {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return Number(v) || 0;
    return v.toNumber();
  }
}
