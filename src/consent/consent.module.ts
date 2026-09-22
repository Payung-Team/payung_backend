/**
 * ConsentModule — PDPA consent (PYG-472)
 *
 * รอบนี้มีแต่ "ขาอ่าน" (ข้อความ + เวอร์ชัน) · ขาเขียนลง user_consents เป็นของ PYG-474
 * ซึ่งจะเพิ่ม service ในโมดูลนี้ แล้ว import ConsentPolicyService ไปตรวจเวอร์ชัน
 */
import { Module } from '@nestjs/common';
import { ConsentPolicyService } from './consent-policy.service';
import { ConsentResolver } from './consent.resolver';

@Module({
  providers: [ConsentPolicyService, ConsentResolver],
  // export ไว้ให้ PYG-474 (บันทึก consent ตอน register) และ PYG-498/507
  // เอาไปตรวจว่า "ยินยอมข้อมูลสุขภาพ/ชีวภาพแล้วหรือยัง" ก่อนรับข้อมูล
  exports: [ConsentPolicyService],
})
export class ConsentModule {}
