import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { AvatarUrlService } from '../common/avatar-url.service';
import { ADL_ITEMS, AdlAnswers } from '../assessment/assessment.constants';
import { AdminPatientProfile } from './dto/admin-patient-profile.dto';

type NameParts = { firstName: string | null; lastName: string | null; displayName: string | null; email: string | null };
const nameOf = (u: NameParts | null | undefined) => {
  if (!u) return null;
  return [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.displayName || u.email || null;
};
const num = (d: Prisma.Decimal | null) => (d == null ? null : Number(d));

const ACTIVE = ['unmatched', 'pending', 'accepted', 'confirmed', 'in_progress'];
const CANCELLED = ['cancelled', 'rejected', 'expired'];

/**
 * โปรไฟล์ผู้ใช้ (ผู้จอง) สำหรับแอดมิน — ข้อมูลบัญชี, ผู้รับการดูแล + แบบประเมิน ADL, สรุปการจอง
 * ★ มีข้อมูลสุขภาพ — ห้าม log response
 */
@Injectable()
export class AdminPatientProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly avatarUrlService: AvatarUrlService,
  ) {}

  async get(userId: string): Promise<AdminPatientProfile> {
    if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new NotFoundException('ไม่พบผู้ใช้');

    const nameSelect = { firstName: true, lastName: true, displayName: true, email: true };
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        ...nameSelect,
        phone: true,
        avatarUrl: true,
        address: true,
        subDistrict: true,
        district: true,
        province: true,
        postalCode: true,
        role: true,
        isActive: true,
        is_suspended: true,
        createdAt: true,
        last_login_at: true,
        careRecipients: {
          where: { is_deleted: false },
          orderBy: [{ is_self: 'desc' }, { created_at: 'asc' }],
          include: { assessment: { include: { assessor: { select: nameSelect } } } },
        },
      },
    });
    if (!u) throw new NotFoundException('ไม่พบผู้ใช้');

    const where = { patientId: userId };
    const [byStatus, paid, recent, avatarUrl] = await Promise.all([
      this.prisma.booking.groupBy({ by: ['status'], where, _count: { _all: true } }),
      this.prisma.payment.aggregate({
        where: { patientId: userId, paymentStatus: { in: ['captured', 'transferred', 'partially_refunded'] } },
        _sum: { amount: true, refundedAmount: true },
      }),
      this.prisma.booking.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          status: true,
          bookingDate: true,
          serviceType: true,
          estimatedCost: true,
          caregiver: { select: { fullName: true } },
          careRecipient: { select: { name: true } },
        },
      }),
      // avatarUrl ใน DB เป็น storage path ของ bucket private — ต้อง sign ก่อนส่งให้ <img>
      this.avatarUrlService.resolve(u.avatarUrl, u.id),
    ]);
    const count = (list: string[]) =>
      byStatus.filter((s) => list.includes(s.status)).reduce((n, s) => n + s._count._all, 0);

    const fullAddress = [u.address, u.subDistrict, u.district, u.province, u.postalCode].filter(Boolean).join(' ');

    return {
      id: u.id,
      name: nameOf(u) ?? '-',
      email: u.email,
      phone: u.phone,
      avatarUrl,
      address: fullAddress || null,
      role: u.role,
      isActive: u.isActive,
      isSuspended: u.is_suspended,
      createdAt: u.createdAt,
      lastLoginAt: u.last_login_at,
      careRecipients: u.careRecipients.map((r) => {
        const a = r.assessment;
        const answers = (a?.adlAnswers ?? {}) as Partial<AdlAnswers>;
        return {
          id: r.id,
          name: r.name,
          nickname: r.nickname,
          isSelf: r.is_self,
          dateOfBirth: r.date_of_birth,
          gender: r.gender,
          weightKg: num(r.weight_kg),
          heightCm: num(r.height_cm),
          bloodType: r.blood_type,
          mobilityLevel: r.mobility_level,
          medicalConditions: r.medical_conditions,
          currentMedications: r.current_medications,
          allergies: r.allergies,
          hasInfectiousDisease: r.has_infectious_disease,
          emergencyContactName: r.emergency_contact_name,
          emergencyContactPhone: r.emergency_contact_phone,
          emergencyContactRel: r.emergency_contact_rel,
          preferredHospital: r.preferred_hospital,
          careNotes: r.care_notes,
          assessment: a
            ? {
                // เรียงตามลำดับข้อมาตรฐาน — ข้อที่ไม่มีใน JSON ส่ง null
                answers: ADL_ITEMS.map(({ code }) => ({ code, value: answers[code] ?? null })),
                adlTotalScore: a.adlTotalScore,
                unsureCount: a.unsureCount,
                flags: a.flags,
                noSpecialConditions: a.noSpecialConditions,
                hasUnsureFlag: a.hasUnsureFlag,
                dementiaSevere: a.dementiaSevere,
                careGroup: a.careGroup,
                assessedByName: nameOf(a.assessor),
                assessedAt: a.assessedAt,
              }
            : null,
        };
      }),
      bookingStats: {
        total: byStatus.reduce((n, s) => n + s._count._all, 0),
        active: count(ACTIVE),
        completed: count(['completed']),
        cancelled: count(CANCELLED),
        totalPaid: Number(paid._sum.amount ?? 0) - Number(paid._sum.refundedAmount ?? 0),
      },
      recentBookings: recent.map((b) => ({
        id: b.id,
        status: b.status,
        bookingDate: b.bookingDate,
        serviceType: b.serviceType,
        estimatedCost: num(b.estimatedCost),
        caregiverName: b.caregiver?.fullName ?? null,
        careRecipientName: b.careRecipient?.name ?? null,
      })),
    };
  }
}
