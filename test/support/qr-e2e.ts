/**
 * ตัวช่วยร่วมของ e2e QR เช็คอิน/เช็คเอาท์ (PYG-440)
 *
 * ★★ ต่อได้เฉพาะ Postgres ทิ้งได้บน localhost ผ่าน PYG440_DATABASE_URL เท่านั้น
 *    - host ไม่ใช่ localhost / มีคำว่า supabase → throw ทันที
 *    - ไม่ได้ตั้งค่า: เครื่อง dev → skip ทั้งไฟล์ · CI (process.env.CI) → throw
 *
 * บูต MonitoringModule ตัวจริง (JobScanResolver/Service · JobQrResolver/Service · MonitoringService
 * · CareLogController · NoCheckoutSweeperService) — guard chain จริง Prisma จริง
 * mock เฉพาะ: SupabaseService (auth) · EmailService · ClockService (นาฬิกาที่แช่แข็ง/เลื่อนได้เอง)
 * ไม่มีทางไหนในโมดูลนี้เรียก Omise
 */
import { randomUUID } from 'crypto';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import request from 'supertest';
import { App } from 'supertest/types';
import { CommonModule } from '../../src/common/common.module';
import { PrismaService } from '../../src/common/prisma.service';
import { SupabaseService } from '../../src/common/supabase.service';
import { ClockService } from '../../src/common/clock.service';
import { EmailService } from '../../src/email/email.service';
import { MonitoringModule } from '../../src/monitoring/monitoring.module';
import { JobQrService } from '../../src/monitoring/qr/job-qr.service';

export const DB_URL = process.env.PYG440_DATABASE_URL;

if (DB_URL) {
  const host = new URL(DB_URL).hostname;
  if (
    !['localhost', '127.0.0.1', '::1'].includes(host) ||
    /supabase/i.test(DB_URL)
  ) {
    throw new Error(
      `PYG440_DATABASE_URL ต้องเป็น Postgres ทิ้งได้บน localhost เท่านั้น (ได้ host=${host})`,
    );
  }
} else if (process.env.CI) {
  throw new Error(
    'PYG440_DATABASE_URL ไม่ได้ตั้งค่าใน CI — ชุดทดสอบ PYG-440 ต้องรันจริง ห้าม skip',
  );
}

export const describeDb = DB_URL ? describe : describe.skip;

/** ค่า cron flag ที่ใช้รันจริง — รายงานต้องระบุ */
export const CRON_FLAGS_AT_RUN = {
  BOOKING_EXPIRY_CRON_ENABLED:
    process.env.BOOKING_EXPIRY_CRON_ENABLED ?? '(unset)',
  HOLD_REFRESH_CRON_ENABLED: process.env.HOLD_REFRESH_CRON_ENABLED ?? '(unset)',
};

export type GqlBody = {
  data?: Record<string, any> | null;
  errors?: { message: string; extensions?: Record<string, unknown> }[];
};

export const codeOf = (body: GqlBody) => body.errors?.[0]?.extensions?.code;

/** วันงานที่ใช้ทั้งชุด: 2026-10-01 เวลา 10:00–12:00 น. (ไทย) = 03:00–05:00Z */
export const JOB_DATE = '2026-10-01';
export const START = new Date('2026-10-01T03:00:00.000Z');
export const END = new Date('2026-10-01T05:00:00.000Z');
export const JOB_LAT = 13.7563;
export const JOB_LNG = 100.5018;
export const at = (base: Date, minutes: number) =>
  new Date(base.getTime() + minutes * 60_000);

export const SCAN = `mutation($input: ScanJobQrInput!) {
  scanJobQr(input: $input) {
    ok result action message bookingId sessionStatus scannedAt
    jobEvent { id eventType source serverTs deviceTs photoUrl }
  }
}`;
export const JOB_QR = `query($b: ID!) {
  jobQr(bookingId: $b) { token status validFrom validUntil isActive nextAction tokenIssuedAt }
}`;

