import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { CaregiverPublicDto, AvailabilitySlotDto } from './dto/caregiver-public.dto';

@Injectable()
export class CaregiverPublicService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * getPublicProfile — returns the public-safe profile for a caregiver.
   *
   * 404 guard:
   *  - caregiver not found
   *  - is_searchable = false
   *  - kyc_status != 'verified'
   *
   * Fields excluded: id_card_number, phone, email, full address.
   */
  async getPublicProfile(id: string): Promise<CaregiverPublicDto> {
    // Single query: fetch caregiver + user + availability + aggregated reviews
    const caregiver = await this.prisma.caregiver.findUnique({
      where: { id },
      select: {
        id: true,
        fullName: true,
        bio: true,
        experienceYears: true,
        hourlyRate: true,
        skills: true,
        kycStatus: true,
        isSearchable: true,
        kycVerifiedAt: true,
        serviceAreaProvince: true,
        serviceAreaDistrict: true,
        availability: {
          where: { isActive: true },
          select: { dayOfWeek: true, timeSlot: true },
          orderBy: [{ dayOfWeek: 'asc' }, { timeSlot: 'asc' }],
        },
        patientReviews: {
          select: { rating: true },
        },
        user: {
          select: {
            avatarUrl: true,
            // firstName / lastName live in fullName for now; split below
          },
        },
      },
    });

    // ── 404 guard ─────────────────────────────────────────────────────────
    if (
      !caregiver ||
      !caregiver.isSearchable ||
      caregiver.kycStatus !== 'verified'
    ) {
      throw new NotFoundException('Caregiver not found');
    }

    // ── Compute avg_rating + review_count ─────────────────────────────────
    const reviewCount = caregiver.patientReviews.length;
    const avgRating =
      reviewCount > 0
        ? Math.round(
            (caregiver.patientReviews.reduce((sum, r) => sum + r.rating, 0) /
              reviewCount) *
              100,
          ) / 100
        : null;

    // ── Split fullName into first / last name ─────────────────────────────
    // fullName is stored as a single string; split on first space.
    const nameParts = (caregiver.fullName ?? '').trim().split(/\s+/);
    const firstName = nameParts[0] ?? '';
    const lastName = nameParts.slice(1).join(' ');

    // ── Build availability structure [{day, slots[]}] ─────────────────────
    const availMap = new Map<number, string[]>();
    for (const slot of caregiver.availability) {
      const existing = availMap.get(slot.dayOfWeek) ?? [];
      existing.push(slot.timeSlot);
      availMap.set(slot.dayOfWeek, existing);
    }
    const availability: AvailabilitySlotDto[] = Array.from(
      availMap.entries(),
    ).map(([day, slots]) => ({ day, slots }));

    return {
      id: caregiver.id,
      first_name: firstName,
      last_name: lastName,
      avatar_url: caregiver.user.avatarUrl ?? null,
      bio: caregiver.bio ?? null,
      experience_years: caregiver.experienceYears ?? null,
      hourly_rate: caregiver.hourlyRate ?? null,
      avg_rating: avgRating,
      review_count: reviewCount,
      skills: caregiver.skills,
      availability,
      province: caregiver.serviceAreaProvince ?? null,
      district: caregiver.serviceAreaDistrict ?? null,
      verified_at: caregiver.kycVerifiedAt ?? null,
    };
  }
}
