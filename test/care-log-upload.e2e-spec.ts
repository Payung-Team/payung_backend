/**
 * E2E (HTTP) — POST /api/v1/monitoring/bookings/:bookingId/care-logs (PYG-466)
 *
 * ยิงผ่าน supertest เข้า Nest app ที่มีแค่ CareLogController:
 *   guard ตัวจริง (SupabaseHttpAuthGuard + HttpRolesGuard) / multer ตัวจริง / ValidationPipe config เดียวกับ main.ts
 *   mock: SupabaseService (auth + storage), PrismaService, ClockService → ไม่แตะ DB หรือ Supabase จริง
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import request from 'supertest';
import { App } from 'supertest/types';
import { CareLogController } from '../src/monitoring/care-log.controller';
import { CareLogService } from '../src/monitoring/care-log.service';
import { PrismaService } from '../src/common/prisma.service';
import { SupabaseService } from '../src/common/supabase.service';
import { ClockService } from '../src/common/clock.service';
import {
  APP2_ICC,
  buildJpeg,
  GPS_SECRET,
  MOTION_PHOTO_TRAILER,
  PNG_BYTES,
} from './fixtures/jpeg.fixture';

const BOOKING_ID = '11111111-1111-4111-8111-111111111111';
const URL = `/api/v1/monitoring/bookings/${BOOKING_ID}/care-logs`;
const NOW = new Date('2026-06-13T02:15:00Z');
const CHECK_IN_AT = new Date('2026-06-13T02:00:00Z');

/** token → ผู้ใช้ใน DB */
const USERS: Record<
  string,
  { supabaseUid: string; row: Record<string, unknown> }
> = {
  'caregiver-token': {
    supabaseUid: 'sb-cg',
    row: {
      id: 'user-cg',
      supabaseUid: 'sb-cg',
      email: 'cg@x.test',
      role: 2,
      isActive: true,
      is_deleted: false,
    },
  },
  'patient-token': {
    supabaseUid: 'sb-pt',
    row: {
      id: 'user-pt',
      supabaseUid: 'sb-pt',
      email: 'pt@x.test',
      role: 1,
      isActive: true,
      is_deleted: false,
    },
  },
  'suspended-token': {
    supabaseUid: 'sb-cg-suspended',
    row: {
      id: 'user-cg-2',
      supabaseUid: 'sb-cg-suspended',
      email: 'cg2@x.test',
      role: 2,
      isActive: false,
      is_deleted: false,
    },
  },
};

function fakeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    caregiverId: 'cg-1',
    status: 'in_progress',
    patientId: 'user-pt',
    bookingDate: new Date(Date.UTC(2026, 5, 13)),
    startTime: new Date('1970-01-01T09:00:00Z'),
    jobEvents: [{ serverTs: CHECK_IN_AT }],
    ...overrides,
  };
}

