import { Field, InputType, Int } from '@nestjs/graphql';
import {
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { DisputeStatus } from '../entities/dispute-status.enum';
import { DisputeFiledBy } from '../entities/dispute-filed-by.enum';
import { DisputeSortBy } from './dispute-sort.enum';

/**
 * AdminDisputesInput — query params ของ admin dispute queue (PYG-316)
 *
 * ทุก field เป็น optional — ไม่ส่งอะไรเลย = queue ทั้งหมด (ทุก dispute) เรียงตาม SLA ด่วนสุดก่อน
 * mapping กับ REST spec ในตั๋ว: status, date_from, date_to, filed_by, q, sort_by, page, limit
 */
@InputType()
export class AdminDisputesInput {
  // filter ตามสถานะ — ไม่ส่ง = แสดงทุก dispute (flagged + resolved, ไม่รวม 'none')
  @Field(() => DisputeStatus, { nullable: true })
  @IsOptional()
  @IsEnum(DisputeStatus)
  disputeStatus?: DisputeStatus;

  // filter ช่วงวันที่ยื่น (filed_at) — date_from = ตั้งแต่, date_to = ถึง
  @Field({ nullable: true })
  @IsOptional()
  @IsDate()
  dateFrom?: Date;

  @Field({ nullable: true })
  @IsOptional()
  @IsDate()
  dateTo?: Date;

  // filter ตามประเภทผู้ยื่น (customer / caregiver)
  @Field(() => DisputeFiledBy, { nullable: true })
  @IsOptional()
  @IsEnum(DisputeFiledBy)
  filedBy?: DisputeFiledBy;

  // search: dispute/booking id (UUID) หรือ ชื่อ/อีเมลผู้ใช้
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  // การเรียงลำดับ — default sla_asc (ด่วนสุดก่อน)
  @Field(() => DisputeSortBy, { nullable: true })
  @IsOptional()
  @IsEnum(DisputeSortBy)
  sortBy?: DisputeSortBy;

  // pagination
  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
