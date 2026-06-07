/**
 * UserService — Business logic สำหรับจัดการข้อมูล users table
 *
 * ทำไมแยก UserService ออกจาก AuthService?
 * - AuthService = จัดการ authentication flow (login/register กับ Supabase Auth)
 * - UserService = จัดการ CRUD ของ users table ในฐานข้อมูลของเรา
 * - Single Responsibility: แต่ละ service มีหน้าที่ชัดเจน
 * - UserService สามารถถูก inject ไปใช้ใน module อื่นได้ เช่น ProfileModule, AdminModule
 *
 * ทุก method ใช้ PrismaService เพราะ codebase นี้ใช้ Prisma เป็น ORM หลัก
 * (ไม่ query Supabase โดยตรง เพราะ Prisma จัดการ type-safety และ schema ให้)
 */
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { User } from './entities/user.entity';

/** Shape ของ user ที่ Prisma คืนมา → map เป็น GraphQL User entity */
type PrismaUser = {
  id: string;
  supabaseUid: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  phone: string | null;
  address: string | null;
  bio: string | null;
  role: number;
  isActive: boolean;
  is_deleted: boolean;
  must_change_password: boolean;
  emailPreferences: boolean;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class UserService {
  constructor(private prismaService: PrismaService) {}

  // ─── Private helper ──────────────────────────────────────────────────────
  /**
   * แปลง Prisma User (null fields) → GraphQL User entity (undefined fields)
   * เหตุผล: GraphQL ใช้ undefined สำหรับ optional fields, Prisma ใช้ null
   */
  private mapToEntity(user: PrismaUser): User {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName ?? undefined,
      avatarUrl: user.avatarUrl ?? undefined,
      phone: user.phone ?? undefined,
      address: user.address ?? undefined,
      bio: user.bio ?? undefined,
      role: user.role,
      isActive: user.isActive,
      isSuspended: !user.isActive || user.is_deleted,
      mustChangePassword: user.must_change_password,
      emailPreferences: user.emailPreferences,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  // ─── Public methods ───────────────────────────────────────────────────────

  /**
   * ค้นหา user จาก Supabase UID
   *
   * ใช้เมื่อ: ได้รับ JWT token จาก client → decode → ได้ supabase_uid
   * → ต้องการดึงข้อมูล user จาก database ของเรา
   *
   * @param uid - supabase_uid (UUID จาก Supabase Auth)
   * @throws NotFoundException ถ้าไม่พบ user
   */
  async findBySupabaseUid(uid: string): Promise<User> {
    const user = await this.prismaService.user.findUnique({
      where: { supabaseUid: uid },
    });

    if (!user) {
      throw new NotFoundException(`User with Supabase UID "${uid}" not found`);
    }

    return this.mapToEntity(user);
  }

  /**
   * ค้นหา user จาก internal ID (UUID ในตาราง users ของเรา)
   *
   * ใช้เมื่อ: frontend ส่ง userId มาเพื่อดูโปรไฟล์ หรือ admin ดูข้อมูล user
   *
   * @param id - users.id (ไม่ใช่ supabase_uid)
   * @throws NotFoundException ถ้าไม่พบ user
   */
  async findById(id: string): Promise<User> {
    const user = await this.prismaService.user.findUnique({
      where: { id },
    });

    if (!user) {
      throw new NotFoundException(`User with ID "${id}" not found`);
    }

    return this.mapToEntity(user);
  }

  /**
   * สร้าง user ใหม่ใน users table
   *
   * ใช้เมื่อ: หลังจาก Supabase Auth สร้าง user สำเร็จ (ใน AuthService.register)
   * จะแยก method นี้ออกมาเพื่อให้ AuthService เรียกใช้ได้
   *
   * displayName default = prefix ของ email (เช่น "john" จาก "john@example.com")
   *
   * @param supabaseUid - UUID จาก Supabase Auth
   * @param email       - email ของ user
   * @param role        - "patient" | "caregiver" (role name string)
   * @throws InternalServerErrorException ถ้า insert ล้มเหลว
   */
  async createUser(
    supabaseUid: string,
    email: string,
    role: number,
  ): Promise<User> {
    try {
      const user = await this.prismaService.user.create({
        data: {
          supabaseUid,
          email,
          role,
          displayName: email.split('@')[0], // "john" จาก "john@example.com"
          isActive: true,
        },
      });

      return this.mapToEntity(user);
    } catch (error) {
      // Prisma error P2002 = unique constraint failed (email หรือ supabaseUid ซ้ำ)
      if ((error as { code?: string }).code === 'P2002') {
        throw new InternalServerErrorException(
          'User already exists in the system',
        );
      }
      throw new InternalServerErrorException('Failed to create user record');
    }
  }

  /**
   * อัปเดตโปรไฟล์ user (displayName, phone, address, bio, avatarUrl)
   *
   * ใช้เมื่อ: user แก้ไขโปรไฟล์ตัวเอง เช่น เปลี่ยนชื่อหรือเพิ่มข้อมูลส่วนตัว
   * รับเฉพาะ fields ที่จะอัปเดต (partial update) — fields ที่ไม่ส่งมาจะไม่เปลี่ยน
   *
   * @param id      - users.id ของ user ที่ต้องการอัปเดต
   * @param updates - object ที่มี displayName, phone, address, bio, avatarUrl
   * @throws NotFoundException ถ้าไม่พบ user
   */
  async updateProfile(
    id: string,
    updates: {
      displayName?: string;
      phone?: string;
      address?: string;
      bio?: string;
      avatarUrl?: string;
    },
  ): Promise<User> {
    // ตรวจสอบว่า user มีอยู่จริงก่อน
    await this.findById(id);

    const user = await this.prismaService.user.update({
      where: { id },
      data: {
        // undefined fields จะถูก Prisma ข้ามไป (ไม่อัปเดต)
        ...(updates.displayName !== undefined && {
          displayName: updates.displayName,
        }),
        ...(updates.phone !== undefined && {
          phone: updates.phone,
        }),
        ...(updates.address !== undefined && {
          address: updates.address,
        }),
        ...(updates.bio !== undefined && {
          bio: updates.bio,
        }),
        ...(updates.avatarUrl !== undefined && {
          avatarUrl: updates.avatarUrl,
        }),
        // updatedAt อัปเดตอัตโนมัติ เพราะ @updatedAt ใน Prisma schema
      },
    });

    return this.mapToEntity(user);
  }

  /**
   * อัปเดตการรับ email notification (PYG-97)
   *
   * ใช้เมื่อ: user เปิด/ปิดการรับอีเมลแจ้งเตือนใน settings
   * - true  = รับอีเมล (KYC submitted/verified/rejected ฯลฯ)
   * - false = EmailService จะ skip การส่ง email ทุกประเภท
   *
   * @param id      - users.id
   * @param enabled - true = รับ, false = ไม่รับ
   * @throws NotFoundException ถ้าไม่พบ user
   */
  async updateEmailPreference(id: string, enabled: boolean): Promise<User> {
    await this.findById(id);

    const user = await this.prismaService.user.update({
      where: { id },
      data: { emailPreferences: enabled },
    });

    return this.mapToEntity(user);
  }

  /**
   * completePasswordChange — ล้าง must_change_password flag หลังจาก user เปลี่ยน password แล้ว
   *
   * ใช้เมื่อ: FE เรียก supabase.auth.updateUser({ password }) สำเร็จแล้ว
   *          จากนั้น call mutation นี้เพื่อบอก BE ว่าเปลี่ยนเรียบร้อย
   *
   * @throws BadRequestException ถ้า must_change_password เป็น false อยู่แล้ว
   */
  async completePasswordChange(userId: string): Promise<User> {
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException(`User with ID "${userId}" not found`);
    }

    if (!user.must_change_password) {
      throw new BadRequestException('Password change not required');
    }

    const updated = await this.prismaService.user.update({
      where: { id: userId },
      data: { must_change_password: false },
    });

    return this.mapToEntity(updated);
  }

  /**
   * updateLastLogin — บันทึกเวลา login ล่าสุด (fire-and-forget)
   */
  async updateLastLogin(userId: string): Promise<void> {
    await this.prismaService.user.update({
      where: { id: userId },
      data: { last_login_at: new Date() },
    });
  }
}
