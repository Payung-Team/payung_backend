import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { AdminBookingConnection, AdminBookingDetail, AdminBookingsInput } from './dto/admin-bookings.dto';

const fullName = (u?: { firstName: string | null; lastName: string | null; displayName: string | null; email: string | null } | null) => {
  if (!u) return null;
  const n = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return n || u.displayName || u.email || null;
};

/** แอดมินดูรายการ booking ทั้งระบบ — ติดตามสถานะ / ผู้จอง / ผู้ดูแล (ใหม่ → เก่า) */
@Injectable()
export class AdminBookingsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(input: AdminBookingsInput): Promise<AdminBookingConnection> {
    const page = Math.max(1, input.page ?? 1);
    const limit = Math.min(100, Math.max(1, input.limit ?? 20));
    const offset = (page - 1) * limit;
    const q = input.search?.trim();

    const and: Prisma.BookingWhereInput[] = [];
    if (input.status) and.push({ status: input.status });
    if (q) {
      const c = { contains: q, mode: 'insensitive' as const };
      const or: Prisma.BookingWhereInput[] = [
        { patientName: c },
        { patient: { OR: [{ firstName: c }, { lastName: c }, { displayName: c }, { email: c }] } },
        { caregiver: { OR: [{ fullName: c }, { caregiverNumber: c }] } },
      ];
      // id เป็น uuid — contains ใช้ไม่ได้ จึงเทียบตรงเมื่อรูปแบบถูก
      if (/^[0-9a-f-]{36}$/i.test(q)) or.push({ id: q });
      and.push({ OR: or });
    }
    const where: Prisma.BookingWhereInput = and.length ? { AND: and } : {};

    const userSelect = { firstName: true, lastName: true, displayName: true, email: true, phone: true };
    const [rows, totalCount] = await Promise.all([
      this.prisma.booking.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        include: {
          patient: { select: userSelect },
          caregiver: { select: { fullName: true, caregiverNumber: true, user: { select: userSelect } } },
          payment: { select: { paymentStatus: true } },
        },
      }),
      this.prisma.booking.count({ where }),
    ]);

    return {
      nodes: rows.map((b) => ({
        id: b.id,
        status: b.status,
        bookingDate: b.bookingDate,
        startTime: b.startTime.toISOString().slice(11, 16),
        durationHours: Number(b.durationHours),
        serviceType: b.serviceType,
        estimatedCost: b.estimatedCost == null ? null : Number(b.estimatedCost),
        paymentStatus: b.payment?.paymentStatus ?? null,
        disputeStatus: b.disputeStatus,
        createdAt: b.createdAt,
        patientId: b.patientId,
        patientName: fullName(b.patient) ?? b.patientName ?? '-',
        patientPhone: b.patient?.phone ?? null,
        caregiverId: b.caregiverId,
        caregiverName: b.caregiver ? b.caregiver.fullName || fullName(b.caregiver.user) : null,
        caregiverNumber: b.caregiver?.caregiverNumber ?? null,
      })),
      totalCount,
      page,
      limit,
      hasNextPage: offset + limit < totalCount,
    };
  }

  async detail(id: string): Promise<AdminBookingDetail> {
    // id เป็น uuid — รูปแบบผิดให้ตอบ not found แทน error จาก Postgres
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException('ไม่พบรายการจอง');
    const userSelect = { firstName: true, lastName: true, displayName: true, email: true, phone: true };
    const b = await this.prisma.booking.findUnique({
      where: { id },
      include: {
        patient: { select: userSelect },
        bookedByUser: { select: userSelect },
        careRecipient: { select: { name: true } },
        caregiver: { select: { fullName: true, caregiverNumber: true, phone: true, user: { select: userSelect } } },
        payment: true,
        statusHistory: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!b) throw new NotFoundException('ไม่พบรายการจอง');

    // changedBy เป็น users.id (หรือ null = ระบบ) — ดึงชื่อทีเดียว
    const actorIds = [...new Set(b.statusHistory.map((h) => h.changedBy).filter((x): x is string => !!x))];
    const actors = actorIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, firstName: true, lastName: true, displayName: true, email: true },
        })
      : [];
    const actorName = new Map(actors.map((a) => [a.id, fullName(a)]));
    const num = (d: Prisma.Decimal | null) => (d == null ? null : Number(d));

    return {
      id: b.id,
      status: b.status,
      bookingDate: b.bookingDate,
      startTime: b.startTime.toISOString().slice(11, 16),
      durationHours: Number(b.durationHours),
      serviceType: b.serviceType,
      estimatedCost: num(b.estimatedCost),
      paymentStatus: b.payment?.paymentStatus ?? null,
      disputeStatus: b.disputeStatus,
      createdAt: b.createdAt,
      patientId: b.patientId,
      patientName: fullName(b.patient) ?? b.patientName ?? '-',
      patientPhone: b.patient?.phone ?? null,
      patientEmail: b.patient?.email ?? null,
      caregiverId: b.caregiverId,
      caregiverName: b.caregiver ? b.caregiver.fullName || fullName(b.caregiver.user) : null,
      caregiverNumber: b.caregiver?.caregiverNumber ?? null,
      caregiverPhone: b.caregiver ? b.caregiver.phone || b.caregiver.user?.phone || null : null,
      careRecipientName: b.careRecipient?.name ?? null,
      bookedByName: b.bookedBy && b.bookedBy !== b.patientId ? fullName(b.bookedByUser) : null,
      timeSlot: b.timeSlot,
      serviceLocations: b.serviceLocations,
      locationAddress: b.locationAddress,
      platformFee: num(b.platformFee),
      tasks: b.tasks,
      notes: b.notes,
      rejectionReason: b.rejectionReason,
      disputeReason: b.disputeReason,
      dayOfContactName: b.dayOfContactName,
      dayOfContactPhone: b.dayOfContactPhone,
      dayOfContactRelationship: b.dayOfContactRelationship,
      acceptedAt: b.acceptedAt,
      confirmedAt: b.confirmedAt,
      completedAt: b.completedAt,
      payment: b.payment
        ? {
            id: b.payment.id,
            amount: Number(b.payment.amount),
            capturedAmount: num(b.payment.capturedAmount),
            refundedAmount: Number(b.payment.refundedAmount),
            paymentMethod: b.payment.paymentMethod,
            paymentStatus: b.payment.paymentStatus,
            omiseChargeId: b.payment.omiseChargeId,
            failureMessage: b.payment.failureMessage,
            createdAt: b.payment.createdAt,
          }
        : null,
      statusHistory: b.statusHistory.map((h) => ({
        id: h.id,
        fromStatus: h.fromStatus,
        toStatus: h.toStatus,
        reason: h.reason,
        changedByName: h.changedBy ? actorName.get(h.changedBy) ?? null : null,
        createdAt: h.createdAt,
      })),
    };
  }
}
