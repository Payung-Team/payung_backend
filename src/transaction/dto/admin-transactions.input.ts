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
import { TransactionType } from '../entities/transaction-type.enum';
import { TransactionSortBy } from './transaction-sort.enum';

/**
 * AdminTransactionsInput — query params ของ admin transactions list/summary (PYG-333)
 *
 * ทุก field optional — ไม่ส่งอะไรเลย = ทุก transaction (payment + payout + refund)
 * เรียง created_desc (ใหม่สุดก่อน)
 *
 * mapping กับ REST spec ในตั๋ว: type, status, date_from, date_to, q, sort_by, page, limit
 * หมายเหตุ: ใช้ input ตัวเดียวกันทั้ง list และ summary — summary จะไม่สนใจ page/limit
 */
@InputType()
export class AdminTransactionsInput {
  // กรองตามประเภท — ไม่ส่ง = ทุกประเภท
  @Field(() => TransactionType, { nullable: true })
  @IsOptional()
  @IsEnum(TransactionType)
  type?: TransactionType;

  // กรองตามสถานะ (payment: pending/held/captured/... | payout: scheduled/paid/failed/...)
  // ควรใช้คู่กับ type เพราะสถานะ 2 ฝั่งเป็นคนละชุด
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  status?: string;

  // ช่วงวันที่ตาม created_at: date_from = ตั้งแต่, date_to = ถึง
  @Field({ nullable: true })
  @IsOptional()
  @IsDate()
  dateFrom?: Date;

  @Field({ nullable: true })
  @IsOptional()
  @IsDate()
  dateTo?: Date;

  // search: booking id (UUID), omise id (charge/transfer), หรือ ชื่อ/อีเมล ของคู่กรณี
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  // การเรียง — default created_desc
  @Field(() => TransactionSortBy, { nullable: true })
  @IsOptional()
  @IsEnum(TransactionSortBy)
  sortBy?: TransactionSortBy;

  // pagination (ใช้เฉพาะ list; summary จะเมิน)
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
