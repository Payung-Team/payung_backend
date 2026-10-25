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
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { RequestScopedPool, requestPoolConfig } from './request-db-scope';

// ★ PYG-716 singleton — การเชื่อมต่อต่อคำขอบน Worker จัดการโดย RequestScopedPool (ดู request-db-scope.ts)
//   เดิม Scope.REQUEST: ประกอบ service ทั้งชุด + PrismaClient ใหม่ทุกคำขอ และไม่เคยปิด → CPU/หน่วยความจำเกินลิมิต
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private readonly pool: RequestScopedPool;

  constructor() {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL environment variable is not set');
    }

    // ใน scope ของคำขอบน Worker: query ไปที่ pool ของคำขอนั้น · นอก scope (Node/jest): ใช้ pool นี้เอง
    //   บน Worker pool นี้ไม่ควรถูกใช้เลย (ทุกคำขอ/cron อยู่ใน scope) — Node ใช้ได้หลายการเชื่อมต่อ
    const pool = new RequestScopedPool({
      ...requestPoolConfig(),
      max: process.env.CF_WORKER === 'true' ? 1 : 10,
    });

    // Initialize PrismaClient with the PostgreSQL adapter for Prisma 7
    super({
      adapter: new PrismaPg(pool),
    });

    this.pool = pool;
  }

  /** ปิด pool ของตัวเอง (นอก scope) ตอนแอปปิด — pool ต่อคำขอปิดใน runInRequestDbScope */
  async onModuleDestroy() {
    await this.$disconnect();
    await this.pool.end();
  }
}
