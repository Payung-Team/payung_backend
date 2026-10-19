/**
 * LicenseInfo — สรุปใบประกอบวิชาชีพล่าสุดของผู้ดูแล (PYG-587 · contract PYG-585)
 * ใช้ทั้งหน้า KYC review ของแอดมิน และ kycStatus ของผู้ดูแลเอง
 */
import { Field, ID, ObjectType } from '@nestjs/graphql';
import { KycDocument } from '../entities/kyc-document.entity';
import { LICENSE_DOC_TYPE } from './license.constants';

@ObjectType({ description: 'Latest professional license of a caregiver' })
export class LicenseInfo {
  @Field(() => ID, { description: 'kyc_documents.id — ใช้เป็น documentId ของ approveLicense / rejectLicense' })
  documentId!: string;

  @Field({ nullable: true })
  licenseNumber?: string;

  @Field()
  fileName!: string;

  @Field({ nullable: true, description: 'Signed URL (1 hr) — same mechanism as other KYC files' })
  signedUrl?: string;

  @Field({ nullable: true, description: 'End of expiry day, Asia/Bangkok' })
  expiresAt?: Date;

  @Field({ description: 'pending | approved | rejected | expired — clients must fall back for unknown values' })
  status!: string;

  @Field({ nullable: true })
  rejectionReason?: string;
}

/** ใบประกอบฯ ล่าสุด (documents เรียงใหม่ → เก่าอยู่แล้ว) — ไม่มี → undefined */
export function pickLatestLicense(documents: KycDocument[]): LicenseInfo | undefined {
  const doc = documents.find((d) => d.docType === LICENSE_DOC_TYPE);
  if (!doc) return undefined;
  return {
    documentId: doc.id,
    licenseNumber: doc.licenseNumber,
    fileName: doc.fileName,
    signedUrl: doc.signedUrl,
    expiresAt: doc.expiresAt,
    status: doc.reviewStatus ?? 'pending',
    rejectionReason: doc.rejectionReason,
  };
}
