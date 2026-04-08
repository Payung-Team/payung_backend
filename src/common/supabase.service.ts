/**
 * SupabaseService — ตัวกลางสำหรับเชื่อมต่อกับ Supabase
 *
 * ทำไมต้องมี?
 * - เราใช้ Supabase เป็นระบบ Auth (login/register) และ Database
 * - แทนที่จะสร้าง Supabase client ใหม่ทุกครั้ง เราสร้างครั้งเดียวตรงนี้
 *   แล้วให้ service อื่นๆ เรียกใช้ผ่าน getClient()
 *
 * วิธีใช้ใน service อื่น:
 *   constructor(private supabaseService: SupabaseService) {}
 *   const supabase = this.supabaseService.getClient();
 *   await supabase.auth.signInWithPassword({ email, password });
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService {
  private client: SupabaseClient;

  constructor(private configService: ConfigService) {
    // อ่านค่า SUPABASE_URL และ SUPABASE_ANON_KEY จากไฟล์ .env
    // getOrThrow = ถ้าไม่มีค่า จะ throw error ทันที (ป้องกัน app รันโดยไม่มี config)
    const supabaseUrl = this.configService.getOrThrow<string>('SUPABASE_URL');
    const supabaseKey = this.configService.getOrThrow<string>('SUPABASE_ANON_KEY');

    // สร้าง Supabase client ครั้งเดียวตอน app เริ่มทำงาน
    this.client = createClient(supabaseUrl, supabaseKey);
  }

  /** ดึง Supabase client ไปใช้งาน (เช่น supabase.auth, supabase.from('table')) */
  getClient(): SupabaseClient {
    return this.client;
  }
}
