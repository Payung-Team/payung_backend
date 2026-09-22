/**
 * CommonModule — รวม service ที่ใช้ร่วมกันทั้งโปรเจกต์
 *
 * @Global() หมายความว่า:
 * - ทุก module ใน app สามารถใช้ SupabaseService และ PrismaService ได้เลย
 *   โดยไม่ต้อง import CommonModule ซ้ำ
 * - ถ้าไม่ใส่ @Global() ทุก module ที่อยากใช้ต้อง import CommonModule เอง
 *
 * providers = service ที่อยู่ใน module นี้
 * exports   = service ที่อนุญาตให้ module อื่นเรียกใช้ได้
 */
import { Global, Module } from '@nestjs/common';
import { SupabaseService } from './supabase.service';
import { PrismaService } from './prisma.service';
import { ClockService } from './clock.service';
import { PayoutEncryptionService } from './crypto/payout-encryption.service';
import { AvatarUrlService } from './avatar-url.service';

@Global()
@Module({
  // PayoutEncryptionService (PYG-307): AES-GCM ของเลขบัญชีรับเงิน
  // AvatarUrlService: sign storage path ของรูปโปรไฟล์ (bucket private) ให้ <img> โหลดได้
  providers: [SupabaseService, PrismaService, ClockService, PayoutEncryptionService, PayoutEncryptionService, AvatarUrlService],
  exports: [SupabaseService, PrismaService, ClockService, PayoutEncryptionService, PayoutEncryptionService, AvatarUrlService],
})
export class CommonModule {}
