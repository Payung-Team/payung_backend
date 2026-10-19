/**
 * ProfessionChangeResolver — ผู้ดูแลขอเปลี่ยนวิชาชีพหลัง KYC อนุมัติ (PYG-575 · S01-AC6 · contract PYG-573 §4)
 *
 * ชื่อ operation ตรงกับ FE src/graphql/professionChange.ts ทุกตัว:
 * - myProfessionChangeRequest              — คำขอล่าสุดของตัวเอง (null = ไม่เคยขอ)
 * - requestProfessionChange(input)         — ยื่นคำขอ (วิชาชีพยังไม่เปลี่ยนจนแอดมินอนุมัติ)
 * - cancelProfessionChangeRequest(id)      — ยกเลิกคำขอที่ยังรอตรวจ
 *
 * ฝั่งแอดมิน (คิว / อนุมัติ / ปฏิเสธ) อยู่ที่ src/admin/admin-profession-change.resolver.ts
 * Guards: SupabaseAuthGuard + RolesGuard — ผู้ดูแล (role 2) เท่านั้น
 */
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { ROLE_ID } from '../../common/constants/roles.constant';
import {
  AuthUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { ProfessionChangeService } from './profession-change.service';
import { ProfessionChangeRequest } from './entities/profession-change-request.entity';
import { ProfessionChangeInput } from './dto/profession-change.input';

@Resolver()
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles(ROLE_ID.CAREGIVER)
export class ProfessionChangeResolver {
  constructor(
    private readonly professionChangeService: ProfessionChangeService,
  ) {}

  /**
   * query { myProfessionChangeRequest { id fromProfession toProfession status rejectionReason requestedAt reviewedAt } }
   */
  @Query(() => ProfessionChangeRequest, {
    nullable: true,
    description:
      'Caregiver: latest profession change request of the logged-in caregiver (null = never requested)',
  })
  async myProfessionChangeRequest(
    @CurrentUser() user: AuthUser,
  ): Promise<ProfessionChangeRequest | null> {
    return this.professionChangeService.myRequest(user);
  }

  /**
   * mutation { requestProfessionChange(input: { profession: "nurse" }) { id status } }
   * error: PROFESSION_REQUIRED / PROFESSION_INVALID / PROFESSION_CHANGE_NOT_ALLOWED /
   *        PROFESSION_CHANGE_ALREADY_PENDING / PROFESSION_UNCHANGED
   */
  @Mutation(() => ProfessionChangeRequest, {
    description:
      'Caregiver (KYC verified): request a profession change. The profession stays the same until an admin approves.',
  })
  async requestProfessionChange(
    @CurrentUser() user: AuthUser,
    @Args('input') input: ProfessionChangeInput,
  ): Promise<ProfessionChangeRequest> {
    return this.professionChangeService.requestChange(user, input);
  }

  /**
   * mutation { cancelProfessionChangeRequest(id: "...") { id status } }
   * error: PROFESSION_CHANGE_NOT_FOUND / PROFESSION_CHANGE_NOT_PENDING
   */
  @Mutation(() => ProfessionChangeRequest, {
    description: 'Caregiver: cancel own pending profession change request',
  })
  async cancelProfessionChangeRequest(
    @CurrentUser() user: AuthUser,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<ProfessionChangeRequest> {
    return this.professionChangeService.cancel(user, id);
  }
}
