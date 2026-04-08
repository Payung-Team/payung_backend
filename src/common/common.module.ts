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
import { SupabaseStorageService } from './supabase-storage.service';

@Global()
@Module({
  providers: [SupabaseService, PrismaService, SupabaseStorageService],
  exports: [SupabaseService, PrismaService, SupabaseStorageService],
})
export class CommonModule {}
