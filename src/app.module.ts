import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { ConfigModule } from '@nestjs/config';
import { join } from 'path';
import { AppResolver } from './app.resolver';
import { CommonModule } from './common/common.module';
import { AuthModule } from './identity/auth/auth.module';
import { IdentityModule } from './identity/identity.module';
import { NotificationModule } from './notification/notification.module';
import { EmailModule } from './email/email.module';
import { AdminModule } from './admin/admin.module';
import { SearchModule } from './search/search.module';
import { CaregiverPublicModule } from './caregiver-public/caregiver-public.module';
import { BookingModule } from './booking/booking.module';

@Module({
  imports: [
    // ─── 1. Config Module (โหลด .env ทั่วทั้งโปรเจกต์) ───────────────────
    ConfigModule.forRoot({
      isGlobal: true, // ใช้ได้ทุก Module โดยไม่ต้อง import ซ้ำ
    }),

    // ─── Scheduler (PYG-159) ──────────────────────────────────────────────
    ScheduleModule.forRoot(),

    // ─── 2. GraphQL Module (Code-First approach) ──────────────────────────
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,

      // autoSchemaFile: สร้าง schema.gql อัตโนมัติจาก TypeScript Decorators
      // join(...) = เซฟไฟล์ไว้ที่ src/schema.gql (เอาไว้ดู/debug)
      autoSchemaFile: join(process.cwd(), 'src/schema.gql'),

      // sortSchema: เรียง field ใน schema ตามตัวอักษร (อ่านง่ายขึ้น)
      sortSchema: true,

      // playground: เปิดหน้า UI ทดสอบ API ที่ localhost:3000/graphql
      playground: true,

      // context: ส่ง HTTP request/response เข้าไปใน GraphQL Context
      // (จำเป็นตอนทำ Auth Guard ในอนาคต)
      context: ({ req, res }) => ({ req, res }),
    }),

    // ─── 3. Common Module (Supabase + Prisma services) ───────────────────
    CommonModule,

    // ─── 4. Feature Modules ──────────────────────────────────────────────
    AuthModule,
    IdentityModule,
    NotificationModule,  // PYG-95: in-app notifications
    EmailModule,         // PYG-96: Resend email service
    AdminModule,         // Admin dashboard operations (KYC review, etc.)
    SearchModule,        // PYG-192: caregiver search with filters + pagination
    CaregiverPublicModule, // GET /api/v1/caregivers/:id/public
    BookingModule,       // PYG-210: patient booking confirmations + history
  ],
  providers: [AppResolver], // ← ลงทะเบียน Resolver ที่นี่
})
export class AppModule {}
