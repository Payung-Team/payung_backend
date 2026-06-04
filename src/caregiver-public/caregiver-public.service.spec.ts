import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { CaregiverPublicService } from './caregiver-public.service';
import { PrismaService } from '../common/prisma.service';

// ── Helpers ────────────────────────────────────────────────────────────────────

type CaregiverRow = {
  id: string;
  fullName: string | null;
  bio: string | null;
  experienceYears: number | null;
  hourlyRate: number | null;
  skills: string[];
  kycStatus: string;
  isSearchable: boolean;
  kycVerifiedAt: Date | null;
  serviceAreaProvince: string | null;
  serviceAreaDistrict: string | null;
  availability: { dayOfWeek: number; timeSlot: string }[];
  patientReviews: { rating: number }[];
  user: { avatarUrl: string | null };
};

const VERIFIED_AT = new Date('2025-01-15T00:00:00Z');

function makeCaregiver(overrides: Partial<CaregiverRow> = {}): CaregiverRow {
  return {
    id: 'cg-1',
    fullName: 'สมชาย ใจดี',
    bio: 'ดูแลผู้สูงอายุมา 5 ปี',
    experienceYears: 5,
    hourlyRate: 350,
    skills: ['elderly_care', 'medication_management'],
    kycStatus: 'verified',
    isSearchable: true,
    kycVerifiedAt: VERIFIED_AT,
    serviceAreaProvince: 'เชียงใหม่',
    serviceAreaDistrict: 'เมืองเชียงใหม่',
    availability: [
      { dayOfWeek: 1, timeSlot: 'morning' },
      { dayOfWeek: 1, timeSlot: 'afternoon' },
      { dayOfWeek: 3, timeSlot: 'morning' },
    ],
    patientReviews: [{ rating: 5 }, { rating: 4 }],
    user: { avatarUrl: 'https://cdn.example.com/avatar.jpg' },
    ...overrides,
  };
}

// ── Setup ──────────────────────────────────────────────────────────────────────

