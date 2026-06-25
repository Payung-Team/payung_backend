/**
 * Unit tests สำหรับ ReviewService (PYG-297)
 *
 * ครอบคลุม:
 * - createReview: happy path + strip HTML + anonymous + guards (404/403/422/409)
 * - caregiverReviews: กรอง is_visible=true, เรียงใหม่สุดก่อน, คำนวณ pagination
 * - hideReview: set is_visible=false + 404 เมื่อไม่พบ
 *
 * mock PrismaService ทั้งหมด → ไม่แตะ DB จริง
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ReviewService } from './review.service';
import { PrismaService } from '../common/prisma.service';

const BOOKING_ID = 'book-0001';
const PATIENT_ID = 'patient-0001';
const CAREGIVER_ID = 'cg-0001';
const REVIEW_ID = 'rev-0001';

/** booking รูปทรงที่ createReview select มา */
function fakeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    patientId: PATIENT_ID,
    caregiverId: CAREGIVER_ID,
    status: 'completed',
    review: null, // ยังไม่มีรีวิว
    ...overrides,
  };
}

/** review row รูปทรงที่ REVIEW_SELECT คืนกลับ */
function fakeReviewRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REVIEW_ID,
    rating: 5,
    comment: 'ดูแลดีมาก',
    isAnonymous: false,
    isVisible: true,
    createdAt: new Date('2026-06-26T10:00:00Z'),
    patient: { displayName: 'สมหญิง ใจงาม' },
    ...overrides,
  };
}

