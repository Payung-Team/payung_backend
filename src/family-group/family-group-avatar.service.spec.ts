/**
 * Unit tests สำหรับ FamilyGroupAvatarService — รูปกลุ่มครอบครัว
 *
 * ธีมที่ทดสอบ:
 *   - เจ้าของที่ ACTIVE เท่านั้นที่อัปโหลด/ลบได้ — คนอื่นโดนปฏิเสธก่อนแตะ Storage
 *   - อัปโหลดเขียนทับ path ตายตัวของกลุ่ม พร้อมตัด EXIF/GPS (ตัวตรวจเดียวกับรูปโปรไฟล์)
 *   - ยังไม่ตั้งรูป (Storage ตอบไม่พบไฟล์) → null เงียบ ๆ ไม่ log
 *   - sign ล้มด้วยเหตุอื่น → null + log ไม่ throw ทิ้งทั้ง query
 *   - ลบหลังลบกลุ่มล้ม → แค่ log ไม่ throw
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import {
  FamilyGroupAvatarService,
  familyGroupAvatarPath,
} from './family-group-avatar.service';
import { PrismaService } from '../common/prisma.service';
import { SupabaseService } from '../common/supabase.service';
import { NotGroupOwnerError } from './family-group.errors';

const USER_ID = 'user-0001';
const GROUP_ID = '11111111-1111-4111-8111-111111111111';
const GROUP_PATH = `family-groups/${GROUP_ID}/avatar.jpg`;

/** JPEG เล็กที่สุดที่ผ่าน util ของ PYG-466: SOI + APP1(Exif ปลอม) + SOS + EOI */
function jpegWithExif(): Buffer {
  const exifPayload = Buffer.from('Exif\0\0GPSFAKE', 'binary');
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe1]),
    Buffer.from([0x00, exifPayload.length + 2]),
    exifPayload,
    Buffer.from([0xff, 0xda, 0x00, 0x02]),
    Buffer.from([0x11, 0x22, 0x33]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function photoFile(buffer: Buffer, mimetype = 'image/jpeg') {
  return { buffer, mimetype, size: buffer.length, originalname: 'g.jpg' };
}

/** ดึง argument ของการเรียก mock แบบมี type — เลี่ยง any ของ mock.calls */
function callArg<T>(mock: jest.Mock, callIndex = 0, argIndex = 0): T {
  const calls = mock.mock.calls as unknown as T[][];
  return calls[callIndex][argIndex];
}

describe('FamilyGroupAvatarService', () => {
  let service: FamilyGroupAvatarService;
  let findFirst: jest.Mock;
  let upload: jest.Mock;
  let remove: jest.Mock;
  let createSignedUrl: jest.Mock;
  let storageFrom: jest.Mock;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(async () => {
    findFirst = jest.fn().mockResolvedValue({ id: 'member-owner' });
    upload = jest.fn().mockResolvedValue({ error: null });
    remove = jest.fn().mockResolvedValue({ data: [], error: null });
    createSignedUrl = jest.fn().mockResolvedValue({
      data: { signedUrl: 'https://signed/group.jpg' },
      error: null,
    });
    storageFrom = jest
      .fn()
      .mockReturnValue({ upload, remove, createSignedUrl });
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FamilyGroupAvatarService,
        {
          provide: PrismaService,
          useValue: { familyGroupMember: { findFirst } },
        },
        {
          provide: SupabaseService,
          useValue: {
            getAdminClient: jest
              .fn()
              .mockReturnValue({ storage: { from: storageFrom } }),
            getClient: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(FamilyGroupAvatarService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('path ของรูปกลุ่มตายตัวต่อกลุ่ม', () => {
    expect(familyGroupAvatarPath(GROUP_ID)).toBe(GROUP_PATH);
  });

  // ── อัปโหลด ────────────────────────────────────────────────────────────
  describe('upload', () => {
    it('เจ้าของอัปโหลด → เขียนทับ path ของกลุ่ม (upsert) ใน bucket profile-photos แล้วคืน signed URL', async () => {
      const result = await service.upload(
        USER_ID,
        GROUP_ID,
        photoFile(jpegWithExif()),
      );

      expect(result).toEqual({ avatarUrl: 'https://signed/group.jpg' });
      expect(storageFrom).toHaveBeenCalledWith('profile-photos');
      expect(callArg<string>(upload, 0, 0)).toBe(GROUP_PATH);
      expect(callArg<Record<string, unknown>>(upload, 0, 2)).toEqual({
        contentType: 'image/jpeg',
        upsert: true,
        cacheControl: '60',
      });
      expect(createSignedUrl).toHaveBeenCalledWith(GROUP_PATH, 3600);
    });

    it('ตรวจสิทธิ์ด้วย OWNER ที่ยัง ACTIVE ของกลุ่มนั้น', async () => {
      await service.upload(USER_ID, GROUP_ID, photoFile(jpegWithExif()));

      expect(callArg<{ where: unknown }>(findFirst).where).toEqual({
        groupId: GROUP_ID,
        userId: USER_ID,
        role: 'OWNER',
        status: 'ACTIVE',
      });
    });

    it('ตัด EXIF/GPS ก่อนขึ้น Storage', async () => {
      await service.upload(USER_ID, GROUP_ID, photoFile(jpegWithExif()));

      const uploaded = callArg<Buffer>(upload, 0, 1);
      expect(uploaded.includes(Buffer.from('GPSFAKE'))).toBe(false);
      expect(uploaded.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    });

    it('ไม่ใช่เจ้าของ (หรือไม่มีกลุ่มนี้) → 403 และไม่แตะ Storage', async () => {
      findFirst.mockResolvedValue(null);

      await expect(
        service.upload(USER_ID, GROUP_ID, photoFile(jpegWithExif())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(upload).not.toHaveBeenCalled();
    });

    it('ไม่แนบไฟล์ → 400', async () => {
      await expect(
        service.upload(USER_ID, GROUP_ID, undefined),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(upload).not.toHaveBeenCalled();
    });

    it('ไฟล์ไม่ใช่ JPEG จริง (แม้ mimetype บอก jpeg) → 415', async () => {
      await expect(
        service.upload(USER_ID, GROUP_ID, photoFile(Buffer.from('not a jpeg'))),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
      expect(upload).not.toHaveBeenCalled();
    });

    it('Storage อัปโหลดล้ม → 500 ข้อความไทย และ log', async () => {
      upload.mockResolvedValue({ error: { message: 'boom' } });

      await expect(
        service.upload(USER_ID, GROUP_ID, photoFile(jpegWithExif())),
      ).rejects.toThrow(
        new InternalServerErrorException('อัปโหลดรูปไม่สำเร็จ กรุณาลองใหม่'),
      );
      expect(error).toHaveBeenCalled();
    });
  });

  // ── signed URL ─────────────────────────────────────────────────────────
  describe('signedUrl', () => {
    it('มีรูป → คืน signed URL ของ path กลุ่ม', async () => {
      await expect(service.signedUrl(GROUP_ID)).resolves.toBe(
        'https://signed/group.jpg',
      );
      expect(createSignedUrl).toHaveBeenCalledWith(GROUP_PATH, 3600);
    });

    it('ยังไม่ตั้งรูป (Storage ตอบ statusCode 404) → null และไม่ log', async () => {
      createSignedUrl.mockResolvedValue({
        data: null,
        error: { message: 'Object not found', status: 400, statusCode: '404' },
      });

      await expect(service.signedUrl(GROUP_ID)).resolves.toBeNull();
      expect(warn).not.toHaveBeenCalled();
    });

    it('sign ล้มด้วยเหตุอื่น → null และ log warn', async () => {
      createSignedUrl.mockResolvedValue({
        data: null,
        error: { message: 'service unavailable', status: 503 },
      });

      await expect(service.signedUrl(GROUP_ID)).resolves.toBeNull();
      expect(warn).toHaveBeenCalled();
    });

    it('Storage throw → null ไม่ throw ต่อ', async () => {
      createSignedUrl.mockRejectedValue(new Error('network down'));

      await expect(service.signedUrl(GROUP_ID)).resolves.toBeNull();
      expect(warn).toHaveBeenCalled();
    });
  });

  // ── ลบรูป ──────────────────────────────────────────────────────────────
  describe('remove', () => {
    it('เจ้าของลบ → ลบไฟล์ที่ path ของกลุ่ม', async () => {
      await service.remove(USER_ID, GROUP_ID);

      expect(remove).toHaveBeenCalledWith([GROUP_PATH]);
    });

    it('ไม่ใช่เจ้าของ → NotGroupOwnerError และไม่แตะ Storage', async () => {
      findFirst.mockResolvedValue(null);

      await expect(service.remove(USER_ID, GROUP_ID)).rejects.toBeInstanceOf(
        NotGroupOwnerError,
      );
      expect(remove).not.toHaveBeenCalled();
    });

    it('Storage ลบล้ม → 500 ข้อความไทย', async () => {
      remove.mockResolvedValue({ data: null, error: { message: 'boom' } });

      await expect(service.remove(USER_ID, GROUP_ID)).rejects.toThrow(
        new InternalServerErrorException('ลบรูปกลุ่มไม่สำเร็จ กรุณาลองใหม่'),
      );
    });
  });

  describe('removeQuietly (หลังลบกลุ่ม)', () => {
    it('ลบไฟล์ของกลุ่มโดยไม่ตรวจสิทธิ์ซ้ำ (กลุ่มถูกลบไปแล้ว)', async () => {
      await service.removeQuietly(GROUP_ID);

      expect(remove).toHaveBeenCalledWith([GROUP_PATH]);
      expect(findFirst).not.toHaveBeenCalled();
    });

    it('ลบล้ม/throw → แค่ log ไม่ throw', async () => {
      remove.mockRejectedValue(new Error('network down'));

      await expect(service.removeQuietly(GROUP_ID)).resolves.toBeUndefined();
      expect(error).toHaveBeenCalled();
    });
  });
});
