/**
 * ConsentModule — PDPA consent
 *
 * ConsentPolicyService (PYG-472) = ขาอ่าน — ข้อความและเวอร์ชันที่บังคับใช้อยู่
 * ConsentService (PYG-538)       = ขาตรวจและเขียนลง user_consents
 */
import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { ConsentPolicyService } from './consent-policy.service';
import { ConsentService } from './consent.service';
import { ConsentResolver } from './consent.resolver';

@Module({
  imports: [CommonModule],
  providers: [ConsentPolicyService, ConsentService, ConsentResolver],
  // export ไว้ให้ AuthModule (PYG-538 — consent ตอน Onboarding), PYG-474 (ตอน register)
  // และ PYG-507 เอาไปตรวจว่า "ยินยอมข้อมูลชีวภาพแล้วหรือยัง" ก่อนรับรูปใบหน้า
  exports: [ConsentPolicyService, ConsentService],
})
export class ConsentModule {}
