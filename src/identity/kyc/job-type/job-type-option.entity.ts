/**
 * JobTypeOption — 1 ประเภทงานในรายการที่ผู้ดูแลเลือกได้ (PYG-590 · S04-AC1..AC4)
 * ส่งครบ 5 ค่าเสมอ รวมที่เลือกไม่ได้ เพื่อให้ FE ตัดสินว่าจะซ่อนหรือแสดงแบบปิด
 */
import { Field, ObjectType, registerEnumType } from '@nestjs/graphql';
import { JOB_TYPE_BLOCKED_REASON } from './job-type-rules';

export enum JobTypeBlockedReasonEnum {
  PROFESSION_MISMATCH = 'PROFESSION_MISMATCH',
  LICENSE_NOT_APPROVED = 'LICENSE_NOT_APPROVED',
  LICENSE_EXPIRED = 'LICENSE_EXPIRED',
}

// กันค่า enum ของ GraphQL เพี้ยนจากค่าคงที่ของตัวตรวจ
const _sync: Record<keyof typeof JOB_TYPE_BLOCKED_REASON, JobTypeBlockedReasonEnum> =
  JobTypeBlockedReasonEnum;
void _sync;

registerEnumType(JobTypeBlockedReasonEnum, {
  name: 'JobTypeBlockedReason',
  description:
    'Why a job type cannot be selected. Precedence when several apply: ' +
    'PROFESSION_MISMATCH, then LICENSE_NOT_APPROVED, then LICENSE_EXPIRED. Clients must fall back for unknown values.',
});

@ObjectType()
export class JobTypeOption {
  @Field({ description: 'general_care | bedridden_care | companion | medication | physiotherapy' })
  jobType!: string;

  @Field()
  selectable!: boolean;

  @Field(() => JobTypeBlockedReasonEnum, { nullable: true, description: 'null when selectable' })
  blockedReason?: JobTypeBlockedReasonEnum | null;
}
