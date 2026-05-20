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
import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { SupabaseService } from '../../common/supabase.service';
import { Caregiver } from './entities/caregiver.entity';
import { UpdateCaregiverInput } from './dto/update-caregiver.input';
import { KycDocument } from './entities/kyc-document.entity';
import { computeFieldChanges } from './utils/compute-field-changes';

/** Profile fields ที่ track ได้ใน updateProfile */
const PROFILE_TRACKED_FIELDS = ['bio', 'hourlyRate', 'skills', 'experienceYears', 'phone', 'address'];

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
  resubmitCount?: number; // optional — mapToEntity fallback เป็น 0
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
  private readonly logger = new Logger(CaregiverService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly supabaseService: SupabaseService,
  ) {}

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
      resubmitCount: caregiver.resubmitCount ?? 0,
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

    // ── Compute field changes ก่อน update ────────────────────────────
    const fieldChanges = computeFieldChanges(
      existing as unknown as Record<string, unknown>,
      input as unknown as Record<string, unknown>,
      PROFILE_TRACKED_FIELDS,
    );

    // ── Transaction: update + edit log ────────────────────────────────
    const caregiver = await this.prismaService.$transaction(async (tx) => {
      const updated = await tx.caregiver.update({
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

      // บันทึก edit log ถ้ามี field ที่เปลี่ยนจริง
      if (fieldChanges.length > 0) {
        const changesJson = JSON.stringify(fieldChanges);
        await tx.$executeRaw`
          INSERT INTO caregiver_edit_logs (id, caregiver_id, edited_by, action, field_changes, created_at)
          VALUES (gen_random_uuid(), ${existing.id}, ${userId}, 'profile_edit', ${changesJson}::jsonb, NOW())
        `;
      }

      return updated;
    });

    return this.mapToEntity(caregiver);
  }

  /**
   * setSearchableByUser — เปิด/ปิดการแสดงในผลค้นหา (caregiver-facing)
   *
   * ต่างจาก setSearchable() ตรงที่:
   * - รับ userId แทน caregiverId (caregiver รู้แค่ userId ของตัเอง)
   * - Guard: kycStatus ต้องเป็น 'verified' เท่านั้น → ForbiddenException ถ้าไม่ใช่
   * - เก็บล็อก toggle event เพื่อ analytics
   *
   * @param userId       - internal user ID จาก JWT
   * @param isSearchable - true = แสดงในผลค้นหา, false = ซ่อน
   * @throws NotFoundException   ถ้าไม่พบ caregiver record
   * @throws ForbiddenException  ถ้า kycStatus ไม่ใช่ 'verified'
   */
  async setSearchableByUser(
    userId: string,
    isSearchable: boolean,
  ): Promise<Caregiver> {
    // ── 1: ค้นหา caregiver จาก userId ────────────────────────────
    const existing = await this.prismaService.caregiver.findUnique({
      where: { userId },
    });

    if (!existing) {
      throw new NotFoundException(
        `Caregiver with userId "${userId}" not found`,
      );
    }

    // ── 2: Guard — kycStatus ต้องเป็น 'verified' ────────────────────
    if (existing.kycStatus !== 'verified') {
      throw new ForbiddenException(
        'ต้องผ่านการยืนยันตัวตนก่อน',
      );
    }

    // ── 3: อัปเดต is_searchable ─────────────────────────────────
    const caregiver = await this.prismaService.caregiver.update({
      where: { userId },
      data: { isSearchable },
    });

    // ── 4: Log toggle event เพื่อ analytics ──────────────────────
    this.logger.log({
      event: 'caregiver.availability.toggled',
      caregiverId: caregiver.id,
      userId: caregiver.userId,
      isSearchable,
      previousValue: existing.isSearchable,
      changed: existing.isSearchable !== isSearchable,
      timestamp: new Date().toISOString(),
    });

    return this.mapToEntity(caregiver);
  }

  /**
   * generateCaregiverNumber — สร้าง caregiver number ในรูปแบบ CG-YYMMDD-XXXX
   *
   * Format:
   * - CG = prefix ระบุว่าเป็น caregiver
   * - YYMMDD = วันที่สมัคร (e.g., 260503 = 3 May 2026)
   * - XXXX = running number ของวันนั้นๆ ซึ่งจะ reset ทุกวัน
   *
   * ตัวอย่าง:
   * - วันแรก (3 May 2026): CG-260503-0001, CG-260503-0002, ...
   * - วันถัดไป (4 May 2026): CG-260504-0001, CG-260504-0002, ...
   *
   * Overloads:
   * - generateCaregiverNumber(): ใช้ PrismaService โดยตรง (for register flow)
   * - generateCaregiverNumber(tx): ใช้ transaction client (for submitKyc flow)
   */
  async generateCaregiverNumber(): Promise<string>;
  async generateCaregiverNumber(tx: any): Promise<string>;
  async generateCaregiverNumber(tx?: any): Promise<string> {
    const client = tx || this.prismaService;

    // ── 1: สร้างวันที่ YYMMDD ใช้ UTC ────────────────────────────────────
    // เพื่อให้ตรงกับ database timestamp ที่เก็บเป็น UTC
    const today = new Date();
    const utcYear = String(today.getUTCFullYear()).slice(-2); // YY
    const utcMonth = String(today.getUTCMonth() + 1).padStart(2, '0'); // MM
    const utcDate = String(today.getUTCDate()).padStart(2, '0'); // DD
    const yymmdd = `${utcYear}${utcMonth}${utcDate}`;

    // ── 2: นับจำนวน caregiver ที่สร้างในวันนี้ (UTC) ──────────────────────
    // เราสร้าง start/end of day ใน UTC เพื่อให้ตรงกับ database timestamps
    const startOfDayUTC = new Date(Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate(),
      0, 0, 0, 0
    ));

    const endOfDayUTC = new Date(Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate(),
      23, 59, 59, 999
    ));

    this.logger.debug(
      `[generateCaregiverNumber] Counting caregivers between ${startOfDayUTC.toISOString()} and ${endOfDayUTC.toISOString()}`,
    );

    const countToday = await client.caregiver.count({
      where: {
        createdAt: {
          gte: startOfDayUTC,
          lte: endOfDayUTC,
        },
      },
    });

    this.logger.debug(`[generateCaregiverNumber] Found ${countToday} caregivers today`);

    // ── 3: สร้าง running number (XXXX) ──────────────────────────
    const xxxx = String(countToday + 1).padStart(4, '0');

    // ── 4: รวม format ────────────────────────────────────────────
    const result = `CG-${yymmdd}-${xxxx}`;
    this.logger.debug(`[generateCaregiverNumber] Generated: ${result}`);

    return result;
  }

  /**
   * ดึงเอกสาร KYC ของ caregiver พร้อม signed URL (หมดอายุ 1 ชั่วโมง)
   *
   * ทำไมต้อง signed URL?
   * - ไฟล์ใน Supabase Storage bucket ที่เป็น private ไม่สามารถเข้าถึงได้ผ่าน public URL
   * - signed URL = URL ชั่วคราวที่ฝัง token ของ Supabase ไว้ → ผู้ถือ URL เข้าได้โดยไม่ต้อง login
   * - หมดอายุ 3,600 วินาที (1 ชั่วโมง) ตามข้อกำหนด
   *
   * Flow:
   * 1. Query kyc_documents WHERE caregiver_id = caregiverId
   * 2. สำหรับแต่ละ document → ดึง storage path จาก fileUrl
   * 3. เรียก supabase.storage.from(bucket).createSignedUrl(path, 3600)
   * 4. ถ้า sign ล้มเหลว → คืน fileUrl เดิม (graceful fallback)
   *
   * @param caregiverId - UUID ของ caregiver
   * @returns รายการเอกสารพร้อม signedUrl (array ว่างถ้าไม่มีเอกสาร)
   */
  async getDocumentsWithSignedUrls(caregiverId: string): Promise<KycDocument[]> {
    const docs = await this.prismaService.kycDocument.findMany({
      where: { caregiverId },
      orderBy: { uploadedAt: 'desc' },
    });

    if (docs.length === 0) return [];

    const supabase = this.supabaseService.getAdminClient();

    const enriched = await Promise.all(
      docs.map(async (doc) => {
        const entity: KycDocument = {
          id: doc.id,
          caregiverId: doc.caregiverId ?? undefined,
          userId: doc.userId,
          docType: doc.documentType,
          fileUrl: doc.fileUrl,
          fileName: doc.fileName,
          fileSize: doc.fileSize,
          mimeType: doc.mimeType,
          uploadedAt: doc.uploadedAt,
        };

        try {
          // fileUrl format: https://<project>.supabase.co/storage/v1/object/public/<bucket>/<path>
          // หรือ: https://<project>.supabase.co/storage/v1/object/<bucket>/<path>
          // ต้องดึง bucket name และ object path ออกมา
          const storageSegment = doc.fileUrl.split('/storage/v1/object/')[1];
          if (storageSegment) {
            // ตัด "public/" ออกถ้ามี
            const withoutPublic = storageSegment.startsWith('public/')
              ? storageSegment.slice('public/'.length)
              : storageSegment;
            const slashIndex = withoutPublic.indexOf('/');
            if (slashIndex !== -1) {
              const bucket = withoutPublic.slice(0, slashIndex);
              const objectPath = withoutPublic.slice(slashIndex + 1);

              const { data, error } = await supabase.storage
                .from(bucket)
                .createSignedUrl(objectPath, 3600); // 1 hour

              if (!error && data?.signedUrl) {
                entity.signedUrl = data.signedUrl;
              }
            }
          }
        } catch {
          // ถ้า sign URL ล้มเหลว → ใช้ fileUrl เดิม (ไม่ให้ query พัง)
        }

        return entity;
      }),
    );

    return enriched;
  }
}
