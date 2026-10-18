import { UseGuards } from '@nestjs/common';
import { Args, Query, Resolver } from '@nestjs/graphql';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { CareSkillService } from './care-skill.service';
import { CareSkillItem } from './entities/care-skill.entity';

/**
 * careSkills — รายการทักษะกลางที่วิชาชีพหนึ่งเลือกได้ (PYG-652)
 *
 * ใช้ในหน้า KYC และหน้าแก้โปรไฟล์ของผู้ดูแล รวมถึงหน้าที่แสดงชื่อทักษะ
 * ต้องล็อกอินแต่ไม่จำกัด role — รายการทักษะไม่ใช่ข้อมูลส่วนตัว
 *
 * @example
 * query {
 *   careSkills(profession: "nurse") { code nameTh nameEn }
 * }
 */
@Resolver(() => CareSkillItem)
@UseGuards(SupabaseAuthGuard)
export class CareSkillResolver {
  constructor(private readonly careSkillService: CareSkillService) {}

  @Query(() => [CareSkillItem], {
    description:
      'Central caregiver skills a profession may hold: general_caregiver | nurse | physiotherapist. ' +
      'Basic skills first, then profession-specific ones.',
  })
  careSkills(
    @Args('profession', {
      description: 'general_caregiver | nurse | physiotherapist',
    })
    profession: string,
  ): Promise<CareSkillItem[]> {
    return this.careSkillService.listForProfession(profession);
  }
}
