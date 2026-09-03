import { Field, ID, InputType, Int } from '@nestjs/graphql';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import {
  GROUP_MAX_MEMBERS,
  JOIN_LINK_TTL_HOURS,
} from '../family-group.constants';

/**
 * CreateJoinLinkInput (PYG-416) — ตัวเลือกตอนสร้าง/หมุนลิงก์
 *
 * ทั้งสองฟิลด์เป็น optional โดยตั้งใจ: หน้าจอปกติของ PYG-418 จะไม่ส่งอะไรมาเลย
 * แล้วให้ค่า default จาก env (PYG-428) ทำงาน ส่วนช่องให้กรอกเองเป็นของ advanced
 *
 * ★ เพดานบนของทั้งคู่ผูกกับค่า config ไม่ใช่เลขลอย ๆ
 *   เพราะถ้าปล่อยให้ตั้ง ttlHours = 87600 (10 ปี) ได้ ลิงก์ที่หลุดจะอยู่ตลอดกาล
 *   ซึ่งย้อนแย้งกับเหตุผลทั้งหมดที่เรากำหนดวันหมดอายุตั้งแต่แรก
 */
@InputType()
export class CreateJoinLinkInput {
  @Field(() => ID, {
    description: 'กลุ่มที่จะสร้างลิงก์ — ต้องเป็นเจ้าของกลุ่ม',
  })
  @IsUUID()
  groupId: string;

  @Field(() => Int, {
    nullable: true,
    description: `อายุลิงก์เป็นชั่วโมง — ไม่ส่งมาจะใช้ค่า default (${JOIN_LINK_TTL_HOURS} ชม.)`,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(JOIN_LINK_TTL_HOURS)
  ttlHours?: number;

  @Field(() => Int, {
    nullable: true,
    description: `จำนวนคนสูงสุดที่เข้าได้ด้วยลิงก์ใบนี้ — ไม่ส่งมาจะใช้ค่า default จาก config`,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(GROUP_MAX_MEMBERS)
  maxUses?: number;
}