describe('CaregiverPublicService', () => {
  let service: CaregiverPublicService;
  let prisma: { caregiver: { findUnique: jest.Mock } };

  beforeEach(async () => {
    prisma = { caregiver: { findUnique: jest.fn() } };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CaregiverPublicService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<CaregiverPublicService>(CaregiverPublicService);
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  it('returns a correctly shaped public profile', async () => {
    prisma.caregiver.findUnique.mockResolvedValue(makeCaregiver());

    const result = await service.getPublicProfile('cg-1');

    expect(result).toMatchObject({
      id: 'cg-1',
      first_name: 'สมชาย',
      last_name: 'ใจดี',
      avatar_url: 'https://cdn.example.com/avatar.jpg',
      bio: 'ดูแลผู้สูงอายุมา 5 ปี',
      experience_years: 5,
      hourly_rate: 350,
      skills: ['elderly_care', 'medication_management'],
      province: 'เชียงใหม่',
      district: 'เมืองเชียงใหม่',
      verified_at: VERIFIED_AT,
    });
  });

  // ── avg_rating computation ─────────────────────────────────────────────────

  it('computes avg_rating correctly from reviews', async () => {
    prisma.caregiver.findUnique.mockResolvedValue(
      makeCaregiver({ patientReviews: [{ rating: 5 }, { rating: 4 }] }),
    );

    const result = await service.getPublicProfile('cg-1');

    expect(result.avg_rating).toBe(4.5);
    expect(result.review_count).toBe(2);
  });

  it('returns avg_rating=null and review_count=0 when caregiver has no reviews', async () => {
    prisma.caregiver.findUnique.mockResolvedValue(
      makeCaregiver({ patientReviews: [] }),
    );

    const result = await service.getPublicProfile('cg-1');

    expect(result.avg_rating).toBeNull();
    expect(result.review_count).toBe(0);
  });

  it('rounds avg_rating to 2 decimal places', async () => {
    // 5 + 4 + 4 = 13 / 3 = 4.333...
    prisma.caregiver.findUnique.mockResolvedValue(
      makeCaregiver({
        patientReviews: [{ rating: 5 }, { rating: 4 }, { rating: 4 }],
      }),
    );

    const result = await service.getPublicProfile('cg-1');

    expect(result.avg_rating).toBe(4.33);
  });

  // ── Availability grouping ──────────────────────────────────────────────────

  it('groups availability slots by day', async () => {
    prisma.caregiver.findUnique.mockResolvedValue(makeCaregiver());

    const result = await service.getPublicProfile('cg-1');

    // Day 1: morning + afternoon; Day 3: morning
    expect(result.availability).toHaveLength(2);
    const day1 = result.availability.find((a) => a.day === 1);
    expect(day1?.slots).toEqual(['morning', 'afternoon']);
    const day3 = result.availability.find((a) => a.day === 3);
    expect(day3?.slots).toEqual(['morning']);
  });

  it('returns empty availability array when no active slots', async () => {
    prisma.caregiver.findUnique.mockResolvedValue(
      makeCaregiver({ availability: [] }),
    );

    const result = await service.getPublicProfile('cg-1');

    expect(result.availability).toEqual([]);
  });

  // ── Name splitting ─────────────────────────────────────────────────────────

  it('splits fullName into first_name and last_name on first space', async () => {
    prisma.caregiver.findUnique.mockResolvedValue(
      makeCaregiver({ fullName: 'วิไล พรรณราย สกุลยาว' }),
    );

    const result = await service.getPublicProfile('cg-1');

    expect(result.first_name).toBe('วิไล');
    expect(result.last_name).toBe('พรรณราย สกุลยาว');
  });

  it('handles single-word fullName (no last name)', async () => {
    prisma.caregiver.findUnique.mockResolvedValue(
      makeCaregiver({ fullName: 'สมชาย' }),
    );

    const result = await service.getPublicProfile('cg-1');

    expect(result.first_name).toBe('สมชาย');
    expect(result.last_name).toBe('');
  });

  it('handles null fullName gracefully', async () => {
    prisma.caregiver.findUnique.mockResolvedValue(
      makeCaregiver({ fullName: null }),
    );

    const result = await service.getPublicProfile('cg-1');

    expect(result.first_name).toBe('');
    expect(result.last_name).toBe('');
  });

  // ── Null nullable fields ───────────────────────────────────────────────────

  it('returns null for optional fields when not set', async () => {
    prisma.caregiver.findUnique.mockResolvedValue(
      makeCaregiver({
        bio: null,
        experienceYears: null,
        hourlyRate: null,
        kycVerifiedAt: null,
        serviceAreaProvince: null,
        serviceAreaDistrict: null,
        user: { avatarUrl: null },
      }),
    );

    const result = await service.getPublicProfile('cg-1');

    expect(result.bio).toBeNull();
    expect(result.experience_years).toBeNull();
    expect(result.hourly_rate).toBeNull();
    expect(result.verified_at).toBeNull();
    expect(result.province).toBeNull();
    expect(result.district).toBeNull();
    expect(result.avatar_url).toBeNull();
  });

  // ── 404 guard ──────────────────────────────────────────────────────────────

  it('throws NotFoundException when caregiver does not exist', async () => {
    prisma.caregiver.findUnique.mockResolvedValue(null);

    await expect(service.getPublicProfile('nonexistent')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws NotFoundException when is_searchable = false', async () => {
    prisma.caregiver.findUnique.mockResolvedValue(
      makeCaregiver({ isSearchable: false }),
    );

    await expect(service.getPublicProfile('cg-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws NotFoundException when kyc_status = "pending"', async () => {
    prisma.caregiver.findUnique.mockResolvedValue(
      makeCaregiver({ kycStatus: 'pending' }),
    );

    await expect(service.getPublicProfile('cg-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws NotFoundException when kyc_status = "rejected"', async () => {
    prisma.caregiver.findUnique.mockResolvedValue(
      makeCaregiver({ kycStatus: 'rejected' }),
    );

    await expect(service.getPublicProfile('cg-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws NotFoundException when is_searchable=false even if kyc_status=verified', async () => {
    prisma.caregiver.findUnique.mockResolvedValue(
      makeCaregiver({ isSearchable: false, kycStatus: 'verified' }),
    );

    await expect(service.getPublicProfile('cg-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  // ── Field filtering (PII must not appear) ─────────────────────────────────

  it('does not return id_card_number, phone, email, or address fields', async () => {
    prisma.caregiver.findUnique.mockResolvedValue(makeCaregiver());

    const result = await service.getPublicProfile('cg-1');
    const keys = Object.keys(result);

    expect(keys).not.toContain('id_card_number');
    expect(keys).not.toContain('phone');
    expect(keys).not.toContain('email');
    expect(keys).not.toContain('address');
  });
});
