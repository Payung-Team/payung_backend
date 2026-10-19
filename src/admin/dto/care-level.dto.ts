/**
 * GraphQL types ของระดับผู้ดูแลฝั่งแอดมิน (PYG-581 · contract PYG-579 §3–§4)
 *
 * - CaregiverCareLevelInfo      : ระดับปัจจุบัน + ผู้กำหนด + เวลา (adminKycDetail.careLevelInfo, ผลของ setCaregiverCareLevel)
 * - CareLevelChange             : ประวัติ 1 แถว (caregiverCareLevelHistory)
 * - SetCaregiverCareLevelInput  : ขาเข้าของ setCaregiverCareLevel
 * - SetCaregiverCareLevelPayload: ผลของ setCaregiverCareLevel
 *
 * ★ ฝั่งผู้ดูแลเห็นแค่ Caregiver.careLevel (ระดับอย่างเดียว) — ผู้กำหนด/เวลา/ประวัติเป็นข้อมูลของแอดมินเท่านั้น
 */
import {
  Field,
  ID,
  InputType,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { CareLevel } from '../../common/care-level/care-level';
import { CARE_LEVEL_REASON_MAX_LENGTH } from '../../common/care-level/care-level.errors';

/**
 * แหล่งที่มาของแถวประวัติ — BE คำนวณจากคอลัมน์ reason / changed_by ให้
 * FE จะได้ไม่ต้องรู้ค่าภายในอย่าง 'migration_default' เอง
 */
export enum CareLevelChangeSource {
  /** ระบบตั้งให้ตอน migration PYG-580 (ผู้ดูแลที่อนุมัติไปก่อนมีฟีเจอร์นี้) — ยังไม่ผ่านการทบทวนของแอดมิน */
  MIGRATION_DEFAULT = 'MIGRATION_DEFAULT',
  /** แอดมินเลือกตอนกดอนุมัติ KYC */
  KYC_APPROVAL = 'KYC_APPROVAL',
  /** แอดมินแก้ภายหลังผ่าน setCaregiverCareLevel (มีเหตุผลเสมอ) */
  ADMIN_UPDATE = 'ADMIN_UPDATE',
}

registerEnumType(CareLevelChangeSource, {
  name: 'CareLevelChangeSource',
  description: 'Where a care level history row came from',
});

@ObjectType({
  description:
    'Current care level of a caregiver with who set it and when (admin only)',
})
export class CaregiverCareLevelInfo {
  @Field(() => ID)
  caregiverId!: string;

  /** null = ยังไม่มีระดับ (KYC ยังไม่อนุมัติ หรืออนุมัติก่อน PYG-581 ขึ้น) */
  @Field(() => CareLevel, {
    nullable: true,
    description: 'null = no level yet',
  })
  level!: CareLevel | null;

  /** users.id ของแอดมินที่กำหนด — null = ระบบตั้งให้ (migration) หรือยังไม่มีระดับ */
  @Field(() => ID, {
    nullable: true,
    description: 'Admin user id who set the level — null when set by migration',
  })
  setBy!: string | null;

  /** ชื่อแอดมินที่กำหนด (users.display_name) */
  @Field(() => String, { nullable: true })
  setByName!: string | null;

  @Field(() => Date, { nullable: true })
  setAt!: Date | null;

  /**
   * true = มีระดับแต่ยังไม่ผ่านการทบทวนของแอดมิน (ได้ค่าเริ่มต้นจาก migration — story E3 / AC6)
   * = level ไม่ใช่ null และ setBy เป็น null
   */
  @Field({
    description:
      'true when the level came from the migration default and no admin has reviewed it yet',
  })
  needsReview!: boolean;
}

@ObjectType({ description: 'One care level change (admin only)' })
export class CareLevelChange {
  @Field(() => ID)
  id!: string;

  /** null = กำหนดครั้งแรก */
  @Field(() => CareLevel, {
    nullable: true,
    description: 'null = first assignment',
  })
  oldLevel!: CareLevel | null;

  /** เท่ากับ oldLevel ได้ = แอดมินยืนยันค่าเริ่มต้นจาก migration (ดู contract §4.2) */
  @Field(() => CareLevel)
  newLevel!: CareLevel;

  /** null = ระบบ (migration) */
  @Field(() => ID, { nullable: true })
  changedBy!: string | null;

  @Field(() => String, { nullable: true })
  changedByName!: string | null;

  /** เหตุผลที่แอดมินพิมพ์ — null สำหรับแถวที่ระบบเขียน (MIGRATION_DEFAULT / KYC_APPROVAL) */
  @Field(() => String, { nullable: true })
  reason!: string | null;

  @Field(() => CareLevelChangeSource)
  source!: CareLevelChangeSource;

  @Field()
  createdAt!: Date;
}

@InputType({
  description: 'Admin sets or changes the care level of a verified caregiver',
})
export class SetCaregiverCareLevelInput {
  @Field(() => ID)
  @IsUUID('4', { message: 'caregiverId ต้องเป็น UUID ที่ถูกต้อง' })
  caregiverId!: string;

  /**
   * "BASIC" | "INTERMEDIATE" | "ADVANCED"
   * ★ ชนิดเป็น String ไม่ใช่ enum CareLevel และ DTO เช็คแค่ "เป็นข้อความ" โดยตั้งใจ —
   *   ค่าผิดต้องไปถึง service เพื่อตอบ CARE_LEVEL_INVALID ตาม contract (เหตุผลเต็มใน care-level.errors.ts)
   */
  @Field(() => String, {
    nullable: true,
    description:
      'BASIC | INTERMEDIATE | ADVANCED (validated by the service: CARE_LEVEL_REQUIRED / CARE_LEVEL_INVALID)',
  })
  @IsOptional()
  @IsString()
  level?: string | null;

  /** บังคับเมื่อระดับจะเปลี่ยนจริง (ไม่ใช่ค่าเดิม) — ว่าง = CARE_LEVEL_REASON_REQUIRED */
  @Field(() => String, {
    nullable: true,
    description: `Required when the level actually changes (max ${CARE_LEVEL_REASON_MAX_LENGTH} chars)`,
  })
  @IsOptional()
  @IsString()
  @MaxLength(CARE_LEVEL_REASON_MAX_LENGTH, {
    message: `เหตุผลต้องไม่เกิน ${CARE_LEVEL_REASON_MAX_LENGTH} ตัวอักษร`,
  })
  reason?: string | null;
}

@ObjectType()
export class SetCaregiverCareLevelPayload {
  /** false = ส่งค่าเดิมที่แอดมินกำหนดไว้แล้ว → ไม่มีอะไรเปลี่ยน ไม่เพิ่มประวัติ (story E4) */
  @Field({
    description:
      'false when the same level was already set by an admin (no history row written)',
  })
  changed!: boolean;

  @Field(() => CaregiverCareLevelInfo)
  careLevel!: CaregiverCareLevelInfo;
}