describe('POST /api/v1/monitoring/bookings/:bookingId/care-logs (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: {
    user: { findUnique: jest.Mock };
    caregiver: { findUnique: jest.Mock };
    booking: { findUnique: jest.Mock };
    care_logs: { create: jest.Mock; count: jest.Mock };
  };
  let upload: jest.Mock;
  let remove: jest.Mock;
  let createSignedUrl: jest.Mock;
  let errorSpy: jest.SpyInstance;

  beforeEach(async () => {
    upload = jest.fn().mockResolvedValue({ data: { path: 'x' }, error: null });
    remove = jest.fn().mockResolvedValue({ data: [], error: null });
    createSignedUrl = jest.fn().mockImplementation((path: string) =>
      Promise.resolve({
        data: { signedUrl: `https://signed.example/${path}` },
        error: null,
      }),
    );

    prisma = {
      user: {
        findUnique: jest
          .fn()
          .mockImplementation(
            ({ where }: { where: { supabaseUid: string } }) => {
              const hit = Object.values(USERS).find(
                (u) => u.supabaseUid === where.supabaseUid,
              );
              return Promise.resolve(hit?.row ?? null);
            },
          ),
      },
      caregiver: { findUnique: jest.fn().mockResolvedValue({ id: 'cg-1' }) },
      booking: { findUnique: jest.fn().mockResolvedValue(fakeBooking()) },
      care_logs: {
        create: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve({ id: 'log-1', created_at: NOW, ...data }),
          ),
        count: jest.fn().mockResolvedValue(1),
      },
    };

    const supabase = {
      getClient: () => ({
        auth: {
          getUser: (token: string) =>
            Promise.resolve(
              USERS[token]
                ? {
                    data: { user: { id: USERS[token].supabaseUid } },
                    error: null,
                  }
                : { data: { user: null }, error: new Error('invalid token') },
            ),
        },
      }),
      getAdminClient: () => ({
        storage: {
          from: jest.fn().mockReturnValue({ upload, remove, createSignedUrl }),
        },
      }),
    };

    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [CareLogController],
      providers: [
        CareLogService,
        { provide: PrismaService, useValue: prisma },
        { provide: SupabaseService, useValue: supabase },
        { provide: ClockService, useValue: { now: () => NOW } },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    // ★ ต้องตรงกับ src/main.ts ทุก option — ห้าม import bootstrap (มัน listen port จริง)
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  /** request ที่ถูกต้องครบ — แต่ละเทสค่อยแก้ทีละจุด */
  const post = (token: string | null = 'caregiver-token', url = URL) => {
    const req = request(app.getHttpServer()).post(url);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };
  const validFields = (
    req: request.Test,
    overrides: Record<string, string> = {},
  ) => {
    const fields = {
      category: 'food',
      body: 'ทานข้าวได้ครึ่งจาน',
      deviceTs: NOW.toISOString(),
      ...overrides,
    };
    for (const [k, v] of Object.entries(fields)) req.field(k, v);
    return req;
  };
  const withJpeg = (
    req: request.Test,
    buffer: Buffer = buildJpeg(),
    contentType = 'image/jpeg',
  ) => req.attach('photo', buffer, { filename: 'photo.jpg', contentType });

  // ═══════════════════════════════════════════════════════════════════════
  describe('authorization', () => {
    it('ไม่มี token → 401', async () => {
      await validFields(post(null)).expect(401);
      expect(upload).not.toHaveBeenCalled();
    });

    it('token ไม่ถูกต้อง → 401', async () => {
      await validFields(post('bogus')).expect(401);
    });

    it('role ผิด (patient) → 403', async () => {
      await withJpeg(validFields(post('patient-token'))).expect(403);
      expect(upload).not.toHaveBeenCalled();
    });

    it('บัญชีถูกระงับ → 403', async () => {
      await validFields(post('suspended-token')).expect(403);
    });

    it('booking ของผู้ดูแลคนอื่น → 403 และไม่มีไฟล์ขึ้น storage', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(
        fakeBooking({ caregiverId: 'cg-other' }),
      );
      await withJpeg(validFields(post())).expect(403);
      expect(upload).not.toHaveBeenCalled();
    });

    it('ไม่พบ booking → 404', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(null);
      await validFields(post()).expect(404);
    });

    it('status ไม่ใช่ in_progress → 422', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(
        fakeBooking({ status: 'confirmed' }),
      );
      const res = await withJpeg(validFields(post())).expect(422);
      expect(res.body).toMatchObject({
        statusCode: 422,
        message: 'ต้องเช็คอินก่อนจึงจะบันทึกได้',
      });
      expect(upload).not.toHaveBeenCalled();
    });

    it('bookingId ไม่ใช่ UUID → 400', async () => {
      await validFields(
        post(
          'caregiver-token',
          '/api/v1/monitoring/bookings/not-a-uuid/care-logs',
        ),
      ).expect(400);
      expect(prisma.booking.findUnique).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe('validation', () => {
    it('MIME ปลอม (image/jpeg) แต่ signature เป็น PNG → 415', async () => {
      const res = await withJpeg(validFields(post()), PNG_BYTES).expect(415);
      expect(res.body).toMatchObject({
        statusCode: 415,
        error: 'Unsupported Media Type',
      });
      expect(upload).not.toHaveBeenCalled();
    });

    it('MIME image/png → 415', async () => {
      await withJpeg(validFields(post()), PNG_BYTES, 'image/png').expect(415);
      expect(upload).not.toHaveBeenCalled();
    });

    it('JPEG ไม่มี EOI (ไฟล์ถูกตัดท้าย) → 415', async () => {
      const res = await withJpeg(
        validFields(post()),
        buildJpeg().subarray(0, -2),
      ).expect(415);
      expect(res.body).toMatchObject({
        statusCode: 415,
        message: 'ไฟล์ JPEG เสียหาย',
      });
      expect(upload).not.toHaveBeenCalled();
      expect(prisma.care_logs.create).not.toHaveBeenCalled();
    });

    it('ไฟล์เกิน 5 MB → 413 (multer ตัดตั้งแต่ชั้นรับ)', async () => {
      const big = Buffer.concat([buildJpeg(), Buffer.alloc(5 * 1024 * 1024)]);
      await withJpeg(validFields(post()), big).expect(413);
      expect(upload).not.toHaveBeenCalled();
      expect(prisma.care_logs.create).not.toHaveBeenCalled();
    });

    it('ส่งมา 2 ไฟล์ → 400', async () => {
      const res = await withJpeg(withJpeg(validFields(post()))).expect(400);
      expect(res.body).toMatchObject({
        statusCode: 400,
        message: 'Too many files',
      });
      expect(upload).not.toHaveBeenCalled();
    });

    it('ไฟล์อยู่ใน field ชื่ออื่น → 400', async () => {
      await validFields(post())
        .attach('image', buildJpeg(), {
          filename: 'photo.jpg',
          contentType: 'image/jpeg',
        })
        .expect(400);
    });

    it('field เกินที่ประกาศ → 400', async () => {
      await validFields(post(), { extra: 'x' }).expect(400);
      expect(prisma.care_logs.create).not.toHaveBeenCalled();
    });

    it('body ว่าง / มีแต่ช่องว่าง → 400', async () => {
      const res = await validFields(post(), { body: '   \n  ' }).expect(400);
      expect(res.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
      expect((res.body as { message: string[] }).message).toContain(
        'กรุณากรอกข้อความบันทึก',
      );
    });

    it('body 501 ตัวอักษร → 400', async () => {
      const res = await validFields(post(), { body: 'ก'.repeat(501) }).expect(
        400,
      );
      expect((res.body as { message: string[] }).message).toContain(
        'ข้อความยาวเกินกำหนด (สูงสุด 500 ตัวอักษร)',
      );
    });

    it('body 500 code point (emoji = 1000 UTF-16) → ผ่าน เพราะนับแบบเดียวกับ char_length', async () => {
      await validFields(post(), { body: '😀'.repeat(500) }).expect(201);
    });

    it('trim ก่อนนับและเก็บค่าที่ trim แล้ว', async () => {
      await validFields(post(), { body: `  ${'ก'.repeat(500)}  ` }).expect(201);
      expect(prisma.care_logs.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ body: 'ก'.repeat(500) }) as unknown,
      });
    });

    it('category นอก enum → 400', async () => {
      await validFields(post(), { category: 'gossip' }).expect(400);
    });

    it('ไม่ส่ง deviceTs → 400', async () => {
      await post().field('category', 'food').field('body', 'x').expect(400);
    });

    it('deviceTs นอกช่วง → 422 พร้อมบอกช่วงที่ยอมรับ', async () => {
      const res = await validFields(post(), {
        deviceTs: '2026-06-13T01:49:00.000Z',
      }).expect(422);
      const { message } = res.body as { message: string };
      expect(message).toContain('2026-06-13T01:50:00.000Z');
      expect(message).toContain('2026-06-13T02:25:00.000Z');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe('happy path', () => {
    it('มีรูป → 201 + signed URL, รูปที่ขึ้น storage ไม่มี GPS', async () => {
      const res = await withJpeg(validFields(post())).expect(201);

      const [path, bytes] = upload.mock.calls[0] as [string, Buffer];
      expect(path).toMatch(
        new RegExp(`^${BOOKING_ID}/care-log-[0-9a-f-]{36}\\.jpg$`),
      );
      expect(bytes.includes(Buffer.from(GPS_SECRET))).toBe(false);
      expect(res.body).toEqual({
        id: 'log-1',
        bookingId: BOOKING_ID,
        category: 'food',
        body: 'ทานข้าวได้ครึ่งจาน',
        photoUrl: `https://signed.example/${path}`,
        serverTs: NOW.toISOString(),
        deviceTs: NOW.toISOString(),
      });
    });

    it('motion photo + MPF + ภาพที่สองต่อท้าย → ที่ขึ้น storage จบที่ FF D9 พอดี, ไม่มีพิกัด, ICC อยู่', async () => {
      await withJpeg(
        validFields(post()),
        buildJpeg({ icc: true, mpf: true, trailer: true }),
      ).expect(201);

      const [, bytes] = upload.mock.calls[0] as [string, Buffer];
      expect(bytes.subarray(-2).equals(Buffer.from([0xff, 0xd9]))).toBe(true);
      expect(bytes.includes(MOTION_PHOTO_TRAILER)).toBe(false);
      expect(bytes.includes(Buffer.from('+13.7768+100.5793'))).toBe(false);
      expect(bytes.includes(Buffer.from('MPF\0', 'latin1'))).toBe(false);
      expect(bytes.includes(APP2_ICC)).toBe(true);
    });

    it('ไม่มีรูป → 201 ไม่แตะ storage', async () => {
      const res = await validFields(post()).expect(201);
      expect(upload).not.toHaveBeenCalled();
      expect((res.body as { photoUrl?: string }).photoUrl).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe('failure', () => {
    it('upload ล้ม → 500 และไม่มี row', async () => {
      upload.mockResolvedValueOnce({
        data: null,
        error: new Error('storage down'),
      });
      await withJpeg(validFields(post())).expect(500);
      expect(prisma.care_logs.create).not.toHaveBeenCalled();
    });

    it('insert ล้ม → 500 และไฟล์ถูกลบ', async () => {
      prisma.care_logs.create.mockRejectedValueOnce(new Error('insert failed'));
      await withJpeg(validFields(post())).expect(500);

      const [path] = upload.mock.calls[0] as [string];
      expect(remove).toHaveBeenCalledWith([path]);
    });

    it('insert ล้ม + ลบไฟล์ไม่สำเร็จ → client ยังได้ 500 ของ insert + log care_log.orphan_file', async () => {
      prisma.care_logs.create.mockRejectedValueOnce(new Error('insert failed'));
      remove.mockResolvedValueOnce({
        data: null,
        error: new Error('remove failed'),
      });

      const res = await withJpeg(validFields(post())).expect(500);
      expect(res.body).toEqual({
        statusCode: 500,
        message: 'Internal server error',
      });

      const [path] = upload.mock.calls[0] as [string];
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'care_log.orphan_file',
          bucket: 'care-log-images',
          path,
          bookingId: BOOKING_ID,
        }),
      );
    });
  });
});
