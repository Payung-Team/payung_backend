/**
 * AuthService — Business logic สำหรับ Authentication (login, register, logout)
 *
 * ทำไมแยก Service ออกจาก Resolver?
 * - Resolver = ตัวรับ GraphQL request (เหมือนพนักงานต้อนรับ)
 * - Service  = ตัวทำงานจริง (เหมือนพ่อครัว)
 * - แยกกันทำให้โค้ดเป็นระเบียบ ง่ายต่อการ test และ maintain
 *
 * Flow การ login:
 *   Client ส่ง email+password → Resolver รับ → Service ทำงาน:
 *   1. ส่ง email+password ไป Supabase Auth ตรวจสอบ
 *   2. ถ้าถูกต้อง → ได้ session (token) กลับมา
 *   3. ใช้ supabase_uid ไปหา user ในตาราง users ของเรา
 *   4. ส่ง { accessToken, refreshToken, user } กลับไปให้ client
 */
import {
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase.service';
import { PrismaService } from '../../common/prisma.service';
import { LoginInput } from './dto/login.input';
import { AuthPayload } from '../models/auth-payload.model';

@Injectable()
export class AuthService {
  constructor(
    private supabaseService: SupabaseService,
    private prismaService: PrismaService,
  ) {}

  /**
   * Login ด้วย email + password
   * @param input - { email, password } ที่ client ส่งมา
   * @returns AuthPayload - { accessToken, refreshToken, user }
   * @throws UnauthorizedException - ถ้า email/password ไม่ถูกต้อง หรือไม่เจอ user
   */
  async login(input: LoginInput): Promise<AuthPayload> {
    const supabase = this.supabaseService.getClient();

    // ขั้นตอนที่ 1: ส่ง email+password ไปให้ Supabase Auth ตรวจสอบ
    // signInWithPassword จะเช็คว่า email นี้มีอยู่จริงไหม และ password ตรงไหม
    // ถ้าถูกต้อง → ได้ data.session (มี access_token + refresh_token)
    // ถ้าผิด → ได้ error กลับมา
    const { data, error } = await supabase.auth.signInWithPassword({
      email: input.email,
      password: input.password,
    });

    // ขั้นตอนที่ 2: ถ้า Supabase บอกว่า login ไม่ผ่าน → โยน error กลับไปบอก client
    if (error || !data.session) {
      throw new UnauthorizedException('Invalid email or password');
    }

    // ขั้นตอนที่ 3: ดึงข้อมูล user จาก database ของเรา
    // ทำไมต้องดึงจาก DB ของเราด้วย?
    // → เพราะ Supabase Auth เก็บแค่ email+password
    //   แต่เราต้องการข้อมูลเพิ่ม เช่น role, displayName, isActive
    //   ซึ่งเก็บในตาราง users ของเรา
    // data.user.id คือ supabase_uid ที่เราใช้เชื่อมโยงกับ user ในระบบเรา
    const user = await this.prismaService.user.findUnique({
      where: { supabaseUid: data.user.id },
    });

    // ขั้นตอนที่ 4: ถ้าไม่เจอ user ในตาราง users ของเรา
    // → แปลว่า Supabase มี account นี้ แต่ยังไม่เคย register ผ่านระบบเรา
    //   (เช่น สร้าง user ตรงใน Supabase dashboard โดยไม่ผ่าน register mutation)
    if (!user) {
      throw new UnauthorizedException('User account not found');
    }

    // ขั้นตอนที่ 5: ส่งผลลัพธ์กลับให้ client
    // - accessToken: ใช้แนบไปกับทุก request เพื่อยืนยันตัวตน (มีอายุสั้น ~1 ชม.)
    // - refreshToken: ใช้ขอ accessToken ใหม่เมื่อหมดอายุ (มีอายุยาวกว่า)
    // - user: ข้อมูล user สำหรับแสดงใน frontend
    return {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName ?? undefined, // Prisma ส่ง null มา แต่ GraphQL ต้องการ undefined
        avatarUrl: user.avatarUrl ?? undefined,     // เช่นเดียวกัน — แปลง null → undefined
        role: user.role,
        isActive: user.isActive,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
    };
  }
}