export async function bootstrap() {
  process.env.DATABASE_URL = DB_URL;
  // ค่าคงที่เพื่อให้ token คำนวณซ้ำได้ตลอดรอบรัน (ไม่ใช่ความลับจริง)
  process.env.QR_TOKEN_SECRET = 'pyg440-test-only-secret-000000000000000';
  delete process.env.BOOKING_EXPIRY_CRON_ENABLED;
  delete process.env.HOLD_REFRESH_CRON_ENABLED;

  // ── นาฬิกาที่คุมเองได้ ────────────────────────────────────────────────
  const clock = {
    current: new Date(START),
    set(d: Date) {
      this.current = new Date(d);
    },
    now() {
      return new Date(this.current.getTime());
    },
  };

  // ── เก็บทุกบรรทัด log ไว้ตรวจ (TC_13 token ห้ามโผล่ · TC_16 missing_check_in_event) ──
  const logs: unknown[][] = [];
  for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation((...args) => {
      logs.push([level, ...args]);
    });
  }

  const tokens = new Map<string, string>();
  const supabase = {
    getClient: () => ({
      auth: {
        getUser: (token: string) =>
          Promise.resolve(
            tokens.has(token)
              ? { data: { user: { id: tokens.get(token) } }, error: null }
              : { data: { user: null }, error: new Error('invalid token') },
          ),
      },
    }),
    getAdminClient: () => {
      throw new Error('Supabase admin client ไม่ควรถูกเรียกในชุดทดสอบนี้');
    },
  };
  // ★ ต้องไม่ตอบ 'then' / lifecycle hooks — ไม่งั้น Nest มองว่าเป็น Promise แล้ว await ค้าง
  const email = new Proxy(
    {},
    {
      get: (_t, prop) =>
        typeof prop !== 'string' ||
        prop === 'then' ||
        prop.startsWith('on') ||
        prop.startsWith('before')
          ? undefined
          : () => Promise.resolve(undefined),
    },
  );

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      EventEmitterModule.forRoot(),
      GraphQLModule.forRoot<ApolloDriverConfig>({
        driver: ApolloDriver,
        autoSchemaFile: true,
        context: ({ req, res }: { req: unknown; res: unknown }) => ({
          req,
          res,
        }),
      }),
      CommonModule,
      MonitoringModule,
    ],
  })
    .overrideProvider(SupabaseService)
    .useValue(supabase)
    .overrideProvider(EmailService)
    .useValue(email)
    .overrideProvider(ClockService)
    .useValue(clock)
    .compile();

  const app: INestApplication<App> = moduleRef.createNestApplication();
  // ★ ต้องตรงกับ src/main.ts
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  await app.init();
  const prisma = app.get(PrismaService);
  const jobQrService = app.get(JobQrService);

  const gql = async (
    token: string | null,
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<GqlBody> => {
    const req = request(app.getHttpServer()).post('/graphql');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return (await req.send({ query, variables })).body as GqlBody;
  };

  const seedUser = async (tag: string, role: number) => {
    const uid = randomUUID();
    const user = await prisma.user.create({
      data: {
        supabaseUid: uid,
        email: `${tag}-${uid}@pyg440.test`,
        displayName: `${tag}-${uid.slice(0, 8)}`,
        role,
        isActive: true,
        is_deleted: false,
      },
      select: { id: true },
    });
    const token = `tok-${uid}`;
    tokens.set(token, uid);
    return { id: user.id, token };
  };

  const seedCaregiver = async () => {
    const user = await seedUser('caregiver', 2);
    const cg = await prisma.caregiver.create({
      data: {
        userId: user.id,
        fullName: 'ผู้ดูแล PYG-440',
        kycStatus: 'verified',
        isSearchable: true,
        hourlyRate: 300,
      },
      select: { id: true },
    });
    return { ...user, caregiverId: cg.id };
  };

  /**
   * งาน 1 ใบพร้อม QR — ผ่านทางจริงของระบบทุกขั้นที่เกี่ยวกับ QR:
   *   booking + payment ตรงลง DB (precondition) → JobQrService.createForBooking() ตัวจริงใน tx
   *   → token ดิบดึงผ่าน GraphQL jobQr ของผู้รับบริการ (ทางเดียวที่ระบบคืน token)
   */
  const seedJob = async (
    opts: {
      caregiver?: Awaited<ReturnType<typeof seedCaregiver>> | null;
      status?: string;
      paymentStatus?: 'held' | 'captured' | null;
    } = {},
  ) => {
    const patient = await seedUser('patient', 1);
    const caregiver =
      opts.caregiver === undefined ? await seedCaregiver() : opts.caregiver;
    const booking = await prisma.booking.create({
      data: {
        patientId: patient.id,
        caregiverId: caregiver?.caregiverId ?? null,
        status: opts.status ?? 'confirmed',
        serviceType: 'general_care',
        timeSlot: 'morning',
        startTime: new Date('1970-01-01T10:00:00.000Z'), // 10:00 เวลาไทย (scheduledStartOf)
        durationHours: 2,
        locationAddress: 'PYG-440 address',
        locationLat: JOB_LAT,
        locationLng: JOB_LNG,
        bookingDate: new Date(JOB_DATE),
        estimatedCost: 600,
      },
      select: {
        id: true,
        bookingDate: true,
        startTime: true,
        durationHours: true,
      },
    });
    if (caregiver && opts.paymentStatus !== null) {
      await prisma.payment.create({
        data: {
          bookingId: booking.id,
          patientId: patient.id,
          caregiverId: caregiver.id,
          amount: 600,
          paymentStatus: opts.paymentStatus ?? 'held',
          paymentMethod: 'credit_card',
          omiseChargeId: `chrg_test_${randomUUID().slice(0, 8)}`,
        },
      });
    }
    await prisma.$transaction((tx) =>
      jobQrService.createForBooking(tx, booking as never),
    );
    const qr = await gql(patient.token, JOB_QR, { b: booking.id });
    if (qr.errors) throw new Error(JSON.stringify(qr.errors));
    const session = await prisma.jobSession.findUniqueOrThrow({
      where: { bookingId: booking.id },
    });
    return {
      patient,
      caregiver,
      bookingId: booking.id,
      sessionId: session.id,
      token: qr.data!.jobQr.token as string,
      validFrom: session.validFrom,
      validUntil: session.validUntil,
    };
  };

  /** token ที่ใช้ได้ "ตอนนี้" ของงานนั้น (หลังเช็คอิน token จะเปลี่ยน — PYG-437) */
  const currentToken = async (patientToken: string, bookingId: string) => {
    const qr = await gql(patientToken, JOB_QR, { b: bookingId });
    if (qr.errors) throw new Error(JSON.stringify(qr.errors));
    return qr.data!.jobQr.token as string;
  };

  const scan = async (
    token: string | null,
    qrToken: string,
    extra: Record<string, unknown> = {},
  ) => {
    const body = await gql(token, SCAN, {
      input: {
        token: qrToken,
        lat: JOB_LAT,
        lng: JOB_LNG,
        accuracyM: 10,
        ...extra,
      },
    });
    return { body, r: body.data?.scanJobQr as Record<string, any> | undefined };
  };

  /** ภาพรวมสถานะของงาน — ใช้เทียบก่อน/หลังในเคสลบ */
  const state = async (bookingId: string) => {
    const [session, booking, events, scans] = await Promise.all([
      prisma.jobSession.findUnique({
        where: { bookingId },
        select: { status: true, tokenHash: true },
      }),
      prisma.booking.findUnique({
        where: { id: bookingId },
        select: { status: true, reviewReasons: true },
      }),
      prisma.jobEvent.findMany({
        where: { bookingId },
        select: { eventType: true, source: true, serverTs: true },
        orderBy: { serverTs: 'asc' },
      }),
      prisma.jobScanEvent.count({ where: { bookingId } }),
    ]);
    return {
      sessionStatus: session?.status,
      bookingStatus: booking?.status,
      events: events.map((e) => `${e.eventType}:${e.source}`),
      scanRows: scans,
    };
  };

  const scanRowsBy = (userId: string) =>
    prisma.jobScanEvent.findMany({
      where: { scannedBy: userId },
      orderBy: { scannedAt: 'asc' },
    });

  const close = async () => {
    await prisma.$disconnect();
    await app.close();
  };

  return {
    app,
    prisma,
    clock,
    logs,
    jobQrService,
    gql,
    seedUser,
    seedCaregiver,
    seedJob,
    currentToken,
    scan,
    state,
    scanRowsBy,
    close,
  };
}

export type Harness = Awaited<ReturnType<typeof bootstrap>>;
