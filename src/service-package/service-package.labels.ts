import type { JobTypeValue } from '../identity/kyc/job-type/job-type-rules';

/** Presentation catalog only; packages/items/group membership always come from DB. */
export const SERVICE_TYPE_LABELS: Readonly<
  Record<JobTypeValue, { nameTh: string; nameEn: string }>
> = {
  general_care: { nameTh: 'ดูแลทั่วไป', nameEn: 'General care' },
  bedridden_care: { nameTh: 'ดูแลผู้ป่วยติดเตียง', nameEn: 'Bedridden care' },
  physiotherapy: { nameTh: 'กายภาพบำบัด', nameEn: 'Physiotherapy' },
  medication: { nameTh: 'ช่วยจัดการยา', nameEn: 'Medication assistance' },
  companion: { nameTh: 'เป็นเพื่อน/พูดคุย', nameEn: 'Companionship' },
};
