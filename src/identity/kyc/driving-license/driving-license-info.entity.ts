/**
 * DrivingLicenseInfo - ใบขับขี่ที่ผู้ดูแลเห็นของตัวเอง และที่แอดมินเห็นในหน้า KYC review (PYG-597 · contract PYG-596)
 *
 * ⚠ ใช้เฉพาะ owner/admin - ห้ามใช้กับ type ฝั่ง public (R7: Elder เห็นแค่ drivingLicenseVerified)
 */
import { Field, ID, ObjectType } from '@nestjs/graphql';
import { KycDocument } from '../entities/kyc-document.entity';
import { DrivingLicenseState } from './driving-license-status';
import { DRIVING_LICENSE_DOC_TYPE } from './driving-license.constants';

@ObjectType({ description: 'Driving license review info (owner and admin only)' })
export class DrivingLicenseInfo {
  @Field({ description: 'Passed review: approved AND not past expiry day (Asia/Bangkok), computed at call time' })
  verified!: boolean;

  @Field({ description: 'Latest upload: none | pending | approved | rejected - clients must fall back for unknown values' })
  status!: string;

  @Field(() => ID, { nullable: true, description: 'kyc_documents.id of the latest upload (documentId for approve/reject)' })
  documentId?: string;

  @Field({ nullable: true })
  fileName?: string;

  @Field({ nullable: true, description: 'Signed URL (1 hr) - same mechanism as other KYC files' })
  signedUrl?: string;

  @Field({ nullable: true, description: 'End of expiry day, Asia/Bangkok' })
  expiresAt?: Date;

  @Field({ description: 'Latest upload is past its expiry day - computed by BE, FE must not compute' })
  isExpired!: boolean;

  @Field({ nullable: true, description: 'Reason of the latest rejection (when status = rejected)' })
  rejectionReason?: string;
}

/** รวมผลคำนวณ (state) กับข้อมูลไฟล์/เหตุผลจากรายการเอกสารที่ sign แล้ว */
export function buildDrivingLicenseInfo(
  state: DrivingLicenseState,
  documents: KycDocument[],
): DrivingLicenseInfo {
  const doc = state.documentId
    ? documents.find((d) => d.id === state.documentId && d.docType === DRIVING_LICENSE_DOC_TYPE)
    : undefined;
  return {
    verified: state.verified,
    status: state.status,
    documentId: state.documentId,
    fileName: doc?.fileName,
    signedUrl: doc?.signedUrl,
    expiresAt: state.expiresAt,
    isExpired: state.isExpired,
    rejectionReason: state.status === 'rejected' ? doc?.rejectionReason : undefined,
  };
}
