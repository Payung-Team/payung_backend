import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

export interface SavedCaregiverResponse {
  id: string;
  caregiverId: string;
  savedAt: Date;
  caregiver: {
    fullName?: string;
    avatarUrl?: string;
    hourlyRate?: number;
    skills: string[];
    province?: string;
    district?: string;
  };
}

@Injectable()
export class SavedCaregiversService {
  private readonly logger = new Logger(SavedCaregiversService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** GET /api/v1/patient/saved-caregivers — list */
  async list(patientId: string): Promise<SavedCaregiverResponse[]> {
    const saved = await this.prisma.savedCaregiver.findMany({
      where:   { patientId },
      orderBy: { savedAt: 'desc' },
      select: {
        id:          true,
        caregiverId: true,
        savedAt:     true,
        caregiver: {
          select: {
            fullName:            true,
            hourlyRate:          true,
            skills:              true,
            serviceAreaProvince: true,
            serviceAreaDistrict: true,
            user: { select: { avatarUrl: true } },
          },
        },
      },
    });

    return saved.map((s) => ({
      id:          s.id,
      caregiverId: s.caregiverId,
      savedAt:     s.savedAt,
      caregiver: {
        fullName:  s.caregiver.fullName            ?? undefined,
        avatarUrl: s.caregiver.user.avatarUrl      ?? undefined,
        hourlyRate: s.caregiver.hourlyRate          ?? undefined,
        skills:    s.caregiver.skills,
        province:  s.caregiver.serviceAreaProvince ?? undefined,
        district:  s.caregiver.serviceAreaDistrict ?? undefined,
      },
    }));
  }

  /** POST /api/v1/patient/saved-caregivers — save */
  async save(
    patientId: string,
    caregiverId: string,
  ): Promise<SavedCaregiverResponse> {
    // ตรวจว่า caregiver มีอยู่จริง
    const caregiver = await this.prisma.caregiver.findUnique({
      where: { id: caregiverId },
      select: {
        id:                  true,
        fullName:            true,
        hourlyRate:          true,
        skills:              true,
        serviceAreaProvince: true,
        serviceAreaDistrict: true,
        user: { select: { avatarUrl: true } },
      },
    });
    if (!caregiver) throw new NotFoundException('Caregiver not found');

    try {
      const saved = await this.prisma.savedCaregiver.create({
        data: { patientId, caregiverId },
        select: { id: true, caregiverId: true, savedAt: true },
      });

      this.logger.log({ event: 'saved_caregiver.added', caregiverId, patientId });
      return {
        id:          saved.id,
        caregiverId: saved.caregiverId,
        savedAt:     saved.savedAt,
        caregiver: {
          fullName:  caregiver.fullName            ?? undefined,
          avatarUrl: caregiver.user.avatarUrl      ?? undefined,
          hourlyRate: caregiver.hourlyRate          ?? undefined,
          skills:    caregiver.skills,
          province:  caregiver.serviceAreaProvince ?? undefined,
          district:  caregiver.serviceAreaDistrict ?? undefined,
        },
      };
    } catch (err: unknown) {
      // Unique constraint violation — already saved
      const code = (err as { code?: string }).code;
      if (code === 'P2002') {
        throw new ConflictException('Caregiver is already saved');
      }
      throw err;
    }
  }

  /** DELETE /api/v1/patient/saved-caregivers/:caregiver_id — unsave */
  async unsave(patientId: string, caregiverId: string): Promise<void> {
    const existing = await this.prisma.savedCaregiver.findUnique({
      where: { patientId_caregiverId: { patientId, caregiverId } },
      select: { id: true },
    });

    if (!existing) throw new NotFoundException('Saved caregiver not found');

    await this.prisma.savedCaregiver.delete({
      where: { patientId_caregiverId: { patientId, caregiverId } },
    });

    this.logger.log({ event: 'saved_caregiver.removed', caregiverId, patientId });
  }
}
