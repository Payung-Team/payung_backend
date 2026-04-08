/**
 * KycResolver — GraphQL Resolver สำหรับ KYC (Know Your Customer)
 *
 * Mutations:
 * - submitKyc          — submit ข้อมูล KYC (caregiver only)
 * - uploadKycDocument  — อัปโหลดไฟล์เอกสาร KYC ไป Supabase Storage (caregiver only)
 *
 * Guard ที่ใช้:
 * - SupabaseAuthGuard = ตรวจสอบ JWT token ก่อนทุก request
 * - RolesGuard        = เช็คว่า user มี role ที่อนุญาตไหม
 */
import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { BadRequestException, UseGuards } from '@nestjs/common';
import { KycService } from './kyc.service';
import { KycDocumentService } from './kyc-document.service';
import { SupabaseStorageService } from '../../common/supabase-storage.service';
import { KycInput } from './dto/kyc.input';
import { Caregiver } from './entities/caregiver.entity';
import { KycDocument } from './entities/kyc-document.entity';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  CurrentUser,
  AuthUser,
} from '../../common/decorators/current-user.decorator';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { GraphQLUpload } = require('graphql-upload');
import type { FileUpload } from 'graphql-upload';
import { Readable } from 'stream';

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

/** อ่าน Readable stream แล้วรวมเป็น Buffer */
function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

@Resolver()
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class KycResolver {
  constructor(
    private kycService: KycService,
    private kycDocumentService: KycDocumentService,
    private supabaseStorageService: SupabaseStorageService,
  ) {}

  /**
   * submitKyc — submit ข้อมูล KYC (ต้อง upload เอกสารก่อนแล้วได้ documentIds)
   */
  @Mutation(() => Caregiver, {
    description: 'Submit KYC information (caregiver only)',
  })
  @Roles('caregiver')
  async submitKyc(
    @CurrentUser() user: AuthUser,
    @Args('input') input: KycInput,
  ): Promise<Caregiver> {
    return this.kycService.submitKyc(user, input);
  }

  /**
   * uploadKycDocument — อัปโหลดไฟล์เอกสาร KYC ไป Supabase Storage
   *
   * Flow:
   * 1. รับไฟล์ผ่าน GraphQL multipart upload (graphql-upload)
   * 2. Validate: size ≤ 10MB, mime = jpeg/png/pdf
   * 3. Upload ไป Supabase Storage: kyc-documents/{userId}/{timestamp}_{filename}
   * 4. สร้าง kyc_documents record ใน DB
   * 5. คืน KycDocument พร้อม signed URL (1 ชั่วโมง)
   *
   * ตัวอย่างการเรียกใช้ (GraphQL multipart):
   * ```
   * mutation UploadDoc($file: Upload!, $docType: String!) {
   *   uploadKycDocument(file: $file, docType: $docType) {
   *     id docType fileUrl fileName fileSize mimeType uploadedAt
   *   }
   * }
   * ```
   */
  @Mutation(() => KycDocument, {
    description: 'Upload a KYC document file to Supabase Storage (caregiver only)',
  })
  @Roles('caregiver')
  async uploadKycDocument(
    @CurrentUser() user: AuthUser,
    @Args({ name: 'file', type: () => GraphQLUpload }) file: Promise<FileUpload>,
    @Args('docType') docType: string,
  ): Promise<KycDocument> {
    // ── Step 1: รับ FileUpload จาก graphql-upload ─────────────────────
    const { createReadStream, filename, mimetype } = await file;

    // ── Step 2: Validate MIME type ────────────────────────────────────
    if (!ALLOWED_MIME_TYPES.includes(mimetype)) {
      throw new BadRequestException(
        `ประเภทไฟล์ไม่ถูกต้อง รองรับเฉพาะ JPEG, PNG และ PDF เท่านั้น (ได้รับ: ${mimetype})`,
      );
    }

    // ── Step 3: อ่าน stream → Buffer เพื่อตรวจขนาดและ upload ─────────
    const buffer = await streamToBuffer(createReadStream());

    // ── Step 4: Validate file size ────────────────────────────────────
    if (buffer.length > MAX_FILE_SIZE) {
      const sizeMB = (buffer.length / (1024 * 1024)).toFixed(2);
      throw new BadRequestException(
        `ไฟล์มีขนาดใหญ่เกินไป (${sizeMB} MB) — อนุญาตสูงสุด 10 MB`,
      );
    }

    // ── Step 5: สร้าง storage path ────────────────────────────────────
    // รูปแบบ: {userId}/{timestamp}_{filename}
    // ใช้ userId แทน caregiverId เพราะ caregiver record อาจยังไม่ถูกสร้าง
    const timestamp = Date.now();
    const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${user.id}/${timestamp}_${safeFilename}`;

    // ── Step 6: Upload ไปยัง Supabase Storage ────────────────────────
    const fileUrl = await this.supabaseStorageService.uploadFile(
      buffer,
      storagePath,
      mimetype,
    );

    // ── Step 7: บันทึก record ลง DB ──────────────────────────────────
    return this.kycDocumentService.create({
      userId: user.id,
      documentType: docType,
      fileUrl,
      fileName: filename,
      fileSize: buffer.length,
      mimeType: mimetype,
    });
  }
}
