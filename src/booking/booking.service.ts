import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import {
  BookingListResponse,
  BookingPagination,
  BookingSummary,
  CaregiverBriefDto,
} from './dto/booking-summary.types';
import { BookingHistoryInput } from './dto/booking-history.input';

type BookingWithIncludes = {
  id: string;
  patientId: string;
  status: string;
  serviceType: string;
  timeSlot: string;
  locationAddress: string;
  bookingDate: Date;
  estimatedCost: { toNumber(): number } | null;
  confirmedAt: Date | null;
  createdAt: Date;
  caregiver: {
    id: string;
    fullName: string | null;
    hourlyRate: number | null;
    user: { avatarUrl: string | null };
  };
  careRecipient: { name: string } | null;
};

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(private readonly prisma: PrismaService) {}

  async confirmBooking(bookingId: string, userId: string): Promise<BookingSummary> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        caregiver: { include: { user: { select: { avatarUrl: true } } } },
        careRecipient: { select: { name: true } },
      },
    });

    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.patientId !== userId) throw new ForbiddenException('Access denied');
    if (booking.status !== 'accepted') {
      throw new UnprocessableEntityException(
        'Only bookings with status "accepted" can be confirmed',
      );
    }

    const updated = await this.prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'confirmed', confirmedAt: new Date() },
      include: {
        caregiver: { include: { user: { select: { avatarUrl: true } } } },
        careRecipient: { select: { name: true } },
      },
    });

    this.logger.log({ event: 'booking.confirmed', bookingId, userId });
    return this.toSummary(updated as unknown as BookingWithIncludes);
  }

  async myPendingConfirmations(
    userId: string,
    page = 1,
    limit = 10,
  ): Promise<BookingListResponse> {
    page  = Math.max(1, page);
    limit = Math.min(50, Math.max(1, limit));
    const offset = (page - 1) * limit;

    const where = { patientId: userId, status: 'accepted' };
    const [items, total] = await Promise.all([
      this.prisma.booking.findMany({
        where,
        include: {
          caregiver: { include: { user: { select: { avatarUrl: true } } } },
          careRecipient: { select: { name: true } },
        },
        orderBy: { bookingDate: 'asc' },
        skip: offset,
        take: limit,
      }),
      this.prisma.booking.count({ where }),
    ]);

    return this.toListResponse(items as unknown as BookingWithIncludes[], { page, limit, total });
  }

  async myBookingHistory(
    userId: string,
    input: BookingHistoryInput,
  ): Promise<BookingListResponse> {
    const page  = Math.max(1, input.page  ?? 1);
    const limit = Math.min(50, Math.max(1, input.limit ?? 10));
    const offset = (page - 1) * limit;

    const where: Record<string, unknown> = { patientId: userId };
    if (input.status) where.status = input.status;

    const [items, total] = await Promise.all([
      this.prisma.booking.findMany({
        where,
        include: {
          caregiver: { include: { user: { select: { avatarUrl: true } } } },
          careRecipient: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      this.prisma.booking.count({ where }),
    ]);

    return this.toListResponse(items as unknown as BookingWithIncludes[], { page, limit, total });
  }

  private toSummary(booking: BookingWithIncludes): BookingSummary {
    const caregiver: CaregiverBriefDto = {
      id:         booking.caregiver.id,
      fullName:   booking.caregiver.fullName   ?? undefined,
      avatarUrl:  booking.caregiver.user.avatarUrl ?? undefined,
      hourlyRate: booking.caregiver.hourlyRate ?? undefined,
    };

    return {
      id:               booking.id,
      bookingDate:      booking.bookingDate instanceof Date
                          ? booking.bookingDate.toISOString().slice(0, 10)
                          : String(booking.bookingDate),
      status:           booking.status,
      serviceType:      booking.serviceType,
      timeSlot:         booking.timeSlot,
      locationAddress:  booking.locationAddress,
      estimatedCost:    booking.estimatedCost != null
                          ? booking.estimatedCost.toNumber()
                          : undefined,
      caregiver,
      careRecipientName: booking.careRecipient?.name ?? undefined,
      confirmedAt:      booking.confirmedAt   ?? undefined,
      createdAt:        booking.createdAt,
    };
  }

  private toListResponse(
    items: BookingWithIncludes[],
    { page, limit, total }: { page: number; limit: number; total: number },
  ): BookingListResponse {
    const pagination: BookingPagination = {
      page,
      limit,
      total,
      totalPages: total === 0 ? 1 : Math.ceil(total / limit),
    };
    return { data: items.map((b) => this.toSummary(b)), pagination };
  }
}
