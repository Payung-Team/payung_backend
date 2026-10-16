/**
 * CareSkillModule — ทักษะกลางของผู้ดูแล (PYG-652)
 *
 * CareSkillService  = รายการทักษะตามวิชาชีพ + ตรวจทักษะก่อนบันทึก (KycModule ใช้)
 * CareSkillResolver = careSkills(profession)
 */
import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { CareSkillService } from './care-skill.service';
import { CareSkillResolver } from './care-skill.resolver';

@Module({
  imports: [CommonModule],
  providers: [CareSkillService, CareSkillResolver, SupabaseAuthGuard],
  exports: [CareSkillService],
})
export class CareSkillModule {}
