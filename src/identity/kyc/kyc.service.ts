/**
 * KycService — Business logic สำหรับ KYC (Know Your Customer)
 * ...
 */
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { KycInput } from './dto/kyc.input';
import { Caregiver } from './entities/caregiver.entity';
import { AuthUser } from '../../common/decorators/current-user.decorator';

@Injectable()
export class KycService {
  constructor(private prismaService: PrismaService) {}

  /**
   * submitKyc — สร้างหรืออัปเดต caregiver record พร้อม link เอกสาร KYC
   *
   * Business rules:
   * - status = "none"  → submit ได้ (สร้าง/อัปเดต record, set pending)
   * - status = อื่นๆ  → throw ConflictException (ห้าม submit ซ้ำ)
   * - documentIds ทุกตัวต้องมีอยู่จริง และต้องเป็นของ user คนนี้
   *
   * @param user  - user ที่ login อยู่ (inject โดย SupabaseAuthGuard)
   * @param input - ข้อมูล KYC ที่ client ส่งมา
   * @returns Caregiver entity ที่ถูกสร้าง/อัปเดต
   */
  async submitKyc(user: AuthUser, input: KycInput): Promise<Caregiver> {
    // ── ขั้นตอนที่ 1: เช็ค KYC status ปัจจุบัน ────────────────────────
    // ไม่ annotate type เป็น Caregiver เพราะ Prisma return nullable fields
    // ที่ไม่ตรงกับ GraphQL entity — ใช้ inferred type แทน
    const existing = await this.prismaService.caregiver.findUnique({
      where: { userId: user.id },
    });

    if (existing && existing.kycStatus !== 'none') {
      throw new ConflictException(
        `KYC already submitted. Current status: "${existing.kycStatus}"`,
      );
    }

    // ── ขั้นตอนที่ 2: Validate documentIds ───────────────────────────
    // ต้องมีอยู่จริงในตาราง kyc_documents
    // และต้องเป็น document ของ user คนนี้ (ป้องกัน user A ใช้ doc ของ user B)
    if (input.documentIds.length > 0) {
      const foundDocs = await this.prismaService.kycDocument.findMany({
        where: {
          id: { in: input.documentIds },
          userId: user.id, // เช็คว่าเป็นของ user นี้จริงๆ
        },
        select: { id: true },
      });

      const foundIds = foundDocs.map((d) => d.id);
      const missingIds = input.documentIds.filter(
        (id) => !foundIds.includes(id),
      );

      if (missingIds.length > 0) {
        throw new NotFoundException(
          `Document IDs not found or not owned by user: ${missingIds.join(', ')}`,
        );
      }
    }

    // ── ขั้นตอนที่ 3: Upsert caregiver record ────────────────────────
    // upsert = สร้างถ้ายังไม่มี, อัปเดตถ้ามีแล้ว
    // ทำใน transaction เพื่อให้ upsert + link documents เป็น atomic
    // (ถ้า link documents ล้มเหลว → upsert จะถูก rollback ด้วย)
    const caregiver = await this.prismaService.$transaction(async (tx) => {
      // 3a. Upsert caregivers table
      const upserted = await tx.caregiver.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          fullName: input.fullName,
          idCardNumber: input.idCardNumber,
          phone: input.phone,
          skills: input.skills,
          experienceYears: input.experienceYears,
          hourlyRate: input.hourlyRate,
          bio: input.bio,
          kycStatus: 'pending',
          kycSubmittedAt: new Date(),
          isSearchable: false,
        },
        update: {
          fullName: input.fullName,
          idCardNumber: input.idCardNumber,
          phone: input.phone,
          skills: input.skills,
          experienceYears: input.experienceYears,
          hourlyRate: input.hourlyRate,
          bio: input.bio,
          kycStatus: 'pending',
          kycSubmittedAt: new Date(),
        },
      });

      // 3b. Link documents → caregiverId
      if (input.documentIds.length > 0) {
        await tx.kycDocument.updateMany({
          where: {
            id: { in: input.documentIds },
            userId: user.id,
          },
          data: { caregiverId: upserted.id },
        });
      }

      return upserted;
    });

    return this.mapPrismaToEntity(caregiver);
  }

  /**
   * getCaregiverByUserId — ดึงข้อมูล caregiver ของ user
   *
   * @param userId - ID ของ user ที่ต้องการดึงข้อมูล
   */
  async getCaregiverByUserId(userId: string): Promise<Caregiver> {
    const caregiver = await this.prismaService.caregiver.findUnique({
      where: { userId },
    });

    if (!caregiver) {
      throw new NotFoundException(`Caregiver not found for user ${userId}`);
    }

    return this.mapPrismaToEntity(caregiver);
  }

  private mapPrismaToEntity(caregiver: any): Caregiver {
    return {
      id: caregiver.id,
      userId: caregiver.userId,
      fullName: caregiver.fullName ?? undefined,
      idCardNumber: caregiver.idCardNumber ?? undefined,
      phone: caregiver.phone ?? undefined,
      skills: caregiver.skills ?? undefined,
      experienceYears: caregiver.experienceYears ?? undefined,
      hourlyRate: caregiver.hourlyRate ?? undefined,
      bio: caregiver.bio ?? undefined,
      kycStatus: caregiver.kycStatus,
      kycSubmittedAt: caregiver.kycSubmittedAt ?? undefined,
      isSearchable: caregiver.isSearchable,
      createdAt: caregiver.createdAt,
      updatedAt: caregiver.updatedAt,
    };
  }
}
