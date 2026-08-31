/**
 * CaregiverEditLog Entity — GraphQL type สำหรับประวัติการแก้ไขข้อมูล caregiver
 *
 * บันทึกทุกครั้งที่ caregiver แก้ไขข้อมูลหรือเอกสาร:
 * - "resubmit"        = ส่ง KYC ใหม่หลังถูก reject (เปรียบเทียบ field ก่อน/หลัง)
 * - "profile_edit"    = แก้ไข profile fields (bio, hourlyRate, skills, etc.)
 * - "document_upload" = อัปโหลดเอกสาร KYC ใหม่
 * - "document_delete" = ลบเอกสาร KYC
 *
 * admin ใช้ดูใน adminKycDetail → editHistory
 */
import { ObjectType, Field, ID } from '@nestjs/graphql';

/**
 * FieldChange — แสดงการเปลี่ยนแปลงของ 1 field
 */
@ObjectType({ description: 'A single field change record' })
export class FieldChange {
  @Field({ description: 'Field name that was changed' })
  field!: string;

  @Field(() => String, { nullable: true, description: 'Previous value (JSON-stringified)' })
  oldValue?: string;

  @Field(() => String, { nullable: true, description: 'New value (JSON-stringified)' })
  newValue?: string;
}

@ObjectType({ description: 'Log entry for caregiver profile/document edits' })
export class CaregiverEditLog {
  @Field(() => ID)
  id!: string;

  /** UUID ของ caregiver ที่ถูกแก้ไข */
  @Field({ description: 'Caregiver ID' })
  caregiverId!: string;

  /** UUID ของ user ที่ทำการแก้ไข (caregiver เอง) */
  @Field({ description: 'User ID who made the edit' })
  editedBy!: string;

  /** ชื่อของคนที่แก้ไข (JOIN จาก users.display_name) */
  @Field({ nullable: true, description: 'Display name of the editor' })
  editorName?: string;

  /**
   * ประเภทการแก้ไข:
   * - "resubmit"        = ส่ง KYC ใหม่
   * - "profile_edit"    = แก้ไข profile
   * - "document_upload" = อัปโหลดเอกสาร
   * - "document_delete" = ลบเอกสาร
   */
  @Field({ description: 'Edit action: resubmit | profile_edit | document_upload | document_delete' })
  action!: string;

  /** รายการ fields ที่เปลี่ยนแปลง (null ถ้าเป็น document action) */
  @Field(() => [FieldChange], { nullable: true, description: 'List of changed fields with old/new values' })
  fieldChanges?: FieldChange[];

  /** วันเวลาที่ทำการแก้ไข */
  @Field({ description: 'When this edit was made' })
  createdAt!: Date;
}
