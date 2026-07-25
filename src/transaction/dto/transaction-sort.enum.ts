import { registerEnumType } from '@nestjs/graphql';

/**
 * PYG-333 — ตัวเลือกการเรียงลำดับรายการ transaction
 *
 * default = created_desc (ใหม่สุดก่อน) ตามที่หน้า admin dashboard ต้องการ
 * amount_* ใช้สำหรับดูรายการยอดสูง/ต่ำสุด
 */
export enum TransactionSortBy {
  created_desc = 'created_desc',
  created_asc = 'created_asc',
  amount_desc = 'amount_desc',
  amount_asc = 'amount_asc',
}

registerEnumType(TransactionSortBy, {
  name: 'TransactionSortBy',
  description:
    'การเรียง transaction — default created_desc (ใหม่สุดก่อน) (PYG-333)',
});
