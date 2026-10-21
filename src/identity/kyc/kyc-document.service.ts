/**
 * KycDocumentService — CRUD สำหรับจัดการเอกสาร KYC
 *
 * เอกสาร KYC คือไฟล์ที่ caregiver อัปโหลดเพื่อยืนยันตัวตน
 * flow: อัปโหลดไฟล์ → สร้าง record ที่นี่ → submit KYC ใน KycService จะ link กับ caregiver
 *
 * Methods:
 * - create()             — สร้าง document record (หลังอัปโหลดไฟล์สำเร็จ)
 * - findByCaregiverId()  — ดึงเอกสารทั้งหมดของ caregiver
 * - findById()           — ดึงเอกสารเดียวตาม id
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.service';
import { normalizeKycStoragePath } from './utils/kyc-storage-path';
import { KycDocument } from './entities/kyc-document.entity';
import { ClockService } from '../../common/clock.service';
import { LICENSE_DOC_TYPE, LICENSE_STATUS } from './license/license.constants';
import { validateLicenseFields } from './license/license-validation';
import { DrivingLicenseService } from './driving-license/driving-license.service';
import {
  DRIVING_LICENSE_DOC_TYPE,
  DRIVING_LICENSE_REVIEW_STATUS,
} from './driving-license/driving-license.constants';

/** Shape ของ KycDocument ที่ Prisma คืนมา — ใช้สำหรับ mapToEntity */
type PrismaKycDocument = {
  id: string;
  caregiverId: string | null;
  userId: string;
  documentType: string;
  fileUrl: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  uploadedAt: Date;
  licenseNumber?: string | null;
  expiresAt?: Date | null;
  reviewStatus?: string | null;
};

/** ข้อมูลสำหรับสร้าง document record ใหม่ */
type CreateDocumentData = {
  userId: string;
  /** supabase_uid ของคนที่เรียก — มาจาก session ไม่ใช่จาก input (ใช้เช็คเจ้าของโฟลเดอร์) */
  ownerUid: string;
  documentType: string;
  fileUrl: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  /** PYG-587: เฉพาะ documentType = professional_license */
  licenseNumber?: string | null;
  expiresAt?: Date | null;
};

@Injectable()
export class KycDocumentService {
  constructor(
    private prismaService: PrismaService,
    private readonly config: ConfigService,
    private readonly clock: ClockService,
    private readonly drivingLicense: DrivingLicenseService,
  ) {}

  // ─── Private helper ──────────────────────────────────────────────────────

  /**
   * แปลง Prisma KycDocument → GraphQL KycDocument entity
   *
   * Prisma ใช้ชื่อ field "documentType" แต่ GraphQL entity ใช้ "docType"
   * เพราะใน Prisma schema มี @map("doc_type") — ชื่อ column ใน DB คือ doc_type
   * แต่ Prisma model ใช้ชื่อ documentType (camelCase ของ doc_type)
   */
  private mapToEntity(doc: PrismaKycDocument): KycDocument {
    return {
      id: doc.id,
      caregiverId: doc.caregiverId ?? undefined,
      userId: doc.userId,
      docType: doc.documentType, // Prisma: documentType → GraphQL: docType
      fileUrl: doc.fileUrl,
      fileName: doc.fileName,
      fileSize: doc.fileSize,
      mimeType: doc.mimeType,
      uploadedAt: doc.uploadedAt,
      licenseNumber: doc.licenseNumber ?? undefined,
      expiresAt: doc.expiresAt ?? undefined,
      reviewStatus: doc.reviewStatus ?? undefined,
    };
  }

  // ─── Public methods ───────────────────────────────────────────────────────

