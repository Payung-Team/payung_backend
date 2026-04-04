/**
 * PrismaService — ตัวกลางสำหรับเชื่อมต่อกับ Database (PostgreSQL)
 *
 * ทำไมต้องมี?
 * - Prisma คือ ORM (Object-Relational Mapping) ที่ช่วยให้เราคุยกับ database
 *   โดยใช้ TypeScript แทนการเขียน SQL ตรงๆ
 * - เช่น: prisma.user.findUnique({ where: { email: 'test@test.com' } })
 *   แทนที่จะเขียน: SELECT * FROM users WHERE email = 'test@test.com'
 *
 * วิธีใช้ใน service อื่น:
 *   constructor(private prisma: PrismaService) {}
 *   const user = await this.prisma.user.findUnique({ where: { id: '123' } });
 */
import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  /**
   * OnModuleInit = NestJS จะเรียก method นี้อัตโนมัติตอน module เริ่มทำงาน
   * $connect() = เปิดการเชื่อมต่อกับ database
   */
  async onModuleInit() {
    await this.$connect();
  }
}
