import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { CreateReviewInput } from './dto/create-review.input';
import { CaregiverReviewsInput } from './dto/caregiver-reviews.input';
import { CaregiverReviewsResponse } from './dto/caregiver-reviews.response';
import { ReviewItem } from './entities/review-item.entity';

/**
 * รูปทรง row ที่ทุก query ในไฟล์นี้ select ออกมาเหมือนกัน
 * (id + ฟิลด์รีวิว + ชื่อ display ของ patient เพื่อเอาไปทำ reviewerName)
 */
type ReviewRow = {
  id: string;
  rating: number;
  comment: string | null;
  isAnonymous: boolean;
  isVisible: boolean;
  createdAt: Date;
  patient: { displayName: string | null } | null;
};

/** field set มาตรฐานที่ใช้ select รีวิว (กันลืม include patient.displayName) */
const REVIEW_SELECT = {
  id: true,
  rating: true,
  comment: true,
  isAnonymous: true,
  isVisible: true,
  createdAt: true,
  patient: { select: { displayName: true } },
} as const;

@Injectable()
export class ReviewService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── 1) createReview ────────────────────────────────────────────────────────
  /**
   * patient เขียนรีวิวให้ caregiver หลังงานเสร็จ
   *
   * กติกา (ตาม PYG-297):
   *  - booking ต้องมีจริง และเป็นของ patient คนนี้           → 404 / 403
   *  - booking.status ต้องเป็น 'completed'                   → 422
   *  - 1 รีวิว / 1 booking (ห้ามรีวิวซ้ำ)                     → 409
   *  - rating 1–5, comment ≤ 500 (ตรวจที่ DTO แล้ว) + strip HTML ก่อนเก็บ
   *
   * @param patientId users.id ของผู้รีวิว (มาจาก @CurrentUser ไม่ใช่จาก client → ปลอมไม่ได้)
   */
  async createReview(
    patientId: string,
    input: CreateReviewInput,
  ): Promise<ReviewItem> {
    // ดึง booking + เช็คว่ามีรีวิวอยู่แล้วหรือยัง (review เป็น relation 1:1 บน Booking)
    const booking = await this.prisma.booking.findUnique({
      where: { id: input.bookingId },
      select: {
        id: true,
        patientId: true,
        caregiverId: true,
        status: true,
        review: { select: { id: true } },
      },
    });

    if (!booking) {
      throw new NotFoundException('ไม่พบ booking นี้');
    }
    // ownership: รีวิวได้เฉพาะเจ้าของ booking เท่านั้น
    if (booking.patientId !== patientId) {
      throw new ForbiddenException('คุณไม่ใช่เจ้าของ booking นี้');
    }
    // ต้องเป็นงานที่เสร็จแล้วเท่านั้นถึงรีวิวได้
    if (booking.status !== 'completed') {
      throw new UnprocessableEntityException(
        'รีวิวได้เฉพาะงานที่เสร็จสมบูรณ์ (completed) แล้วเท่านั้น',
      );
    }
    // ป้องกันเคสไม่มี caregiver ผูกกับ booking (เช่นงานที่ไม่เคย match)
    if (!booking.caregiverId) {
      throw new UnprocessableEntityException(
        'booking นี้ยังไม่มีผู้ดูแลที่จะรีวิว',
      );
    }
    // 1 รีวิว/1 booking — เช็คในโค้ดเพื่อ error สวยๆ (และมี unique index กันชั้นที่ DB อีกชั้น)
    if (booking.review) {
      throw new ConflictException('คุณได้รีวิว booking นี้ไปแล้ว');
    }

    // ตัด HTML tag ออกจาก comment กัน XSS/markup หลุดไปแสดงผล แล้วค่อยเก็บ
    const cleanComment = this.stripHtml(input.comment);

    const created = await this.prisma.review.create({
      data: {
        bookingId: booking.id,
        patientId,
        caregiverId: booking.caregiverId,
        rating: input.rating,
        comment: cleanComment,
        isAnonymous: input.isAnonymous ?? false,
        // isVisible ใช้ default true จาก schema
      },
      select: REVIEW_SELECT,
    });

    return this.toReviewItem(created);
  }

  // ─── 2) caregiverReviews ────────────────────────────────────────────────────
  /**
   * รายการรีวิว "ที่มองเห็นได้" ของ caregiver 1 คน เรียงใหม่สุดก่อน + แบ่งหน้า
   * (public — ใช้บนหน้าโปรไฟล์ caregiver ที่เปิดดูได้โดยไม่ต้อง login)
   */
  async caregiverReviews(
    input: CaregiverReviewsInput,
  ): Promise<CaregiverReviewsResponse> {
    const page = Math.max(1, input.page ?? 1);
    const limit = Math.min(50, Math.max(1, input.limit ?? 10));
    const skip = (page - 1) * limit;

    // เห็นเฉพาะรีวิวที่ยังไม่ถูก admin ซ่อน (isVisible = true)
    const where = { caregiverId: input.caregiverId, isVisible: true };

    // ดึงข้อมูลหน้าปัจจุบัน + นับ total พร้อมกัน (เร็วกว่าทำทีละอัน)
    const [rows, total] = await Promise.all([
      this.prisma.review.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: REVIEW_SELECT,
      }),
      this.prisma.review.count({ where }),
    ]);

    const totalPages = total === 0 ? 1 : Math.ceil(total / limit);

    return {
      data: rows.map((row) => this.toReviewItem(row)),
      pagination: { page, limit, total, totalPages },
    };
  }

  // ─── 3) hideReview (admin) ──────────────────────────────────────────────────
  /**
   * admin ซ่อนรีวิว (soft hide) — set is_visible=false
   * รีวิวที่ถูกซ่อนจะไม่โผล่ใน caregiverReviews และไม่ถูกนับใน avg_rating/review_count
   * (search.service + caregiver-public กรอง is_visible=true ไว้แล้ว)
   */
  async hideReview(reviewId: string): Promise<ReviewItem> {
    // เช็คก่อนว่ามีรีวิวนี้จริง เพื่อตอบ 404 ที่ชัดเจน (แทน error P2025 ของ Prisma)
    const existing = await this.prisma.review.findUnique({
      where: { id: reviewId },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException('ไม่พบรีวิวนี้');
    }

    const updated = await this.prisma.review.update({
      where: { id: reviewId },
      data: { isVisible: false },
      select: REVIEW_SELECT,
    });

    return this.toReviewItem(updated);
  }

  // ─── helpers ────────────────────────────────────────────────────────────────

  /**
   * stripHtml — ลบ HTML tag ทั้งหมดออกจากข้อความ แล้ว trim
   * คืน null ถ้า input ว่าง/undefined หรือว่างหลังตัด tag (เก็บเป็น null สะอาดกว่าเก็บ '')
   */
  private stripHtml(text?: string | null): string | null {
    if (!text) return null;
    const cleaned = text.replace(/<[^>]*>/g, '').trim();
    return cleaned.length > 0 ? cleaned : null;
  }

  /**
   * resolveReviewerName — แปลงเป็นชื่อที่โชว์บนรีวิว
   *  - isAnonymous = true  → "ผู้ใช้ไม่ระบุชื่อ"
   *  - ไม่งั้น              → ชื่อต้น (token แรกของ displayName) เพื่อความเป็นส่วนตัว
   *  - ไม่มี displayName    → "ผู้ใช้"
   */
  private resolveReviewerName(
    displayName: string | null | undefined,
    isAnonymous: boolean,
  ): string {
    if (isAnonymous) return 'ผู้ใช้ไม่ระบุชื่อ';
    const firstName = (displayName ?? '').trim().split(/\s+/)[0];
    return firstName.length > 0 ? firstName : 'ผู้ใช้';
  }

  /** map row จาก Prisma → ReviewItem ที่ส่งออก GraphQL */
  private toReviewItem(row: ReviewRow): ReviewItem {
    return {
      id: row.id,
      rating: row.rating,
      comment: row.comment ?? undefined,
      reviewerName: this.resolveReviewerName(
        row.patient?.displayName,
        row.isAnonymous,
      ),
      isAnonymous: row.isAnonymous,
      isVisible: row.isVisible,
      createdAt: row.createdAt,
    };
  }
}