  /**
   * สร้าง document record ใหม่
   *
   * ใช้เมื่อ: caregiver อัปโหลดไฟล์สำเร็จแล้ว (ไฟล์อยู่ใน storage แล้ว)
   * ตอนนี้ caregiverId ยังเป็น null — จะถูก link ตอน submit KYC
   *
   * @param data - ข้อมูลเอกสาร (userId, documentType, fileUrl, fileName, fileSize, mimeType)
   */
  async create(data: CreateDocumentData): Promise<KycDocument> {
    // ★ ด่านความปลอดภัยของ flow นี้ทั้งหมดอยู่บรรทัดนี้
    //   เดิมเก็บ fileUrl ที่ client ส่งมาดิบ ๆ (validate แค่ @IsUrl) แล้วตอนอ่าน
    //   ระบบแกะ bucket จากค่านั้นไปเซ็นด้วย service role ซึ่ง bypass Storage RLS
    //   → caregiver ชี้ไปโฟลเดอร์ของคนอื่นแล้วขอ signed URL ของรูปบัตรคนนั้นได้
    //   ตอนนี้แปลงเป็น storage path + บังคับว่าโฟลเดอร์ต้องเป็นของคนที่เรียกเท่านั้น
    const storagePath = normalizeKycStoragePath(
      data.fileUrl,
      data.ownerUid,
      this.config.getOrThrow<string>('SUPABASE_URL'),
    );

    // PYG-587: ใบประกอบฯ ต้องมีเลข + วันหมดอายุในอนาคต (เวลาไทย) — ตรวจที่ service เพื่อตอบ 422 + error code ตาม contract
    //   ชนิดอื่นไม่เก็บ/ไม่ตรวจ 2 ช่องนี้ (expires_at ของ S06 ใบขับขี่ใช้คอลัมน์เดียวกัน แต่ยังไม่เปิดรับที่นี่)
    const isLicense = data.documentType === LICENSE_DOC_TYPE;
    const license = isLicense
      ? validateLicenseFields(data.licenseNumber, data.expiresAt, this.clock.now())
      : null;

    // PYG-597: ใบขับขี่ต้องมีวันหมดอายุที่เป็นวันหลังจากวันนี้ · ไม่เก็บเลขใบขับขี่ (ยังไม่เคาะ)
    const isDriving = data.documentType === DRIVING_LICENSE_DOC_TYPE;
    const drivingExpiresAt = isDriving ? this.drivingLicense.validateExpiry(data.expiresAt) : null;
    // ผูกกับผู้ดูแลทันทีถ้ามีแถวผู้ดูแลอยู่แล้ว: ผู้ดูแลที่ KYC อนุมัติแล้วส่ง KYC ซ้ำไม่ได้ (E1)
    // จึงไม่มีจังหวะ link ตอน submit · ผู้ดูแลใหม่ยังเป็น null และถูก link ตอน submit KYC ตามเดิม
    const drivingCaregiverId = isDriving
      ? ((await this.prismaService.caregiver.findUnique({
          where: { userId: data.userId },
          select: { id: true },
        }))?.id ?? null)
      : null;

    // PYG-669: ผู้ดูแลที่ KYC อนุมัติแล้วต่ออายุใบประกอบฯ — ส่ง KYC ซ้ำไม่ได้ จึงต้องผูกตอนอัปโหลด
    //   ไม่งั้นใบใหม่ไม่โผล่ทั้ง kycStatus และหน้า review (loadDocs อ่านด้วย caregiver_id) แอดมินอนุมัติไม่ได้
    //   เฉพาะ verified: ผู้ดูแลที่ยังไม่ผ่านถูกผูกตอน submit/resubmit ตามเดิม (resubmit ปลดแล้วผูกตาม documentIds)
    const licenseCaregiverId = isLicense
      ? await this.findVerifiedCaregiverId(data.userId)
      : null;

    const doc = await this.prismaService.kycDocument.create({
      data: {
        userId: data.userId,
        documentType: data.documentType,
        fileUrl: storagePath,
        fileName: data.fileName,
        fileSize: data.fileSize,
        mimeType: data.mimeType,
        // ใบประกอบฯ เข้าคิวรอแอดมินตรวจทันที (E6: ใบใหม่หลังถูกปฏิเสธ = pending ใหม่ แถวเก่ายังอยู่)
        ...(license && {
          licenseNumber: license.licenseNumber,
          expiresAt: license.expiresAt,
          reviewStatus: LICENSE_STATUS.PENDING,
          ...(licenseCaregiverId && { caregiverId: licenseCaregiverId }),
        }),
        ...(isDriving && {
          expiresAt: drivingExpiresAt,
          // E7: ใบใหม่เข้าคิวตรวจเสมอ · ประวัติรอบก่อนอยู่ใน kyc_reviews
          reviewStatus: DRIVING_LICENSE_REVIEW_STATUS.PENDING,
          ...(drivingCaregiverId && { caregiverId: drivingCaregiverId }),
        }),
        // caregiverId = null (default) — จะถูก link ตอน submit KYC
        // uploadedAt = now() (default จาก Prisma schema)
      },
    });

    return this.mapToEntity(doc);
  }

  /** caregivers.id ของผู้ใช้นี้ ถ้า KYC อนุมัติแล้ว · ยังไม่มีแถว/ยังไม่อนุมัติ → null */
  private async findVerifiedCaregiverId(
    userId: string,
  ): Promise<string | null> {
    const caregiver = await this.prismaService.caregiver.findUnique({
      where: { userId },
      select: { id: true, kycStatus: true },
    });
    return caregiver?.kycStatus === 'verified' ? caregiver.id : null;
  }


  /**
   * ดึงเอกสาร KYC ทั้งหมดของ caregiver
   *
   * ใช้เมื่อ: แสดงรายการเอกสารที่ caregiver อัปโหลดไว้
   * เรียง uploadedAt จากใหม่ไปเก่า
   *
   * @param caregiverId - UUID ของ caregiver
   * @returns รายการเอกสาร (อาจเป็น array ว่างถ้ายังไม่มี)
   */
  async findByCaregiverId(caregiverId: string): Promise<KycDocument[]> {
    const docs = await this.prismaService.kycDocument.findMany({
      where: { caregiverId },
      orderBy: { uploadedAt: 'desc' }, // เอกสารใหม่สุดขึ้นก่อน
    });

    return docs.map((doc) => this.mapToEntity(doc));
  }

  /**
   * ดึงเอกสาร KYC ตาม id
   *
   * ใช้เมื่อ: ดูรายละเอียดเอกสารเฉพาะฉบับ หรือ validate ก่อน link กับ caregiver
   *
   * @param id - UUID ของเอกสาร
   * @throws NotFoundException ถ้าไม่พบเอกสาร
   */
  async findById(id: string): Promise<KycDocument> {
    const doc = await this.prismaService.kycDocument.findUnique({
      where: { id },
    });

    if (!doc) {
      throw new NotFoundException(`KYC Document with ID "${id}" not found`);
    }

    return this.mapToEntity(doc);
  }
}
