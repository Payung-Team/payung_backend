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
import { Injectable, OnModuleDestroy, Scope } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

@Injectable({ scope: Scope.REQUEST })
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor() {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL environment variable is not set');
    }

    // Create a PostgreSQL connection pool
    const pool = new Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 5_000,
      allowExitOnIdle: true,
    });

    // Initialize PrismaClient with the PostgreSQL adapter for Prisma 7
    super({
      adapter: new PrismaPg(pool),
    });

    this.pool = pool;
  }

  /** Close the request's database resources after Nest releases its scope. */
  async onModuleDestroy() {
    await this.$disconnect();
    await this.pool.end();
  }
}
