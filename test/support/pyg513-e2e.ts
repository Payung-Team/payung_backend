/**
 * ตัวช่วยของ e2e PYG-513 (QA ของ PYG-488: รูปโปรไฟล์ผู้ดูแล — อัปโหลด → รีวิว → แสดงผล)
 * ใช้โดย test/pyg513-profile-photo.e2e-spec.ts
 *
 * ดัดแปลงจาก test/support/pyg527-e2e.ts (PR #98) — ต่างกันที่ Supabase Storage ปลอมแบบ in-memory
 * (เก็บ bytes จริงที่ backend อัปโหลด เพื่อ "ดาวน์โหลดไฟล์ใน bucket แล้วตรวจ EXIF" ได้)
 *
 * ★★ ต่อได้เฉพาะ Postgres ทิ้งได้บน localhost ผ่าน PYG513_DATABASE_URL เท่านั้น
 *    - host ไม่ใช่ localhost / มีคำว่า supabase → throw ทันที
 *    - ไม่ได้ตั้งค่า: เครื่อง dev → skip ทั้งไฟล์ · CI (process.env.CI) → throw
 *
 * แอปที่บูต: Auth + Identity(KYC) + Admin + Search + CaregiverPublic + Booking ตัวจริง
 * (guard chain / resolver / service / REST controller / multer จริงทั้งหมด)
 * mock เฉพาะของภายนอก 3 ตัว — ไม่มีการเรียก Supabase / Omise / SMTP จริงแม้แต่ครั้งเดียว:
 *   SupabaseService (auth.getUser + storage in-memory) · OmiseService · EmailService
 */
import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
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
import { AuthModule } from '../../src/identity/auth/auth.module';
import { IdentityModule } from '../../src/identity/identity.module';
import { AdminModule } from '../../src/admin/admin.module';
import { SearchModule } from '../../src/search/search.module';
import { CaregiverPublicModule } from '../../src/caregiver-public/caregiver-public.module';
import { BookingModule } from '../../src/booking/booking.module';
import { OmiseService } from '../../src/payment/omise/omise.service';
import { EmailService } from '../../src/email/email.service';

export const DB_URL = process.env.PYG513_DATABASE_URL;

if (DB_URL) {
  const host = new URL(DB_URL).hostname;
  if (
    !['localhost', '127.0.0.1', '::1'].includes(host) ||
    /supabase/i.test(DB_URL)
  ) {
    throw new Error(
      `PYG513_DATABASE_URL ต้องเป็น Postgres ทิ้งได้บน localhost เท่านั้น (ได้ host=${host})`,
    );
  }
} else if (process.env.CI) {
  throw new Error(
    'PYG513_DATABASE_URL ไม่ได้ตั้งค่าใน CI — ชุดทดสอบ PYG-513 ต้องรันจริง ห้าม skip',
  );
}

export const describeDb = DB_URL ? describe : describe.skip;

/** host ปลอมของ Supabase — signed URL ทุกใบที่ storage ปลอมออกให้ขึ้นต้นด้วยค่านี้ */
export const SUPABASE_URL = 'https://pyg513.supabase.test';
export const SIGNED_PREFIX = `${SUPABASE_URL}/storage/v1/object/sign/`;

export type GqlBody = {
  data?: Record<string, any> | null;
  errors?: { message: string; extensions?: Record<string, unknown> }[];
};

/**
 * Supabase Storage ปลอม — เก็บ bytes ต่อ bucket/path ในหน่วยความจำ
 * พฤติกรรมที่เลียนของจริง: upload ซ้ำ path เดิม (upsert:false) = error ·
 * createSignedUrl ของ object ที่ไม่มี = error "Object not found"
 */
export function createStorageMock() {
  const objects = new Map<string, Buffer>();
  const signCalls: { bucket: string; path: string; ttl: number }[] = [];
  const key = (bucket: string, path: string) => `${bucket}/${path}`;

  const from = (bucket: string) => ({
    upload: (path: string, bytes: Buffer) => {
      if (objects.has(key(bucket, path))) {
        return Promise.resolve({
          data: null,
          error: { message: 'The resource already exists' },
        });
      }
      objects.set(key(bucket, path), Buffer.from(bytes));
      return Promise.resolve({ data: { path }, error: null });
    },
    createSignedUrl: (path: string, ttl: number) => {
      signCalls.push({ bucket, path, ttl });
      if (!objects.has(key(bucket, path))) {
        return Promise.resolve({
          data: null,
          error: { message: 'Object not found' },
        });
      }
      return Promise.resolve({
        data: {
          signedUrl: `${SIGNED_PREFIX}${bucket}/${path}?token=${randomUUID()}`,
        },
        error: null,
      });
    },
    remove: (paths: string[]) => {
      for (const p of paths) objects.delete(key(bucket, p));
      return Promise.resolve({ data: [], error: null });
    },
  });

  return {
    from,
    signCalls,
    /** วาง object ลง bucket ตรง ๆ (precondition) */
    put: (bucket: string, path: string, bytes: Buffer) =>
      objects.set(key(bucket, path), bytes),
    /** "ดาวน์โหลด" ไฟล์ที่เก็บใน bucket */
    get: (bucket: string, path: string) => objects.get(key(bucket, path)),
    has: (bucket: string, path: string) => objects.has(key(bucket, path)),
    paths: (bucket: string) =>
      [...objects.keys()]
        .filter((k) => k.startsWith(`${bucket}/`))
        .map((k) => k.slice(bucket.length + 1)),
  };
}

