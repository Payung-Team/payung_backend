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
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { ROLE_ID } from '../../common/constants/roles.constant';
import { toCareRecipientColumns } from '../../patient/patient-profile.mapper';
import { User } from './entities/user.entity';
import { CompleteOnboardingInput } from './dto/complete-onboarding.input';

/** Shape ของ user ที่ Prisma คืนมา → map เป็น GraphQL User entity */
type PrismaUser = {
  id: string;
  supabaseUid: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  phone: string | null;
  address: string | null;
  subDistrict: string | null;
  district: string | null;
  province: string | null;
  postalCode: string | null;
  bio: string | null;
  role: number;
  isActive: boolean;
  is_deleted: boolean;
  must_change_password: boolean;
  emailPreferences: boolean;
  createdAt: Date;
  updatedAt: Date;
  /** PYG-497 — เก็บตอน Onboarding (บัญชีเก่าที่สมัครก่อนหน้านั้นยังเป็น null) */
  firstName: string | null;
  lastName: string | null;
};

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

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
      // PYG-497/498: ชื่อจริงจาก Onboarding — แยกจาก displayName ที่เป็นแค่ชื่อแสดง
      firstName: user.firstName ?? undefined,
      lastName: user.lastName ?? undefined,
      avatarUrl: user.avatarUrl ?? undefined,
      phone: user.phone ?? undefined,
      address: user.address ?? undefined,
      subDistrict: user.subDistrict ?? undefined,
      district: user.district ?? undefined,
      province: user.province ?? undefined,
      postalCode: user.postalCode ?? undefined,
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
      subDistrict?: string;
      district?: string;
      province?: string;
      postalCode?: string;
    },
  ): Promise<User> {
    // PYG-507: เลิกรับ avatarUrl ทางนี้ — เดิมรับ URL อะไรก็ได้ที่ผ่าน @IsUrl แล้วแสดงทันที
    //   ผู้ดูแลจึงตั้งรูปเองได้โดยไม่ผ่านแอดมิน (ขัดกับ PYG-488)
    //   ตอบ 400 แทนการเงียบ ๆ ไม่เขียน เพื่อให้ FE รุ่นเก่ารู้ว่าต้องย้ายไป endpoint อัปโหลด
    if (updates.avatarUrl !== undefined) {
      throw new BadRequestException(
        'เปลี่ยนรูปโปรไฟล์ผ่าน updateProfile ไม่ได้แล้ว — อัปโหลดที่ POST /api/v1/profile/photo',
      );
    }

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
        ...(updates.subDistrict !== undefined && {
          subDistrict: updates.subDistrict,
        }),
        ...(updates.district !== undefined && {
          district: updates.district,
        }),
        ...(updates.province !== undefined && {
          province: updates.province,
        }),
        ...(updates.postalCode !== undefined && {
          postalCode: updates.postalCode,
        }),
        ...(updates.bio !== undefined && {
          bio: updates.bio,
        }),
        // PYG-507: ไม่มีการเขียน avatarUrl ที่นี่แล้ว — ตอบ 400 ไปตั้งแต่ต้นเมธอด
        //   รูปโปรไฟล์เปลี่ยนผ่าน POST /api/v1/profile/photo ทางเดียว
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

  // ─── Onboarding ผู้สูงอายุ (PYG-498) ──────────────────────────────────────

  /**
   * ผู้ใช้คนนี้ผ่าน Onboarding แล้วหรือยัง
   *
   * ★ คำนวณจากข้อมูลจริงทุกครั้ง ไม่เก็บเป็น flag แยก
   *   ถ้าเป็น flag แล้ววันหนึ่งโปรไฟล์ถูกลบหรือถูกแก้จนข้อมูลไม่ครบ flag จะยังเป็น true
   *   ผู้ใช้จะเข้าหน้าจองแล้วเจอฟอร์มที่เติมข้อมูลไม่ครบโดยไม่มีอะไรบอกว่าเกิดอะไรขึ้น
   *
   * ครบ = มีโปรไฟล์ is_self ที่ยังไม่ถูกลบ และมี date_of_birth + gender + mobility_level
   *   สามช่องนี้คือช่องบังคับของฟอร์ม Onboarding (อายุ / เพศ / ระดับการช่วยเหลือ)
   *   ส่วนชื่อ-นามสกุลไม่ต้องเช็คซ้ำ เพราะสร้างโปรไฟล์ไม่ได้เลยถ้าไม่มีชื่อ
   *
   * role อื่นคืน true เสมอ — ผู้ดูแล/แอดมินไม่ได้เป็นผู้รับบริการ ไม่มีหน้า Onboarding นี้
   * ถ้าคืน false จะทำให้ FE เด้งผู้ดูแลเข้าหน้าที่เขากรอกไม่ได้แล้ววนไม่จบ
   */
  async isOnboardingCompleted(userId: string, role: number): Promise<boolean> {
    if (role !== ROLE_ID.PATIENT) return true;

    const profile = await this.prismaService.careRecipient.findFirst({
      where: {
        patientId: userId,
        is_self: true,
        is_deleted: false,
        date_of_birth: { not: null },
        gender: { not: null },
        mobility_level: { not: null },
      },
      select: { id: true },
    });

    return profile !== null;
  }

  /**
   * บันทึกข้อมูลที่ผู้สูงอายุกรอกตอน Onboarding (PYG-498)
   *
   * ทำสองอย่างใน transaction เดียว — ถ้าครึ่งหลังล้มแล้วครึ่งแรกติด จะได้ users ที่มีชื่อ
   * แต่ไม่มีโปรไฟล์ ซึ่ง onboardingCompleted ยังเป็น false → ผู้ใช้โดนเด้งกลับมากรอกใหม่
   * ทั้งที่ชื่อถูกบันทึกไปแล้ว
   *   ① users.first_name / last_name (+ display_name ถ้ายังเป็นค่าเริ่มต้นจากอีเมล)
   *   ② care_recipients ใบ is_self — มีอยู่แล้วก็อัปเดต ยังไม่มีก็สร้าง
   *
   * เรียกซ้ำได้ (ผู้ใช้กลับมาแก้ข้อมูล) — ไม่สร้างใบ is_self ซ้ำ
   */
  async completeOnboarding(
    userId: string,
    input: CompleteOnboardingInput,
  ): Promise<User> {
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, role: true, displayName: true },
    });
    if (!user) throw new NotFoundException(`User with ID "${userId}" not found`);

    // ★ เฉพาะผู้สูงอายุ — role อื่นไม่มีโปรไฟล์ผู้รับบริการของตัวเอง ถ้าปล่อยผ่านจะได้
    //   ใบ is_self ของผู้ดูแลค้างใน DB ซึ่งไม่มีหน้าจอไหนแสดงและไม่มีใครลบ
    if (user.role !== ROLE_ID.PATIENT) {
      throw new ForbiddenException('หน้านี้สำหรับผู้รับบริการเท่านั้น');
    }

    const firstName = input.firstName.trim();
    const lastName = input.lastName.trim();
    // @IsNotEmpty ปล่อยสตริงที่มีแต่ช่องว่างผ่าน (' ' ไม่ empty) → ตรวจหลัง trim อีกชั้น
    if (!firstName || !lastName) {
      throw new BadRequestException('กรุณากรอกชื่อและนามสกุล');
    }

    const nickname = input.nickname?.trim() || null;
    const fullName = `${firstName} ${lastName}`;
    const columns = toCareRecipientColumns(input.details);

    await this.prismaService.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          firstName,
          lastName,
          // display_name ที่ระบบตั้งให้ตอนสมัคร = prefix ของอีเมล (createUser)
          // ทับได้เพราะผู้ใช้ไม่เคยตั้งเอง — แต่ถ้าเขาเปลี่ยนเองแล้วต้องเคารพของเขา
          ...(user.displayName === user.email.split('@')[0]
            ? { displayName: fullName }
            : {}),
        },
      });

      // ใบ is_self ของตัวเองเสมอเป็นโปรไฟล์ส่วนตัว (familyGroupId = null)
      // ไม่ใช่โปรไฟล์ในกลุ่ม — โปรไฟล์กลุ่มถูกสร้างตอนจองแทน (PYG-500 ฝั่ง booking)
      const existing = await tx.careRecipient.findFirst({
        where: {
          patientId: userId,
          is_self: true,
          familyGroupId: null,
          is_deleted: false,
        },
        select: { id: true },
        orderBy: { updated_at: 'desc' },
      });

      if (existing) {
        await tx.careRecipient.update({
          where: { id: existing.id },
          data: { name: fullName, nickname, ...columns },
        });
        return;
      }

      await tx.careRecipient.create({
        data: {
          patientId: userId,
          familyGroupId: null,
          is_self: true,
          // ข้อมูลมาจากเจ้าตัวโดยตรง ไม่ใช่คนอื่นกรอกให้
          self_reported: true,
          name: fullName,
          nickname,
          ...columns,
        },
      });
    });

    this.logger.log({
      event: 'onboarding.completed',
      userId,
      createdProfile: true,
    });

    return this.findById(userId);
  }
}
