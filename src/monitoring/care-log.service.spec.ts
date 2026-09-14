/**
 * Unit tests สำหรับ CareLogService (PYG-361 / PYG-466)
 *
 * ครอบคลุม:
 *  A. createCareLog — ด่านสิทธิ์, ช่วง deviceTs, ตรวจไฟล์, upload → insert → cleanup
 *  B. careLogs — sign จาก bucket ตาม photo_bucket (แถวเก่า/ใหม่) ด้วย admin client
 *  C. addCareLog (deprecated) — ไม่รับ photoUrl, ข้อความล้วนยังได้
 *
 * mock PrismaService / SupabaseService / ClockService ทั้งหมด → ไม่แตะ DB หรือ Supabase จริง
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CareLogService } from './care-log.service';
import { PrismaService } from '../common/prisma.service';
import { SupabaseService } from '../common/supabase.service';
import { ClockService } from '../common/clock.service';
import { CreateCareLogDto } from './dto/create-care-log.dto';
import { AddCareLogInput } from './dto/add-care-log.input';
import { BOOKING_EVENTS } from '../notification/events/booking-event';
import {
  buildJpeg,
  GPS_SECRET,
  PNG_BYTES,
} from '../../test/fixtures/jpeg.fixture';

const USER_ID = 'user-cg-0001';
const PATIENT_ID = 'user-pt-0001';
const CAREGIVER_ID = 'cg-0001';
const OTHER_CAREGIVER_ID = 'cg-9999';
const BOOKING_ID = '11111111-1111-4111-8111-111111111111';

/**
 * งานนัด 09:00 น. ไทย (02:00Z) ของวันที่ 13 มิ.ย. 2026
 * เช็คอินตรงเวลา 02:00Z, ตอนนี้ 02:15Z
 */
const BOOKING_DATE = new Date(Date.UTC(2026, 5, 13));
const START_TIME = new Date('1970-01-01T09:00:00Z');
const SCHEDULED_START = new Date('2026-06-13T02:00:00Z');
const NOW = new Date('2026-06-13T02:15:00Z');

const minutes = (n: number) => n * 60_000;
const at = (base: Date, deltaMin: number) =>
  new Date(base.getTime() + minutes(deltaMin));

function fakeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    caregiverId: CAREGIVER_ID,
    status: 'in_progress',
    patientId: PATIENT_ID,
    bookingDate: BOOKING_DATE,
    startTime: START_TIME,
    jobEvents: [{ serverTs: SCHEDULED_START }],
    ...overrides,
  };
}

function dto(overrides: Partial<CreateCareLogDto> = {}): CreateCareLogDto {
  return {
    category: 'food',
    body: 'ทานข้าวได้ครึ่งจาน',
    deviceTs: NOW.toISOString(),
    ...overrides,
  };
}

const jpegPhoto = (buffer: Buffer = buildJpeg()) => ({
  buffer,
  mimetype: 'image/jpeg',
});

/** ดึง object ที่ log ด้วย event ชื่อนี้ออกมา (logger ของ service log เป็น object) */
function loggedEvent(
  spy: jest.SpyInstance,
  event: string,
): Record<string, unknown> | undefined {
  const call = spy.mock.calls.find(
    ([arg]) =>
      typeof arg === 'object' &&
      arg !== null &&
      (arg as { event?: string }).event === event,
  ) as [Record<string, unknown>] | undefined;
  return call?.[0];
}

