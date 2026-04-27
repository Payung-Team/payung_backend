/**
 * CaregiverService — CRUD สำหรับจัดการข้อมูล caregiver
 *
 * ทำไมแยก CaregiverService ออกจาก KycService?
 * - KycService = จัดการ flow การ submit KYC (validate + upsert + link docs)
 * - CaregiverService = CRUD พื้นฐานของ caregivers table
 * - แยกกันเพื่อให้ module อื่น (เช่น Search, Booking) inject CaregiverService ไปใช้ได้
 *   โดยไม่ต้องพึ่ง KYC business logic
 *
 * Methods:
 * - create()        — สร้าง caregiver record ใหม่
 * - findByUserId()  — ค้นหาจาก userId (1 user = 1 caregiver)
 * - updateStatus()  — เปลี่ยน kycStatus (admin approve/reject)
 * - setSearchable() — เปิด/ปิดการแสดงในผลค้นหา
 */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { Caregiver } from './entities/caregiver.entity';
import { UpdateCaregiverInput } from './dto/update-caregiver.input';

/** Shape ของ caregiver ที่ Prisma คืนมา — ใช้สำหรับ mapToEntity */
type PrismaCaregiver = {
  id: string;
  userId: string;
  caregiverNumber: string | null;
  fullName: string | null;
  idCardNumber: string | null;
  gender: string | null;
  dateOfBirth: Date | null;
  address: string | null;
  phone: string | null;
  skills: string[];
  experienceYears: number | null;
  hourlyRate: number | null;
  bio: string | null;
  kycStatus: string;
  kycSubmittedAt: Date | null;
  kycVerifiedAt: Date | null;
  isSearchable: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/** ข้อมูลสำหรับสร้าง caregiver ใหม่ */
type CreateCaregiverData = {
  fullName: string;
  idCardNumber: string;
  phone: string;
  skills: string[];
  experienceYears: number;
  hourlyRate: number;
  bio?: string;
};

@Injectable()
export class CaregiverService {
  constructor(private prismaService: PrismaService) {}

  // ─── Private helper ──────────────────────────────────────────────────────

  /**
   * แปลง Prisma Caregiver (null fields) → GraphQL Caregiver entity (undefined fields)
   *
   * ทำไมต้อง map?
   * - Prisma ใช้ null สำหรับ optional fields
   * - GraphQL ใช้ undefined สำหรับ nullable fields
   * - non-null assertion (!) ใช้กับ fields ที่รู้ว่ามีค่าแน่นอน (เช่น หลัง submit KYC แล้ว)
   *   แต่ก่อน submit อาจเป็น null ได้ → ใช้ ?? '' เป็น fallback
   */
  private mapToEntity(caregiver: PrismaCaregiver): Caregiver {
    return {
      id: caregiver.id,
      userId: caregiver.userId,
      caregiverNumber: caregiver.caregiverNumber ?? undefined,
      fullName: caregiver.fullName ?? '',
      idCardNumber: caregiver.idCardNumber ?? '',
      gender: caregiver.gender ?? undefined,
      dateOfBirth: caregiver.dateOfBirth ?? undefined,
      address: caregiver.address ?? undefined,
      phone: caregiver.phone ?? '',
      skills: caregiver.skills,
      experienceYears: caregiver.experienceYears ?? 0,
      hourlyRate: caregiver.hourlyRate ?? 0,
      bio: caregiver.bio ?? undefined,
      kycStatus: caregiver.kycStatus,
      kycSubmittedAt: caregiver.kycSubmittedAt ?? undefined,
      kycVerifiedAt: caregiver.kycVerifiedAt ?? undefined,
      isSearchable: caregiver.isSearchable,
      createdAt: caregiver.createdAt,
      updatedAt: caregiver.updatedAt,
    };
  }

  // ─── Public methods ───────────────────────────────────────────────────────

  /**
   * สร้าง caregiver record ใหม่
   *
   * ใช้เมื่อ: user ที่มี role "caregiver" ต้องการเริ่มกรอก KYC
   * สร้าง record เปล่าก่อน แล้วค่อย submit KYC ทีหลัง
   *
   * @param userId - internal user id (จาก users table)
   * @param data   - ข้อมูลเริ่มต้นของ caregiver
   */
  async create(userId: string, data: CreateCaregiverData): Promise<Caregiver> {
    const caregiver = await this.prismaService.caregiver.create({
      data: {
        userId,
        fullName: data.fullName,
        idCardNumber: data.idCardNumber,
        phone: data.phone,
        skills: data.skills,
        experienceYears: data.experienceYears,
        hourlyRate: data.hourlyRate,
        bio: data.bio,
        // defaults: kycStatus = "none", isSearchable = false (จาก Prisma schema)
      },
    });

    return this.mapToEntity(caregiver);
  }

  /**
   * ค้นหา caregiver จาก userId
   *
   * ใช้เมื่อ: ดึงข้อมูล caregiver profile ของ user ที่ login อยู่
   * 1 user มี caregiver record ได้แค่ 1 (userId เป็น @unique ใน Prisma)
   *
   * @param userId - internal user id
   * @throws NotFoundException ถ้าไม่พบ caregiver record
   */
  async findByUserId(userId: string): Promise<Caregiver> {
    const caregiver = await this.prismaService.caregiver.findUnique({
      where: { userId },
    });

    if (!caregiver) {
      throw new NotFoundException(
        `Caregiver with userId "${userId}" not found`,
      );
    }

    return this.mapToEntity(caregiver);
  }

  /**
   * อัปเดต KYC status ของ caregiver
   *
   * ใช้เมื่อ: admin approve หรือ reject KYC
   * - ถ้า status = "verified" → set kycVerifiedAt เป็นเวลาปัจจุบัน
   * - ถ้า status = "rejected" → clear kycVerifiedAt
   *
   * @param caregiverId - UUID ของ caregiver
   * @param status      - "pending" | "verified" | "rejected"
   * @throws NotFoundException ถ้าไม่พบ caregiver
   */
  async updateStatus(
    caregiverId: string,
    status: string,
  ): Promise<Caregiver> {
    // ตรวจว่า caregiver มีอยู่จริง
    const existing = await this.prismaService.caregiver.findUnique({
      where: { id: caregiverId },
    });

    if (!existing) {
      throw new NotFoundException(
        `Caregiver with ID "${caregiverId}" not found`,
      );
    }

    const caregiver = await this.prismaService.caregiver.update({
      where: { id: caregiverId },
      data: {
        kycStatus: status,
        // ถ้า verified → บันทึกเวลาที่ verify, ถ้าไม่ → clear ออก
        kycVerifiedAt: status === 'verified' ? new Date() : null,
      },
    });

    return this.mapToEntity(caregiver);
  }

  /**
   * เปิด/ปิดการแสดง caregiver ในผลค้นหา
   *
   * ใช้เมื่อ: หลัง KYC verified แล้ว admin เปิดให้ค้นหาได้
   * หรือ caregiver ต้องการซ่อนตัวเองจากผลค้นหาชั่วคราว
   *
   * @param caregiverId  - UUID ของ caregiver
   * @param isSearchable - true = แสดงในผลค้นหา, false = ซ่อน
   * @throws NotFoundException ถ้าไม่พบ caregiver
   */
  async setSearchable(
    caregiverId: string,
    isSearchable: boolean,
  ): Promise<Caregiver> {
    const existing = await this.prismaService.caregiver.findUnique({
      where: { id: caregiverId },
    });

    if (!existing) {
      throw new NotFoundException(
        `Caregiver with ID "${caregiverId}" not found`,
      );
    }

    const caregiver = await this.prismaService.caregiver.update({
      where: { id: caregiverId },
      data: { isSearchable },
    });

    return this.mapToEntity(caregiver);
  }

  /**
   * updateProfile — แก้ไข profile ของ caregiver (เฉพาะ whitelist fields)
   *
   * Whitelist: bio, hourlyRate, skills, experienceYears, phone
   * Locked: fullName, idCardNumber, gender, dateOfBirth, caregiverNumber
   *
   * @param userId - internal user id ของ caregiver ที่ login อยู่
   * @param input  - fields ที่ต้องการเปลี่ยน (partial update)
   * @throws NotFoundException  ถ้าไม่พบ caregiver record
   * @throws ForbiddenException ถ้า kycStatus ไม่ใช่ "verified"
   */
  async updateProfile(
    userId: string,
    input: UpdateCaregiverInput,
  ): Promise<Caregiver> {
    const existing = await this.prismaService.caregiver.findUnique({
      where: { userId },
    });

    if (!existing) {
      throw new NotFoundException(`Caregiver not found`);
    }

    if (existing.kycStatus !== 'verified') {
      throw new ForbiddenException(
        'กรุณารอผลตรวจสอบ KYC ก่อนแก้ไขโปรไฟล์',
      );
    }

    const caregiver = await this.prismaService.caregiver.update({
      where: { userId },
      data: {
        ...(input.bio !== undefined && { bio: input.bio }),
        ...(input.hourlyRate !== undefined && { hourlyRate: input.hourlyRate }),
        ...(input.skills !== undefined && { skills: input.skills }),
        ...(input.experienceYears !== undefined && { experienceYears: input.experienceYears }),
        ...(input.phone !== undefined && { phone: input.phone }),
        ...(input.address !== undefined && { address: input.address }),
      },
    });

    return this.mapToEntity(caregiver);
  }
}
