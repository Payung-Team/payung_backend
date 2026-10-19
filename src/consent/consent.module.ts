/**
 * ConsentModule — PDPA consent
 *
 * ConsentPolicyService (PYG-472)       = ขาอ่าน — ข้อความและเวอร์ชันที่บังคับใช้อยู่
 * ConsentService (PYG-538 · PYG-474)   = ขาตรวจและเขียนลง user_consents + อ่านความยินยอมล่าสุด
 */
import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { ConsentPolicyService } from './consent-policy.service';
import { ConsentService } from './consent.service';
import { ConsentResolver } from './consent.resolver';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';

@Module({
  imports: [CommonModule],
  providers: [
    ConsentPolicyService,
    ConsentService,
    ConsentResolver,
    // PYG-474: query myConsents ต้อง login — guard ใช้ SupabaseService + PrismaService
    // จาก CommonModule (@Global) จึงประกาศเป็น provider ในโมดูลนี้ได้เลย เหมือนโมดูลอื่น
    SupabaseAuthGuard,
  ],
  // export ไว้ให้ AuthModule (PYG-538 consent ตอน Onboarding · PYG-474 consent ตอน register)
  // และ PYG-507 เอาไปตรวจว่า "ยินยอมข้อมูลชีวภาพแล้วหรือยัง" ก่อนรับรูปใบหน้า
  exports: [ConsentPolicyService, ConsentService],
})
export class ConsentModule {}
