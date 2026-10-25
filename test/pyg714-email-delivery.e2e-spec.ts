/**
 * PYG-714 — อีเมลแจ้งเตือนถึงผู้ใช้จริง (ก่อนขึ้น production)
 *
 * ใช้ EmailService ตัวจริง + Postgres จริง (มีตาราง email_logs) + Resend ปลอม (HTTP server ในเครื่อง)
 * ตรวจครบ 12 กรณีของ EmailService + อีเมลการจองรายเหตุการณ์ทุกตัวทั้งสองบทบาท:
 *   - ยิงถึง Resend จริง (from / to / subject / html / text)
 *   - ทุกลิงก์ในอีเมลเป็น https://payung-care.com/<หน้าที่มีจริงใน FE> (เดิม FRONTEND_URL หลาย origin หลุดเข้าลิงก์)
 *   - มีแถวใน email_logs: sent + id ของ Resend · ข้าม/ล้มมีเหตุผล
 *
 * ★ ไม่มีการส่งอีเมลจริงในชุดนี้ — การยืนยันว่าถึงกล่องจริงทำบน production หลังตั้งค่า Resend (ดู PR)
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { EmailModule } from '../src/email/email.module';
import { EmailService } from '../src/email/email.service';
import { CommonModule } from '../src/common/common.module';
import { PrismaService } from '../src/common/prisma.service';
import { SupabaseService } from '../src/common/supabase.service';
import { BOOKING_EMAIL_TEMPLATES } from '../src/email/templates/booking';
import type { BookingEmailContext } from '../src/email/templates/booking';
import { describeDb } from './support/qa-e2e';

const DB_URL = process.env.QA_DATABASE_URL ?? process.env.DATABASE_URL;
const SITE = 'https://payung-care.com';
/** route ใน payung_frontend/src/App.tsx ที่อีเมลลิงก์ไป */
const FE_ROUTES = [
  /^\/login$/,
  /^\/notifications$/,
  /^\/kyc$/,
  /^\/caregiver-home$/,
  /^\/bookings\/[^/]+$/,
  /^\/caregiver\/bookings\/[^/]+$/,
  /^\/admin\/disputes$/,
];

type ResendCall = { auth: string | undefined; body: Record<string, unknown> };

