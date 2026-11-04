import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { evaluatePayoutReadiness } from '../payment/payout-account-readiness';
import { AdminCaregiverWorkInfo } from './dto/admin-caregiver-work.dto';

/** ข้อมูลการรับงานของผู้ดูแลสำหรับหน้ารายละเอียดผู้ดูแล (แอดมิน) — อ่านอย่างเดียว */
@Injectable()
export class AdminCaregiverWorkService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string): Promise<AdminCaregiverWorkInfo> {
    // route ของ FE (/admin/users/:id) ส่ง users.id — id ผิดรูปแบบตอบ not found แทน error จาก Postgres
    if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new NotFoundException('ไม่พบผู้ดูแล');

    const c = await this.prisma.caregiver.findUnique({
      where: { userId },
      select: {
        id: true,
        isSearchable: true,
        careLevel: true,
        careLevelSetAt: true,
        careLevelSetByUser: { select: { firstName: true, lastName: true, displayName: true, email: true } },
        serviceAreaProvince: true,
        serviceAreaDistrict: true,
        availability: {
          where: { isActive: true },
          select: { dayOfWeek: true, timeSlot: true },
          orderBy: [{ dayOfWeek: 'asc' }, { timeSlot: 'asc' }],
        },
        jobTypes: { select: { jobType: true } },
        serviceLocations: { select: { serviceLocation: true } },
        payoutAccount: {
          select: {
            bankCode: true,
            accountName: true,
            accountNumberLast4: true,
            status: true,
            recipientStatus: true,
            omiseRecipientId: true,
            verifiedAt: true,
            updatedAt: true,
          },
        },
      },
    });
    if (!c) throw new NotFoundException('ไม่พบผู้ดูแล');

    const setBy = c.careLevelSetByUser;
    const setByName = setBy
      ? [setBy.firstName, setBy.lastName].filter(Boolean).join(' ').trim() || setBy.displayName || setBy.email
      : null;
    const pa = c.payoutAccount;
    const readiness = evaluatePayoutReadiness(pa);

    return {
      caregiverId: c.id,
      isAcceptingJobs: c.isSearchable,
      careLevel: c.careLevel,
      careLevelSetAt: c.careLevelSetAt,
      careLevelSetByName: setByName,
      availability: c.availability.map((a) => ({ dayOfWeek: a.dayOfWeek, timeSlot: a.timeSlot })),
      jobTypes: c.jobTypes.map((j) => j.jobType),
      serviceLocations: c.serviceLocations.map((s) => s.serviceLocation),
      serviceAreaProvince: c.serviceAreaProvince,
      serviceAreaDistrict: c.serviceAreaDistrict,
      payoutAccount: pa
        ? {
            bankCode: pa.bankCode,
            accountName: pa.accountName,
            accountNumberLast4: pa.accountNumberLast4,
            status: pa.status,
            recipientStatus: pa.recipientStatus,
            ready: readiness.ready,
            notReadyReason: readiness.reason ?? null,
            verifiedAt: pa.verifiedAt,
            updatedAt: pa.updatedAt,
          }
        : null,
    };
  }
}