describe('ReviewService', () => {
  let service: ReviewService;
  let prisma: {
    booking: { findUnique: jest.Mock };
    review: {
      create: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      booking: { findUnique: jest.fn() },
      review: {
        create: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = moduleRef.get(ReviewService);
  });

  // ─── createReview ───────────────────────────────────────────────────────────

  describe('createReview', () => {
    it('สร้างรีวิวสำเร็จ + คืน reviewerName เป็นชื่อต้นของ patient', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking());
      prisma.review.create.mockResolvedValue(fakeReviewRow());

      const result = await service.createReview(PATIENT_ID, {
        bookingId: BOOKING_ID,
        rating: 5,
        comment: 'ดูแลดีมาก',
      });

      // เขียนด้วย caregiverId ที่ดึงจาก booking (ไม่ได้รับจาก client)
      expect(prisma.review.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            bookingId: BOOKING_ID,
            patientId: PATIENT_ID,
            caregiverId: CAREGIVER_ID,
            rating: 5,
            comment: 'ดูแลดีมาก',
            isAnonymous: false,
          }),
        }),
      );
      expect(result.reviewerName).toBe('สมหญิง'); // ชื่อต้นเท่านั้น
      expect(result.rating).toBe(5);
    });

    it('ตัด HTML tag ออกจาก comment ก่อนเก็บ', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking());
      prisma.review.create.mockResolvedValue(fakeReviewRow());

      await service.createReview(PATIENT_ID, {
        bookingId: BOOKING_ID,
        rating: 4,
        comment: '<script>alert(1)</script>ดีมาก<b>!</b>',
      });

      expect(prisma.review.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ comment: 'alert(1)ดีมาก!' }),
        }),
      );
    });

    it('comment ที่มีแต่ tag → เก็บเป็น null', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking());
      prisma.review.create.mockResolvedValue(fakeReviewRow({ comment: null }));

      await service.createReview(PATIENT_ID, {
        bookingId: BOOKING_ID,
        rating: 4,
        comment: '<br><br>',
      });

      expect(prisma.review.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ comment: null }),
        }),
      );
    });

    it('isAnonymous=true → reviewerName เป็นชื่อนิรนาม', async () => {
      prisma.booking.findUnique.mockResolvedValue(fakeBooking());
      prisma.review.create.mockResolvedValue(
        fakeReviewRow({ isAnonymous: true }),
      );

      const result = await service.createReview(PATIENT_ID, {
        bookingId: BOOKING_ID,
        rating: 5,
        isAnonymous: true,
      });

      expect(result.reviewerName).toBe('ผู้ใช้ไม่ระบุชื่อ');
    });

    it('โยน NotFound เมื่อไม่พบ booking', async () => {
      prisma.booking.findUnique.mockResolvedValue(null);

      await expect(
        service.createReview(PATIENT_ID, { bookingId: BOOKING_ID, rating: 5 }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.review.create).not.toHaveBeenCalled();
    });

    it('โยน Forbidden เมื่อ patient ไม่ใช่เจ้าของ booking', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        fakeBooking({ patientId: 'someone-else' }),
      );

      await expect(
        service.createReview(PATIENT_ID, { bookingId: BOOKING_ID, rating: 5 }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.review.create).not.toHaveBeenCalled();
    });

    it('โยน UnprocessableEntity เมื่อ booking ยังไม่ completed', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        fakeBooking({ status: 'confirmed' }),
      );

      await expect(
        service.createReview(PATIENT_ID, { bookingId: BOOKING_ID, rating: 5 }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.review.create).not.toHaveBeenCalled();
    });

    it('โยน Conflict เมื่อ booking นี้มีรีวิวแล้ว', async () => {
      prisma.booking.findUnique.mockResolvedValue(
        fakeBooking({ review: { id: REVIEW_ID } }),
      );

      await expect(
        service.createReview(PATIENT_ID, { bookingId: BOOKING_ID, rating: 5 }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.review.create).not.toHaveBeenCalled();
    });
  });

  // ─── caregiverReviews ───────────────────────────────────────────────────────

  describe('caregiverReviews', () => {
    it('query เฉพาะรีวิว is_visible=true เรียง createdAt desc + แบ่งหน้า', async () => {
      prisma.review.findMany.mockResolvedValue([fakeReviewRow()]);
      prisma.review.count.mockResolvedValue(1);

      const result = await service.caregiverReviews({
        caregiverId: CAREGIVER_ID,
        page: 1,
        limit: 10,
      });

      expect(prisma.review.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { caregiverId: CAREGIVER_ID, isVisible: true },
          orderBy: { createdAt: 'desc' },
          skip: 0,
          take: 10,
        }),
      );
      expect(result.data).toHaveLength(1);
      expect(result.pagination).toMatchObject({
        page: 1,
        limit: 10,
        total: 1,
        totalPages: 1,
      });
    });

    it('คำนวณ skip/totalPages ของหน้า 2 ถูกต้อง', async () => {
      prisma.review.findMany.mockResolvedValue([]);
      prisma.review.count.mockResolvedValue(13);

      const result = await service.caregiverReviews({
        caregiverId: CAREGIVER_ID,
        page: 2,
        limit: 5,
      });

      expect(prisma.review.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 5, take: 5 }),
      );
      expect(result.pagination.totalPages).toBe(3); // ceil(13/5)
    });

    it('ไม่มีรีวิว → total=0, totalPages=1', async () => {
      prisma.review.findMany.mockResolvedValue([]);
      prisma.review.count.mockResolvedValue(0);

      const result = await service.caregiverReviews({ caregiverId: CAREGIVER_ID });

      expect(result.data).toEqual([]);
      expect(result.pagination).toMatchObject({ total: 0, totalPages: 1 });
    });
  });

  // ─── hideReview ─────────────────────────────────────────────────────────────

  describe('hideReview', () => {
    it('set is_visible=false และคืนรีวิวที่อัปเดตแล้ว', async () => {
      prisma.review.findUnique.mockResolvedValue({ id: REVIEW_ID });
      prisma.review.update.mockResolvedValue(
        fakeReviewRow({ isVisible: false }),
      );

      const result = await service.hideReview(REVIEW_ID);

      expect(prisma.review.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: REVIEW_ID },
          data: { isVisible: false },
        }),
      );
      expect(result.isVisible).toBe(false);
    });

    it('โยน NotFound เมื่อไม่พบรีวิว', async () => {
      prisma.review.findUnique.mockResolvedValue(null);

      await expect(service.hideReview(REVIEW_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.review.update).not.toHaveBeenCalled();
    });
  });
});
