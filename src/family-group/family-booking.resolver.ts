import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { FamilyGroupService } from './family-group.service';
import { BookingService } from '../booking/booking.service';
import { BookingSummary } from '../booking/dto/booking-summary.types';
import { CreateBookingOnBehalfInput } from './dto/create-booking-on-behalf.input';
import { GroupCareRecipient } from './entities/care-recipient.entity';
import { GroupRole } from './decorators/group-role.decorator';
import { FamilyGroupGuard } from './guards/family-group.guard';
import { GROUP_ROLE } from './family-group.constants';
import {
  AuthUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';

/**
 * FamilyBookingResolver (PYG-424) — "จองแทน" สมาชิกในกลุ่มครอบครัว
 *
 * ── ทำไมแยกไฟล์จาก FamilyGroupResolver ────────────────────────────────────
 *   ไฟล์นั้นคือ CRUD ของ "ตัวกลุ่ม" (สร้าง/เปลี่ยนชื่อ/ลบ/สมาชิก)
 *   ไฟล์นี้คือ "สิ่งที่ทำได้เมื่ออยู่ในกลุ่ม" ซึ่งจะโตต่อไปอีก (PYG-421 ฟีดกิจกรรม ฯลฯ)
 *   แยกตั้งแต่ตอนนี้ถูกกว่ามาแยกทีหลังตอนไฟล์บวมแล้ว
 *
 * ── ทำไมไม่อยู่ใน BookingModule ทั้งที่เป็น mutation เรื่อง booking ─────────
 *   BookingResolver ติด @Roles(ROLE_ID.PATIENT) ทั้ง class
 *   แต่กลุ่มครอบครัวตั้งใจไม่จำกัด role ตั้งแต่ PYG-412 ("ผู้ใช้ที่ล็อกอินทุกคนสร้างกลุ่มได้"
 *   เพราะผู้ดูแลก็มีพ่อแม่ของตัวเองที่ต้องจองให้เหมือนกัน) ถ้าเอา mutation นี้ไปแปะไว้ที่นั่น
 *   ผู้ดูแลจะจองให้แม่ตัวเองไม่ได้ทั้งที่เป็นสมาชิกกลุ่มถูกต้อง
 *   → อยู่ที่นี่ และให้ "สมาชิกภาพในกลุ่ม" เป็นตัวตัดสินสิทธิ์แทน role ระดับระบบ
 *
 * ── ลำดับ guard (ห้ามสลับ เหมือน FamilyGroupResolver) ─────────────────────
 *   SupabaseAuthGuard → RolesGuard → FamilyGroupGuard
 *   RolesGuard อยู่ในโซ่ไว้เฉย ๆ — ไม่มี @Roles() ที่ไหนในไฟล์นี้ มันจึงปล่อยผ่าน
 *   วันที่ต้องจำกัด role จริง ๆ ค่อยเติม @Roles() ที่เมธอด ไม่ต้องรื้อโครง
 */
@Resolver()
@UseGuards(SupabaseAuthGuard, RolesGuard, FamilyGroupGuard)
export class FamilyBookingResolver {
  constructor(
    private readonly bookingService: BookingService,
    private readonly familyGroupService: FamilyGroupService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════
  //  Queries
  // ═══════════════════════════════════════════════════════════════════════

  @Query(() => [GroupCareRecipient], {
    description:
      'โปรไฟล์ผู้รับบริการทั้งหมดที่ถูกแชร์อยู่ในกลุ่มนี้ (เรียงตามชื่อ) — ใช้เติมตัวเลือก "จองให้ใคร". กลุ่มที่ยังไม่มีใครแชร์โปรไฟล์ = array ว่าง ไม่ใช่ error.',
  })
  @GroupRole(GROUP_ROLE.MEMBER) // guard อ่าน groupId จาก args.groupId
  async groupCareRecipients(
    @Args('groupId', { type: () => ID }) groupId: string,
  ): Promise<GroupCareRecipient[]> {
    return this.familyGroupService.groupCareRecipients(groupId);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Mutations
  // ═══════════════════════════════════════════════════════════════════════

  @Mutation(() => BookingSummary, {
    description:
      'จองผู้ดูแลแทนผู้รับบริการที่ถูกแชร์ไว้ในกลุ่มครอบครัว. ผู้เรียกต้องเป็นสมาชิก ACTIVE ของกลุ่ม (ไม่งั้น NOT_A_MEMBER) และโปรไฟล์ต้องอยู่ในกลุ่มเดียวกัน (ไม่งั้น RECIPIENT_NOT_IN_GROUP). ★ ยังไม่รวมขั้นตอนจ่ายเงิน — จ่ายเป็น step แยกเหมือนการจองปกติทุกประการ.',
  })
  @GroupRole(GROUP_ROLE.MEMBER) // guard อ่าน groupId จาก input.groupId ให้เอง
  async createBookingOnBehalf(
    @Args('input') input: CreateBookingOnBehalfInput,
    @CurrentUser() user: AuthUser,
  ): Promise<BookingSummary> {
    // userId มาจาก JWT ที่ Supabase เซ็นแล้ว ไม่ใช่จาก input — ปลอมไม่ได้
    // (กติกาเดียวกับทุก mutation ในโมดูลนี้)
    return this.bookingService.createBookingOnBehalf(user.id, input);
  }
}