describeDb(
  'PYG-714 email delivery (real EmailService → fake Resend → email_logs)',
  () => {
    let server: Server;
    let calls: ResendCall[] = [];
    let mode: 'ok' | 'domain_not_verified' = 'ok';
    let prisma: PrismaClient;
    let email: EmailService;
    let closeApp: () => Promise<void>;

    const users: Record<string, string> = {};

    beforeAll(async () => {
      server = createServer((req: IncomingMessage, res: ServerResponse) => {
        let raw = '';
        req.on('data', (c: Buffer) => (raw += c.toString()));
        req.on('end', () => {
          calls.push({
            auth: req.headers.authorization,
            body: JSON.parse(raw) as Record<string, unknown>,
          });
          res.setHeader('content-type', 'application/json');
          if (req.url !== '/emails' || req.method !== 'POST') {
            res.statusCode = 404;
            res.end('{}');
          } else if (mode === 'domain_not_verified') {
            res.statusCode = 403;
            res.end(
              JSON.stringify({
                statusCode: 403,
                name: 'validation_error',
                message: 'The payung-care.com domain is not verified.',
              }),
            );
          } else {
            res.end(JSON.stringify({ id: `re_${randomUUID()}` }));
          }
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const port = (server.address() as AddressInfo).port;

      process.env.DATABASE_URL = DB_URL;
      process.env.RESEND_API_KEY = 're_test_pyg714';
      process.env.EMAIL_FROM = 'Payung <noreply@payung-care.com>';
      process.env.RESEND_BASE_URL = `http://127.0.0.1:${port}`;
      process.env.APP_PUBLIC_BASE_URL = SITE;
      // ค่าเดียวกับ wrangler.jsonc — ต้องไม่หลุดเข้าลิงก์
      process.env.FRONTEND_URL = `${SITE},https://www.payung-care.com`;

      prisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString: DB_URL! }),
      });
      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
          CommonModule,
          EmailModule,
        ],
      })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        // EmailService ไม่ใช้ Supabase — กัน CommonModule เรียกหา SUPABASE_URL
        .overrideProvider(SupabaseService)
        .useValue({})
        .compile();
      const app = moduleRef.createNestApplication();
      await app.init();
      email = app.get(EmailService);
      closeApp = () => app.close();

      const tag = randomUUID().slice(0, 8);
      const mk = async (
        key: string,
        data: {
          email: string | null;
          role: number;
          emailPreferences?: boolean;
        },
      ) => {
        const u = await prisma.user.create({
          data: {
            supabaseUid: randomUUID(),
            email: data.email,
            displayName: `ทดสอบ ${key}`,
            role: data.role,
            isActive: true,
            is_deleted: false,
            emailPreferences: data.emailPreferences ?? true,
          },
          select: { id: true },
        });
        users[key] = u.id;
      };
      await mk('patient', { email: `patient-${tag}@example.com`, role: 1 });
      await mk('caregiver', { email: `caregiver-${tag}@example.com`, role: 2 });
      await mk('phoneOnly', { email: null, role: 1 });
      await mk('optedOut', {
        email: `optout-${tag}@example.com`,
        role: 1,
        emailPreferences: false,
      });
    });

    afterAll(async () => {
      await prisma?.email_logs.deleteMany({
        where: { user_id: { in: Object.values(users) } },
      });
      await prisma?.user.deleteMany({
        where: { id: { in: Object.values(users) } },
      });
      await closeApp?.();
      await new Promise((r) => server?.close(r));
    });

    beforeEach(() => {
      calls = [];
      mode = 'ok';
    });

    /** ทุกลิงก์ที่ผู้ใช้กดได้ (<a href>) ต้องเป็นหน้าเว็บจริงของเรา (หรือ mailto) — <link href> ของฟอนต์ไม่นับ */
    function expectLinksValid(html: string) {
      const hrefs = [...html.matchAll(/<a\s[^>]*href="([^"]+)"/g)].map((m) =>
        m[1].replace(/&amp;/g, '&'),
      );
      expect(hrefs.length).toBeGreaterThan(0);
      for (const href of hrefs) {
        if (href.startsWith('mailto:')) continue;
        expect(href.startsWith(`${SITE}/`)).toBe(true);
        const path = new URL(href).pathname;
        expect(FE_ROUTES.some((r) => r.test(path))).toBe(true);
      }
    }

    async function lastLog(template: string) {
      return prisma.email_logs.findFirst({
        where: { template },
        orderBy: { created_at: 'desc' },
      });
    }

    const cases: Array<[string, string, () => Promise<unknown>, string]> = [
      [
        '1 KYC ส่งเอกสาร',
        'kyc_submitted',
        () => email.sendKycSubmitted(users.caregiver),
        'caregiver',
      ],
      [
        '2 KYC ผ่าน',
        'kyc_verified',
        () => email.sendKycVerified(users.caregiver),
        'caregiver',
      ],
      [
        '3 KYC ไม่ผ่าน',
        'kyc_rejected',
        () => email.sendKycRejected(users.caregiver, 'รูปบัตรไม่ชัด'),
        'caregiver',
      ],
      [
        '4 KYC ส่งเอกสารใหม่',
        'kyc_resubmitted',
        () => email.sendKycResubmitted(users.caregiver),
        'caregiver',
      ],
      [
        '5 เชิญแอดมิน',
        'admin_invite',
        () =>
          email.sendAdminInvite(
            'qa-admin@example.com',
            'แอดมินทดสอบ',
            'Temp#1234',
          ),
        'admin',
      ],
      [
        '6 ระงับแอดมิน',
        'admin_deactivated',
        () => email.sendAdminDeactivated('qa-admin@example.com', 'แอดมินทดสอบ'),
        'admin',
      ],
      [
        '7 เปิดใช้งานแอดมิน',
        'admin_activated',
        () => email.sendAdminActivated('qa-admin@example.com', 'แอดมินทดสอบ'),
        'admin',
      ],
      [
        '8 ตั้งเวลาลบแอดมิน',
        'admin_schedule_delete',
        () =>
          email.sendAdminScheduleDelete(
            'qa-admin@example.com',
            'แอดมินทดสอบ',
            new Date('2026-11-25T00:00:00Z'),
            30,
          ),
        'admin',
      ],
      [
        '9 ยกเลิกลบแอดมิน',
        'admin_cancel_delete',
        () =>
          email.sendAdminCancelDelete('qa-admin@example.com', 'แอดมินทดสอบ'),
        'admin',
      ],
      [
        '10 ลบแอดมินแล้ว (cron)',
        'admin_auto_deleted',
        () => email.sendAdminAutoDeleted('qa-admin@example.com', 'แอดมินทดสอบ'),
        'admin',
      ],
      [
        '11 ลบบัญชีผู้ใช้แล้ว (cron)',
        'user_auto_deleted',
        () => email.sendUserAutoDeleted('qa-user@example.com', 'ผู้ใช้ทดสอบ'),
        'admin',
      ],
      [
        '12 การจอง (template กลาง)',
        'payment.transferred',
        () =>
          email.sendBookingNotification(users.caregiver, {
            heading: 'โอนค่าตอบแทนแล้ว',
            intro: 'ระบบโอนค่าตอบแทนของงานนี้ให้คุณแล้ว',
            dateText: '30 ตุลาคม 2569',
            ctaPath: '/caregiver/bookings/bk-1',
            ctaLabel: 'ดูรายละเอียด',
            template: 'payment.transferred',
          }),
        'caregiver',
      ],
    ];

    it.each(cases)(
      '%s → ยิง Resend · ลิงก์ถูก · email_logs = sent',
      async (_label, template, run, who) => {
        await run();

        expect(calls).toHaveLength(1);
        const { auth, body } = calls[0];
        expect(auth).toBe('Bearer re_test_pyg714');
        expect(body.from).toBe('Payung <noreply@payung-care.com>');
        expect((body.to as string[])[0]).toMatch(
          who === 'admin' ? /^qa-/ : /^caregiver-/,
        );
        expect(String(body.subject)).toMatch(/ — Payung$/);
        expectLinksValid(String(body.html));
        expect(String(body.text)).not.toContain('payung-care.com,https');

        const log = await lastLog(template);
        expect(log).toMatchObject({ status: 'sent', provider: 'resend' });
        expect(log!.provider_message_id).toMatch(/^re_/);
        expect(log!.recipient_masked).not.toContain(
          '@example.com'.padStart(30, 'x'),
        ); // ไม่ใช่อีเมลเต็ม
        expect(log!.recipient_masked).toMatch(/^\w\*\*\*@/);
      },
    );

    it.each(Object.keys(BOOKING_EMAIL_TEMPLATES))(
      'การจองรายเหตุการณ์ %s → ทั้งผู้รับบริการและผู้ดูแลได้ลิงก์หน้าของตัวเอง',
      async (event) => {
        const tpl =
          BOOKING_EMAIL_TEMPLATES[
            event as keyof typeof BOOKING_EMAIL_TEMPLATES
          ]!;
        for (const [key, role] of [
          ['patient', 'patient'],
          ['caregiver', 'caregiver'],
        ] as const) {
          calls = [];
          await email.sendBookingEmail(
            users[key],
            ({ recipientName, frontendUrl }) =>
              tpl({
                recipientName,
                recipientRole: role,
                caregiverName: 'เชอรี่ ใจงาม',
                caregiverPhone: '0891234567',
                caregiverRatingText: '4.9 ★ (รีวิว 32 ครั้ง)',
                patientName: 'สมศรี ใจดี',
                dateText: '30 ตุลาคม 2569',
                timeText: '09:00 – 13:00 (4 ชม.)',
                serviceText: 'ดูแลทั่วไป',
                locationAddress: 'บางกะปิ กรุงเทพมหานคร',
                totalText: '฿1,200',
                paymentAmountText: '฿1,200',
                refundAmountText: '฿1,200',
                chargeId: 'chrg_test',
                declineReason: 'ไม่ว่าง',
                bookingId: 'bk-1',
                frontendUrl,
              } satisfies BookingEmailContext),
            event,
          );
          expect(calls).toHaveLength(1);
          const html = String(calls[0].body.html);
          expectLinksValid(html);
          if (event !== 'dispute.created') {
            expect(html).toContain(
              role === 'caregiver'
                ? `${SITE}/caregiver/bookings/bk-1`
                : `${SITE}/bookings/bk-1`,
            );
          }
        }
      },
    );

    it.each([
      ['สมัครด้วยเบอร์ (ไม่มีอีเมล)', 'phoneOnly', 'no_email'],
      ['ปิดรับอีเมล', 'optedOut', 'email_opt_out'],
    ])(
      '%s → ไม่ยิง Resend · email_logs = skipped (%s)',
      async (_l, key, reason) => {
        await email.sendKycVerified(users[key]);

        expect(calls).toHaveLength(0);
        const log = await prisma.email_logs.findFirst({
          where: { user_id: users[key] },
          orderBy: { created_at: 'desc' },
        });
        expect(log).toMatchObject({
          status: 'skipped',
          reason,
          template: 'kyc_verified',
        });
      },
    );

    it('Resend ปฏิเสธ (โดเมนยังไม่ยืนยัน) → ไม่ throw · email_logs = failed พร้อมเหตุผลจาก Resend', async () => {
      mode = 'domain_not_verified';

      await expect(
        email.sendKycVerified(users.patient),
      ).resolves.toBeUndefined();

      const log = await prisma.email_logs.findFirst({
        where: { user_id: users.patient },
        orderBy: { created_at: 'desc' },
      });
      expect(log).toMatchObject({
        status: 'failed',
        reason:
          'resend 403 validation_error: The payung-care.com domain is not verified.',
      });
    });

    it('★ ลบผู้ใช้แล้ว ประวัติการส่งยังอยู่ (user_id → NULL)', async () => {
      const u = await prisma.user.create({
        data: {
          supabaseUid: randomUUID(),
          email: `gone-${randomUUID().slice(0, 6)}@example.com`,
          role: 1,
          isActive: true,
          is_deleted: false,
        },
        select: { id: true },
      });
      await email.sendKycVerified(u.id);
      const log = await prisma.email_logs.findFirstOrThrow({
        where: { user_id: u.id },
      });

      await prisma.user.delete({ where: { id: u.id } });

      const after = await prisma.email_logs.findUniqueOrThrow({
        where: { id: log.id },
      });
      expect(after.user_id).toBeNull();
      expect(after.status).toBe('sent');
      await prisma.email_logs.delete({ where: { id: log.id } });
    });
  },
);
