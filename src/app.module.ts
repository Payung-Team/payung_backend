import { MatchingModule } from './matching/matching.module';
import { Logger, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
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
import { PatientModule } from './patient/patient.module';
import { PaymentModule } from './payment/payment.module';
import { PayoutModule } from './payout/payout.module';
import { ReviewModule } from './review/review.module';
import { DisputeModule } from './dispute/dispute.module';
import { TransactionModule } from './transaction/transaction.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { FamilyGroupModule } from './family-group/family-group.module';
import { ConsentModule } from './consent/consent.module';
import { AssessmentModule } from './assessment/assessment.module';
import { CareSkillModule } from './care-skill/care-skill.module';
import { CareActivityModule } from './care-activity/care-activity.module';
import { ServicePackageModule } from './service-package/service-package.module';

@Module({
  imports: [
    // ─── 1. Config Module (โหลด .env ทั่วทั้งโปรเจกต์) ───────────────────
    ConfigModule.forRoot({
      isGlobal: true, // ใช้ได้ทุก Module โดยไม่ต้อง import ซ้ำ
    }),

    // ─── Scheduler (PYG-159) ──────────────────────────────────────────────
    ...(process.env.CF_WORKER === 'true' ? [] : [ScheduleModule.forRoot()]),

    // ─── Event Emitter ────────────────────────────────────────────────────
    EventEmitterModule.forRoot(),

    // ─── 2. GraphQL Module (Code-First approach) ──────────────────────────
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,

      // autoSchemaFile: สร้าง schema.gql อัตโนมัติจาก TypeScript Decorators
      // join(...) = เซฟไฟล์ไว้ที่ src/schema.gql (เอาไว้ดู/debug)
      autoSchemaFile:
        process.env.CF_WORKER === 'true'
          ? true
          : join(process.cwd(), 'src/schema.gql'),

      // sortSchema: เรียง field ใน schema ตามตัวอักษร (อ่านง่ายขึ้น)
      sortSchema: true,

      // addNewlineAtEnd: ปิดไฟล์ด้วย newline — ค่าเริ่มต้นของ Nest ไม่ใส่ แต่ editor ส่วนใหญ่ใส่ให้ตอนเซฟ
      // ไม่งั้นไฟล์ที่ commit กับไฟล์ที่ server เขียนทุกครั้งที่สตาร์ทต่างกันแค่บรรทัดสุดท้าย
      // → src/schema.gql ขึ้น modified ค้าง และขวาง git pull ทุกครั้งที่มี commit แตะไฟล์นี้
      buildSchemaOptions: { addNewlineAtEnd: true },

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
    MatchingModule,      // PYG-647: booking-specific eligibility and admin reports
    SearchModule,        // PYG-192: caregiver search with filters + pagination
    CaregiverPublicModule, // GET /api/v1/caregivers/:id/public
    BookingModule,       // PYG-210: patient booking confirmations + history; REST booking APIs
    PatientModule,       // Care recipients + Saved caregivers (spec rev 2)
    PaymentModule,       // PYG-277 FSM + PYG-282 admin transfer + Omise webhook
    PayoutModule,        // PYG-330 ก้อน B: payout worker + Omise Transfer
    ReviewModule,        // PYG-297: post-service reviews (createReview/caregiverReviews/hideReview)
    DisputeModule,       // PYG-287: flag / adminDisputes / resolveDispute
    TransactionModule,   // PYG-333: admin transactions list/detail/summary (read-only)
    MonitoringModule,    // PYG-352: proof-of-work — checkInBooking + job_events
    ReconciliationModule, // PYG-376: payments vs Omise vs payouts recon report + alert cron
    FamilyGroupModule,   // PYG-412: กลุ่มครอบครัว — CRUD + FamilyGroupGuard
    ConsentModule,       // PYG-472: ข้อความ PDPA consent + เวอร์ชันนโยบาย (อ่านอย่างเดียว)
    AssessmentModule,    // PYG-609: private ADL assessment API
    CareSkillModule,     // PYG-652: careSkills(profession) + ตรวจทักษะผู้ดูแลก่อนบันทึก
    CareActivityModule,  // PYG-634: กิจกรรมการดูแลกลาง (แอดมิน + หน้าจอง + snapshot ใน booking)
    ServicePackageModule, // PYG-628 (S14): ชุดบริการที่แนะนำตามกลุ่มของผู้สูงอายุ
  ],
  providers: [AppResolver], // ← ลงทะเบียน Resolver ที่นี่
})
export class AppModule {
  constructor() {
    // PYG-700: production (Cloudflare Worker · NODE_ENV=production ใน wrangler.jsonc) ไม่พิมพ์ debug/verbose
    //   เช่น cron payout/expiry ที่ log "no due …" ทุกรอบ · ตอน dev ยังเห็นครบ
    if (process.env.NODE_ENV === 'production') {
      Logger.overrideLogger(['fatal', 'error', 'warn', 'log']);
    }
  }
}
