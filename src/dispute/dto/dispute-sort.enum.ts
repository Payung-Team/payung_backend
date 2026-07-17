import { registerEnumType } from '@nestjs/graphql';

/**
 * PYG-316: ตัวเลือกการเรียงลำดับ admin dispute queue
 *
 * SLA ของแต่ละ dispute = filed_at + ค่าคงที่ (DISPUTE_SLA_HOURS) เท่ากันทุก row
 * → เรียงตาม "SLA ใกล้ครบกำหนด" = เรียงตาม filed_at นั่นเอง
 *   sla_asc  = filed เก่าสุดก่อน (ใกล้ครบ SLA สุด → ด่วนสุด)  ← default ตาม ticket
 *   sla_desc = filed ใหม่สุดก่อน (เพิ่งยื่น)
 */
export enum DisputeSortBy {
  sla_asc = 'sla_asc',
  sla_desc = 'sla_desc',
}

registerEnumType(DisputeSortBy, {
  name: 'DisputeSortBy',
  description:
    'การเรียงลำดับ dispute queue — default sla_asc (ด่วนสุดก่อน) (PYG-316)',
});
