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
import { PrismaService } from '../../common/prisma.service';
import { KycDocument } from './entities/kyc-document.entity';

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
};

/** ข้อมูลสำหรับสร้าง document record ใหม่ */
type CreateDocumentData = {
  userId: string;
  documentType: string;
  fileUrl: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
};

@Injectable()
export class KycDocumentService {
  constructor(private prismaService: PrismaService) {}

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
    const doc = await this.prismaService.kycDocument.create({
      data: {
        userId: data.userId,
        documentType: data.documentType,
        fileUrl: data.fileUrl,
        fileName: data.fileName,
        fileSize: data.fileSize,
        mimeType: data.mimeType,
        // caregiverId = null (default) — จะถูก link ตอน submit KYC
        // uploadedAt = now() (default จาก Prisma schema)
      },
    });

    return this.mapToEntity(doc);
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
