import { registerEnumType } from '@nestjs/graphql';

/**
 * PYG-316: ใครเป็นผู้ยื่น dispute
 * ค่าตรงกับ column bookings.dispute_filed_by
 * ตอนนี้มีแต่ 'customer' (patient) ที่ flag ได้ — 'caregiver' เผื่ออนาคต
 */
export enum DisputeFiledBy {
  customer = 'customer',
  caregiver = 'caregiver',
}

registerEnumType(DisputeFiledBy, {
  name: 'DisputeFiledBy',
  description: 'ผู้ยื่น dispute: customer (patient) หรือ caregiver (PYG-316)',
});