describe('CareLogService', () => {
  let service: CareLogService;
  let prisma: {
    caregiver: { findUnique: jest.Mock };
    booking: { findUnique: jest.Mock };
    care_logs: { create: jest.Mock; count: jest.Mock; findMany: jest.Mock };
  };
  let clock: { now: jest.Mock };
  let emitter: { emit: jest.Mock };
  let upload: jest.Mock;
  let remove: jest.Mock;
  let createSignedUrl: jest.Mock;
  let from: jest.Mock;
  let getClient: jest.Mock;
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(async () => {
    upload = jest.fn().mockResolvedValue({ data: { path: 'x' }, error: null });
    remove = jest.fn().mockResolvedValue({ data: [], error: null });
    createSignedUrl = jest.fn().mockImplementation((path: string) =>
      Promise.resolve({
        data: { signedUrl: `https://signed.example/${path}` },
        error: null,
      }),
    );
    from = jest.fn().mockReturnValue({ upload, remove, createSignedUrl });
    getClient = jest.fn();

    prisma = {
      caregiver: {
        findUnique: jest.fn().mockResolvedValue({ id: CAREGIVER_ID }),
      },
      booking: { findUnique: jest.fn().mockResolvedValue(fakeBooking()) },
      care_logs: {
        create: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve({ id: 'log-1', created_at: NOW, ...data }),
          ),
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    clock = { now: jest.fn().mockReturnValue(NOW) };
    emitter = { emit: jest.fn() };

    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        CareLogService,
        { provide: PrismaService, useValue: prisma },
        { provide: ClockService, useValue: clock },
        {
          provide: SupabaseService,
          useValue: {
            getAdminClient: () => ({ storage: { from } }),
            getClient,
          },
        },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();

    service = mod.get(CareLogService);
  });

  afterEach(() => jest.restoreAllMocks());

  // ═══════════════════════════════════════════════════════════════════════
  describe('createCareLog — ด่านสิทธิ์', () => {
    it('ไม่มีโปรไฟล์ผู้ดูแล → 403', async () => {
      prisma.caregiver.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.createCareLog(USER_ID, BOOKING_ID, dto(), jpegPhoto()),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(upload).not.toHaveBeenCalled();
    });

    it('ไม่พบ booking → 404', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.createCareLog(USER_ID, BOOKING_ID, dto()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('booking ของผู้ดูแลคนอื่น → 403 และไม่อัปโหลดอะไร', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(
        fakeBooking({ caregiverId: OTHER_CAREGIVER_ID }),
      );
      await expect(
        service.createCareLog(USER_ID, BOOKING_ID, dto(), jpegPhoto()),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(upload).not.toHaveBeenCalled();
      expect(prisma.care_logs.create).not.toHaveBeenCalled();
    });

    it.each(['confirmed', 'awaiting_release', 'needs_review'])(
      'status = %s (ไม่ใช่ in_progress) → 422',
      async (status) => {
        prisma.booking.findUnique.mockResolvedValueOnce(
          fakeBooking({ status }),
        );
        await expect(
          service.createCareLog(USER_ID, BOOKING_ID, dto(), jpegPhoto()),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);
        expect(upload).not.toHaveBeenCalled();
      },
    );

    it('ดึงเวลาเช็คอินมาพร้อม query ตรวจสิทธิ์ (ไม่เพิ่ม round trip) — ใช้แถวล่าสุด, server_ts เท่านั้น', async () => {
      await service.createCareLog(USER_ID, BOOKING_ID, dto());

      expect(prisma.booking.findUnique).toHaveBeenCalledTimes(1);
      const [args] = prisma.booking.findUnique.mock.calls[0] as [
        { select: { jobEvents: Record<string, unknown> } },
      ];
      expect(args.select.jobEvents).toEqual({
        where: { eventType: 'check_in' },
        orderBy: { serverTs: 'desc' },
        take: 1,
        select: { serverTs: true },
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe('createCareLog — ช่วง deviceTs', () => {
    it('เช็คอินเช้ากว่านัด 40 นาที แล้วบันทึกทันที → ผ่าน', async () => {
      const checkIn = at(SCHEDULED_START, -40);
      prisma.booking.findUnique.mockResolvedValueOnce(
        fakeBooking({ jobEvents: [{ serverTs: checkIn }] }),
      );
      clock.now.mockReturnValue(checkIn);

      await expect(
        service.createCareLog(
          USER_ID,
          BOOKING_ID,
          dto({ deviceTs: checkIn.toISOString() }),
        ),
      ).resolves.toMatchObject({ bookingId: BOOKING_ID });
    });

    it('เช็คอินเช้ากว่านัด 90 นาที (ติดธงแต่เข้างานได้) แล้วบันทึกทันที → ผ่าน', async () => {
      const checkIn = at(SCHEDULED_START, -90);
      prisma.booking.findUnique.mockResolvedValueOnce(
        fakeBooking({ jobEvents: [{ serverTs: checkIn }] }),
      );
      clock.now.mockReturnValue(checkIn);

      await expect(
        service.createCareLog(
          USER_ID,
          BOOKING_ID,
          dto({ deviceTs: checkIn.toISOString() }),
        ),
      ).resolves.toMatchObject({ bookingId: BOOKING_ID });
    });

    it('deviceTs ก่อนเวลาเช็คอินจริงพอดี 10 นาที → ผ่าน (ขอบรวม)', async () => {
      await expect(
        service.createCareLog(
          USER_ID,
          BOOKING_ID,
          dto({ deviceTs: at(SCHEDULED_START, -10).toISOString() }),
        ),
      ).resolves.toBeDefined();
    });

    it('deviceTs ก่อนเวลาเช็คอินจริงเกิน 10 นาที → 422 พร้อมบอกช่วงที่ยอมรับ', async () => {
      const promise = service.createCareLog(
        USER_ID,
        BOOKING_ID,
        dto({ deviceTs: at(SCHEDULED_START, -11).toISOString() }),
        jpegPhoto(),
      );

      await expect(promise).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      await expect(promise).rejects.toThrow(
        at(SCHEDULED_START, -10).toISOString(),
      );
      await expect(promise).rejects.toThrow(at(NOW, 10).toISOString());
      expect(upload).not.toHaveBeenCalled();
    });

    it('deviceTs ล่วงหน้าเกิน 10 นาที → 422', async () => {
      await expect(
        service.createCareLog(
          USER_ID,
          BOOKING_ID,
          dto({ deviceTs: at(NOW, 11).toISOString() }),
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('ไม่มีแถว check_in แต่ in_progress → ใช้ fallback (นัด − 60 − 10) + log event ห้าม throw', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(
        fakeBooking({ jobEvents: [] }),
      );

      await expect(
        service.createCareLog(
          USER_ID,
          BOOKING_ID,
          dto({ deviceTs: at(SCHEDULED_START, -70).toISOString() }),
        ),
      ).resolves.toBeDefined();

      expect(loggedEvent(warnSpy, 'care_log.missing_check_in_event')).toEqual({
        event: 'care_log.missing_check_in_event',
        bookingId: BOOKING_ID,
      });
    });

    it('fallback ก็ยังมีขอบ: ก่อน (นัด − 70 นาที) → 422', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(
        fakeBooking({ jobEvents: [] }),
      );

      await expect(
        service.createCareLog(
          USER_ID,
          BOOKING_ID,
          dto({ deviceTs: at(SCHEDULED_START, -71).toISOString() }),
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('เก็บ deviceTs ตามที่ส่งมา และ server_ts จาก clock ของเซิร์ฟเวอร์', async () => {
      const deviceTs = at(NOW, -3);
      await service.createCareLog(
        USER_ID,
        BOOKING_ID,
        dto({ deviceTs: deviceTs.toISOString() }),
      );

      expect(prisma.care_logs.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          server_ts: NOW,
          device_ts: deviceTs,
        }) as unknown,
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe('createCareLog — ตรวจไฟล์', () => {
    it('MIME ไม่ใช่ image/jpeg → 415', async () => {
      await expect(
        service.createCareLog(USER_ID, BOOKING_ID, dto(), {
          buffer: PNG_BYTES,
          mimetype: 'image/png',
        }),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
      expect(upload).not.toHaveBeenCalled();
    });

    it('MIME ปลอมเป็น image/jpeg แต่ signature ไม่ใช่ JPEG → 415', async () => {
      await expect(
        service.createCareLog(USER_ID, BOOKING_ID, dto(), jpegPhoto(PNG_BYTES)),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
      expect(upload).not.toHaveBeenCalled();
      expect(prisma.care_logs.create).not.toHaveBeenCalled();
    });

    it('ไฟล์ว่าง → 400', async () => {
      await expect(
        service.createCareLog(
          USER_ID,
          BOOKING_ID,
          dto(),
          jpegPhoto(Buffer.alloc(0)),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('signature ถูกแต่โครงสร้างเสีย → 415', async () => {
      const broken = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x7f, 0xff, 0x00]);
      await expect(
        service.createCareLog(USER_ID, BOOKING_ID, dto(), jpegPhoto(broken)),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
      expect(upload).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe('createCareLog — happy path', () => {
    it('มีรูป: backend ตั้ง path เอง, อัปโหลดเข้า care-log-images แบบไม่มี Exif, insert พร้อม bucket, คืน signed URL', async () => {
      const result = await service.createCareLog(
        USER_ID,
        BOOKING_ID,
        dto(),
        jpegPhoto(),
      );

      expect(from).toHaveBeenCalledWith('care-log-images');
      expect(from).not.toHaveBeenCalledWith('job-evidence');

      const [path, bytes, options] = upload.mock.calls[0] as [
        string,
        Buffer,
        Record<string, unknown>,
      ];
      expect(path).toMatch(
        new RegExp(
          `^${BOOKING_ID}/care-log-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.jpg$`,
        ),
      );
      expect(options).toEqual({ contentType: 'image/jpeg', upsert: false });
      expect(bytes.includes(Buffer.from(GPS_SECRET))).toBe(false);
      expect(bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(
        true,
      );

      expect(prisma.care_logs.create).toHaveBeenCalledWith({
        data: {
          booking_id: BOOKING_ID,
          caregiver_id: CAREGIVER_ID,
          category: 'food',
          body: 'ทานข้าวได้ครึ่งจาน',
          photo_url: path,
          photo_bucket: 'care-log-images',
          server_ts: NOW,
          device_ts: NOW,
        },
      });

      expect(createSignedUrl).toHaveBeenCalledWith(path, 3600);
      expect(result).toEqual({
        id: 'log-1',
        bookingId: BOOKING_ID,
        category: 'food',
        body: 'ทานข้าวได้ครึ่งจาน',
        photoUrl: `https://signed.example/${path}`,
        serverTs: NOW,
        deviceTs: NOW,
      });
      // sign ด้วย service-role เท่านั้น ไม่ใช่ anon client
      expect(getClient).not.toHaveBeenCalled();
    });

    it('ไม่มีรูป: ไม่แตะ storage, photo_url/photo_bucket เป็น null', async () => {
      const result = await service.createCareLog(USER_ID, BOOKING_ID, dto());

      expect(upload).not.toHaveBeenCalled();
      expect(createSignedUrl).not.toHaveBeenCalled();
      expect(prisma.care_logs.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          photo_url: null,
          photo_bucket: null,
        }) as unknown,
      });
      expect(result.photoUrl).toBeUndefined();
    });

    it('รายการแรกของงาน → ยิง JOB_CARE_LOG_ADDED (path emit เดิม)', async () => {
      await service.createCareLog(USER_ID, BOOKING_ID, dto());

      expect(emitter.emit).toHaveBeenCalledWith(
        BOOKING_EVENTS.JOB_CARE_LOG_ADDED,
        {
          bookingId: BOOKING_ID,
          eventType: BOOKING_EVENTS.JOB_CARE_LOG_ADDED,
          patientId: PATIENT_ID,
          caregiverId: USER_ID,
          metadata: { category: 'food' },
        },
      );
    });

    it('ไม่ใช่รายการแรก → ไม่ยิง event', async () => {
      prisma.care_logs.count.mockResolvedValueOnce(2);
      await service.createCareLog(USER_ID, BOOKING_ID, dto());
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe('createCareLog — ความล้มเหลวของ storage / insert', () => {
    it('upload ล้ม → 500 และไม่มี care log เกิดขึ้น', async () => {
      upload.mockResolvedValueOnce({
        data: null,
        error: new Error('storage down'),
      });

      await expect(
        service.createCareLog(USER_ID, BOOKING_ID, dto(), jpegPhoto()),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(prisma.care_logs.create).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
      expect(loggedEvent(errorSpy, 'care_log.upload_failed')).toMatchObject({
        bucket: 'care-log-images',
        bookingId: BOOKING_ID,
      });
    });

    it('insert ล้ม → ลบไฟล์ที่เพิ่งอัปโหลด แล้ว throw error ของ insert', async () => {
      const insertError = new Error('insert failed');
      prisma.care_logs.create.mockRejectedValueOnce(insertError);

      await expect(
        service.createCareLog(USER_ID, BOOKING_ID, dto(), jpegPhoto()),
      ).rejects.toBe(insertError);

      const [uploadedPath] = upload.mock.calls[0] as [string];
      expect(remove).toHaveBeenCalledWith([uploadedPath]);
      expect(loggedEvent(errorSpy, 'care_log.orphan_file')).toBeUndefined();
    });

    it('insert ล้ม + ลบไฟล์ไม่สำเร็จ (error) → client ยังได้ error ของ insert + log care_log.orphan_file', async () => {
      const insertError = new Error('insert failed');
      prisma.care_logs.create.mockRejectedValueOnce(insertError);
      remove.mockResolvedValueOnce({
        data: null,
        error: new Error('remove failed'),
      });

      await expect(
        service.createCareLog(USER_ID, BOOKING_ID, dto(), jpegPhoto()),
      ).rejects.toBe(insertError);

      const [uploadedPath] = upload.mock.calls[0] as [string];
      expect(loggedEvent(errorSpy, 'care_log.orphan_file')).toEqual({
        event: 'care_log.orphan_file',
        bucket: 'care-log-images',
        path: uploadedPath,
        bookingId: BOOKING_ID,
        reason: 'remove failed',
      });
    });

    it('insert ล้ม + remove throw → client ยังได้ error ของ insert + log care_log.orphan_file', async () => {
      const insertError = new Error('insert failed');
      prisma.care_logs.create.mockRejectedValueOnce(insertError);
      remove.mockRejectedValueOnce(new Error('network reset'));

      await expect(
        service.createCareLog(USER_ID, BOOKING_ID, dto(), jpegPhoto()),
      ).rejects.toBe(insertError);
      expect(loggedEvent(errorSpy, 'care_log.orphan_file')).toMatchObject({
        reason: 'network reset',
      });
    });

    it('insert ล้มโดยไม่มีรูป → ไม่เรียก remove', async () => {
      const insertError = new Error('insert failed');
      prisma.care_logs.create.mockRejectedValueOnce(insertError);

      await expect(
        service.createCareLog(USER_ID, BOOKING_ID, dto()),
      ).rejects.toBe(insertError);
      expect(remove).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe('careLogs — read path รองรับแถวเก่าและใหม่', () => {
    const row = (
      id: string,
      photo_url: string | null,
      photo_bucket: string | null,
    ) => ({
      id,
      booking_id: BOOKING_ID,
      caregiver_id: CAREGIVER_ID,
      category: 'food',
      body: 'x',
      photo_url,
      photo_bucket,
      server_ts: NOW,
      device_ts: null,
      created_at: NOW,
    });

    beforeEach(() => {
      prisma.booking.findUnique.mockResolvedValue({
        id: BOOKING_ID,
        patientId: PATIENT_ID,
        caregiver: { userId: USER_ID },
      });
    });

    it('เลือก bucket จาก photo_bucket (NULL = job-evidence) และ sign ด้วย admin client', async () => {
      prisma.care_logs.findMany.mockResolvedValueOnce([
        row('new', `${BOOKING_ID}/care-log-a.jpg`, 'care-log-images'),
        row(
          'legacy-backfilled',
          `${BOOKING_ID}/check-out-1.jpg`,
          'job-evidence',
        ),
        row('legacy-null', `${BOOKING_ID}/care-log-b.jpg`, null),
        row('text-only', null, null),
      ]);

      const logs = await service.careLogs(PATIENT_ID, 1, BOOKING_ID);

      expect(from.mock.calls.map(([bucket]) => bucket as string)).toEqual([
        'care-log-images',
        'job-evidence',
        'job-evidence',
      ]);
      expect(logs.map((l) => l.photoUrl)).toEqual([
        `https://signed.example/${BOOKING_ID}/care-log-a.jpg`,
        `https://signed.example/${BOOKING_ID}/check-out-1.jpg`,
        `https://signed.example/${BOOKING_ID}/care-log-b.jpg`,
        undefined,
      ]);
      expect(getClient).not.toHaveBeenCalled();
    });

    it('ผู้ดูแลเจ้าของงานได้ signed URL เหมือนกัน', async () => {
      prisma.care_logs.findMany.mockResolvedValueOnce([
        row('new', `${BOOKING_ID}/care-log-a.jpg`, 'care-log-images'),
      ]);
      const [log] = await service.careLogs(USER_ID, 2, BOOKING_ID);
      expect(log.photoUrl).toBe(
        `https://signed.example/${BOOKING_ID}/care-log-a.jpg`,
      );
    });

    it('sign ไม่สำเร็จ → photoUrl ว่าง + log แต่ไม่ทำให้ทั้งรายการล้ม', async () => {
      prisma.care_logs.findMany.mockResolvedValueOnce([
        row('new', `${BOOKING_ID}/care-log-a.jpg`, 'care-log-images'),
      ]);
      createSignedUrl.mockResolvedValueOnce({
        data: null,
        error: new Error('not found'),
      });

      const [log] = await service.careLogs(PATIENT_ID, 1, BOOKING_ID);

      expect(log.photoUrl).toBeUndefined();
      expect(loggedEvent(warnSpy, 'care_log.sign_url_failed')).toMatchObject({
        bucket: 'care-log-images',
      });
    });

    it('ไม่ใช่คู่กรณี → 403', async () => {
      await expect(
        service.careLogs('stranger', 1, BOOKING_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  describe('addCareLog (deprecated)', () => {
    const input = (
      overrides: Partial<AddCareLogInput> = {},
    ): AddCareLogInput => ({
      bookingId: BOOKING_ID,
      category: 'food',
      body: 'ทานข้าวได้ครึ่งจาน',
      ...overrides,
    });

    it('ส่ง photoUrl มา → 400 และไม่มีแถวเกิดขึ้น', async () => {
      await expect(
        service.addCareLog(
          USER_ID,
          input({ photoUrl: `${BOOKING_ID}/care-log-1.jpg` }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.care_logs.create).not.toHaveBeenCalled();
      expect(upload).not.toHaveBeenCalled();
    });

    it('status ไม่ใช่ in_progress → ยังคง 400 ตามพฤติกรรมเดิม (ไม่เปลี่ยนเป็น 422)', async () => {
      prisma.booking.findUnique.mockResolvedValueOnce(
        fakeBooking({ status: 'confirmed' }),
      );
      await expect(service.addCareLog(USER_ID, input())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('ข้อความล้วนยังบันทึกได้ — photo_url/photo_bucket เป็น null', async () => {
      const result = await service.addCareLog(USER_ID, input());

      expect(prisma.care_logs.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          photo_url: null,
          photo_bucket: null,
        }) as unknown,
      });
      expect(result.photoUrl).toBeUndefined();
      expect(emitter.emit).toHaveBeenCalledWith(
        BOOKING_EVENTS.JOB_CARE_LOG_ADDED,
        expect.anything(),
      );
    });
  });
});