export async function bootstrap() {
  process.env.DATABASE_URL = DB_URL;
  process.env.SUPABASE_URL = SUPABASE_URL;
  process.env.SUPABASE_ANON_KEY = 'anon-test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-test';
  process.env.APP_PUBLIC_BASE_URL = 'https://pyg513.test';

  const tokens = new Map<string, string>();
  const storage = createStorageMock();
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
    getAdminClient: () => ({ storage }),
  };
  // ★ ต้องไม่ตอบ 'then' / lifecycle hooks — ไม่งั้น Nest มองว่าเป็น Promise แล้ว await ค้างตลอดกาล
  const silent = () =>
    new Proxy(
      {},
      {
        get: (_t, prop) =>
          typeof prop !== 'string' ||
          prop === 'then' ||
          prop.startsWith('on') ||
          prop.startsWith('before')
            ? undefined
            : jest.fn(() => Promise.resolve(undefined)),
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
      AuthModule,
      IdentityModule,
      AdminModule,
      SearchModule,
      CaregiverPublicModule,
      BookingModule,
    ],
  })
    .overrideProvider(SupabaseService)
    .useValue(supabase)
    .overrideProvider(OmiseService)
    .useValue(silent())
    .overrideProvider(EmailService)
    .useValue(silent())
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

  const gql = async (
    token: string | null,
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<GqlBody> => {
    const req = request(app.getHttpServer()).post('/graphql');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return (await req.send({ query, variables })).body as GqlBody;
  };

  const http = () => request(app.getHttpServer());

  /** ผู้ใช้ที่ผ่าน Onboarding แล้ว (มี first_name/last_name — ด่าน PYG-499) */
  const seedUser = async (tag: string, role = 1, avatarUrl?: string) => {
    const uid = randomUUID();
    const short = uid.slice(0, 8);
    const user = await prisma.user.create({
      data: {
        supabaseUid: uid,
        email: `${tag}-${uid}@pyg513.test`,
        displayName: `${tag}-${short}`,
        firstName: `ชื่อ${tag}`,
        lastName: `สกุล${short}`,
        role,
        isActive: true,
        is_deleted: false,
        ...(avatarUrl ? { avatarUrl } : {}),
      },
      select: { id: true, displayName: true },
    });
    const token = `tok-${uid}`;
    tokens.set(token, uid);
    return {
      id: user.id,
      supabaseUid: uid,
      displayName: user.displayName as string,
      token,
    };
  };

  /**
   * ผู้ดูแล — ค่าเริ่มต้น verified + ค้นหาเจอ (มี availability + job type)
   * kycStatus 'none' = ผู้ดูแลที่เพิ่งสมัคร ยังไม่ส่ง KYC
   */
  const seedCaregiver = async (
    kycStatus: 'none' | 'pending' | 'verified' | 'rejected' = 'verified',
  ) => {
    const user = await seedUser('caregiver', 2);
    const cg = await prisma.caregiver.create({
      data: {
        userId: user.id,
        fullName: `ผู้ดูแล ${user.displayName}`,
        kycStatus,
        kycVerifiedAt: kycStatus === 'verified' ? new Date() : null,
        kycSubmittedAt: kycStatus === 'none' ? null : new Date(),
        isSearchable: kycStatus === 'verified',
        // จังหวัดเฉพาะคน → ค้นหาเจอแค่คนนี้ ไม่ปนกับเคสอื่น
        serviceAreaProvince: `จังหวัด-${user.id}`,
      },
      select: { id: true },
    });
    await prisma.caregiverAvailability.create({
      data: { caregiverId: cg.id, dayOfWeek: 1, timeSlot: 'morning' },
    });
    await prisma.$executeRaw`
      INSERT INTO caregiver_job_types (caregiver_id, job_type)
      VALUES (${cg.id}, 'general_care'::job_type)
    `;
    return { ...user, caregiverId: cg.id, province: `จังหวัด-${user.id}` };
  };

  const close = async () => {
    await prisma.$disconnect();
    await app.close();
  };

  return { app, prisma, storage, gql, http, seedUser, seedCaregiver, close };
}

export type Harness = Awaited<ReturnType<typeof bootstrap>>;
export type SeededUser = Awaited<ReturnType<Harness['seedUser']>>;
export type SeededCaregiver = Awaited<ReturnType<Harness['seedCaregiver']>>;
