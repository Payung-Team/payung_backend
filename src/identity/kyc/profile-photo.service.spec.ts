/**
 * Unit tests สำหรับ ProfilePhotoService (PYG-507 / การ์ดแม่ PYG-488)
 *
 * ธีมที่ทดสอบ:
 *   - ผู้ดูแลอัปโหลด → เข้าคิวรีวิว (kyc_documents pending) และ users.avatar_url **ไม่เปลี่ยน**
 *   - role อื่นอัปโหลด → avatar_url เปลี่ยนทันที
 *   - ไฟล์ที่ไม่ใช่ JPEG จริง ถูกปฏิเสธตั้งแต่ signature (ไม่เชื่อ mimetype)
 *   - EXIF/GPS ถูกตัดก่อนขึ้น storage
 *   - เขียน DB ล้ม → ไฟล์ที่เพิ่งอัปโหลดถูกลบ ไม่ทิ้งขยะใน bucket
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ProfilePhotoService } from './profile-photo.service';
import { PrismaService } from '../../common/prisma.service';
import { SupabaseService } from '../../common/supabase.service';
import { ROLE_ID } from '../../common/constants/roles.constant';

const USER_ID = 'user-0001';
const CAREGIVER_ID = 'cg-0001';

/** JPEG เล็กที่สุดที่ผ่าน util ของ PYG-466: SOI + APP1(Exif ปลอม) + SOS + EOI */
function jpegWithExif(): Buffer {
  const exifPayload = Buffer.from('Exif\0\0GPSFAKE', 'binary');
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), // SOI
    Buffer.from([0xff, 0xe1]), // APP1
    Buffer.from([0x00, exifPayload.length + 2]),
    exifPayload,
    Buffer.from([0xff, 0xda, 0x00, 0x02]), // SOS
    Buffer.from([0x11, 0x22, 0x33]), // entropy data
    Buffer.from([0xff, 0xd9]), // EOI
  ]);
}

function photoFile(buffer: Buffer, mimetype = 'image/jpeg') {
  return { buffer, mimetype, size: buffer.length, originalname: 'p.jpg' };
}

/** ดึง argument ของการเรียก mock แบบมี type — เลี่ยง any ของ mock.calls (eslint no-unsafe-member-access) */
function callArg<T>(mock: jest.Mock, callIndex = 0, argIndex = 0): T {
  const calls = mock.mock.calls as unknown as T[][];
  return calls[callIndex][argIndex];
}

describe('ProfilePhotoService (PYG-507)', () => {
  let service: ProfilePhotoService;
  let prisma: {
    caregiver: { findUnique: jest.Mock };
    user: { findUnique: jest.Mock; update: jest.Mock };
    kycDocument: {
      findMany: jest.Mock;
      deleteMany: jest.Mock;
      create: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let upload: jest.Mock;
  let remove: jest.Mock;
  let createSignedUrl: jest.Mock;
  let storageFrom: jest.Mock;

  beforeEach(async () => {
    upload = jest.fn().mockResolvedValue({ error: null });
    remove = jest.fn().mockResolvedValue({ error: null });
    createSignedUrl = jest.fn().mockResolvedValue({
      data: { signedUrl: 'https://signed/p.jpg' },
      error: null,
    });
    storageFrom = jest
      .fn()
      .mockReturnValue({ upload, remove, createSignedUrl });

    prisma = {
      caregiver: {
        findUnique: jest.fn().mockResolvedValue({ id: CAREGIVER_ID }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ avatarUrl: null }),
        update: jest.fn().mockResolvedValue({}),
      },
      kycDocument: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({ id: 'doc-1' }),
      },
      // เรียก callback ด้วย prisma ตัวเดียวกัน → assert ผ่าน mock เดิมได้
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) =>
      cb(prisma),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProfilePhotoService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: SupabaseService,
          useValue: {
            getAdminClient: jest.fn().mockReturnValue({
              storage: { from: storageFrom },
            }),
            getClient: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(ProfilePhotoService);
  });

  // ── ผู้ดูแล → เข้าคิวรีวิว ──────────────────────────────────────────────
  it('ผู้ดูแลอัปโหลด → สร้าง kyc_documents pending และไม่แตะ avatar_url', async () => {
    const result = await service.upload(
      USER_ID,
      ROLE_ID.CAREGIVER,
      photoFile(jpegWithExif()),
    );

    expect(result.reviewStatus).toBe('pending');
    expect(result.photoUrl).toBe('https://signed/p.jpg');
    expect(storageFrom).toHaveBeenCalledWith('profile-photos');

    const created = callArg<{ data: Record<string, unknown> }>(
      prisma.kycDocument.create,
    );
    expect(created.data).toMatchObject({
      caregiverId: CAREGIVER_ID,
      userId: USER_ID,
      documentType: 'profile_photo',
      mimeType: 'image/jpeg',
      reviewStatus: 'pending',
    });
    expect(created.data.fileUrl).toMatch(
      new RegExp(`^${USER_ID}/profile-.*\\.jpg$`),
    );
    // ★ หัวใจของการ์ด: ผู้ใช้อื่นต้องยังเห็นรูปเดิม
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('ผู้ดูแลมีรูป pending ค้างอยู่ → ใบเก่าถูกแทน และไฟล์เก่าถูกลบ', async () => {
    prisma.kycDocument.findMany.mockResolvedValue([
      { id: 'doc-old', fileUrl: `${USER_ID}/profile-old.jpg` },
    ]);

    await service.upload(USER_ID, ROLE_ID.CAREGIVER, photoFile(jpegWithExif()));

    expect(prisma.kycDocument.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['doc-old'] } },
    });
    expect(remove).toHaveBeenCalledWith([`${USER_ID}/profile-old.jpg`]);
  });

  it('ไม่พบโปรไฟล์ผู้ดูแล → Forbidden และไม่อัปโหลดไฟล์', async () => {
    prisma.caregiver.findUnique.mockResolvedValue(null);

    await expect(
      service.upload(USER_ID, ROLE_ID.CAREGIVER, photoFile(jpegWithExif())),
    ).rejects.toThrow(ForbiddenException);
    expect(upload).not.toHaveBeenCalled();
  });

  // ── role อื่น → เปลี่ยนทันที ────────────────────────────────────────────
  it('ผู้รับบริการอัปโหลด → avatar_url เปลี่ยนทันที ไม่เข้าคิวรีวิว', async () => {
    const result = await service.upload(
      USER_ID,
      ROLE_ID.PATIENT,
      photoFile(jpegWithExif()),
    );

    expect(result.reviewStatus).toBe('approved');
    expect(prisma.kycDocument.create).not.toHaveBeenCalled();
    const updateArg = callArg<{ data: { avatarUrl: string } }>(
      prisma.user.update,
    );
    expect(updateArg.data.avatarUrl).toMatch(
      new RegExp(`^${USER_ID}/profile-.*\\.jpg$`),
    );
  });

  it('role อื่นเปลี่ยนรูปซ้ำ → ลบไฟล์เดิมใน bucket นี้ แต่ไม่แตะค่า URL ภายนอกของเดิม', async () => {
    prisma.user.findUnique.mockResolvedValue({
      avatarUrl: `${USER_ID}/profile-prev.jpg`,
    });
    await service.upload(USER_ID, ROLE_ID.PATIENT, photoFile(jpegWithExif()));
    expect(remove).toHaveBeenCalledWith([`${USER_ID}/profile-prev.jpg`]);

    remove.mockClear();
    prisma.user.findUnique.mockResolvedValue({
      avatarUrl: 'https://example.com/old-avatar.png',
    });
    await service.upload(USER_ID, ROLE_ID.PATIENT, photoFile(jpegWithExif()));
    expect(remove).not.toHaveBeenCalled();
  });

  // ── ด่านไฟล์ ────────────────────────────────────────────────────────────
  it('ไม่แนบไฟล์ → 400', async () => {
    await expect(
      service.upload(USER_ID, ROLE_ID.PATIENT, undefined),
    ).rejects.toThrow(BadRequestException);
  });

  it('อ้าง mimetype เป็น JPEG แต่ byte ไม่ใช่ → 415 และไม่อัปโหลด', async () => {
    await expect(
      service.upload(USER_ID, ROLE_ID.PATIENT, photoFile(Buffer.from('PNG?'))),
    ).rejects.toThrow(UnsupportedMediaTypeException);
    expect(upload).not.toHaveBeenCalled();
  });

  it('mimetype ที่ไม่ใช่ image/jpeg → 415', async () => {
    await expect(
      service.upload(
        USER_ID,
        ROLE_ID.PATIENT,
        photoFile(jpegWithExif(), 'image/png'),
      ),
    ).rejects.toThrow(UnsupportedMediaTypeException);
  });

  it('EXIF ถูกตัดออกก่อนขึ้น storage', async () => {
    const original = jpegWithExif();
    await service.upload(USER_ID, ROLE_ID.PATIENT, photoFile(original));

    const uploaded = callArg<Buffer>(upload, 0, 1);
    expect(original.includes(Buffer.from('GPSFAKE'))).toBe(true);
    expect(uploaded.includes(Buffer.from('GPSFAKE'))).toBe(false);
    expect(uploaded.length).toBeLessThan(original.length);
  });

  // ── ความคงเส้นคงวาของ storage กับ DB ────────────────────────────────────
  it('อัปโหลด storage ล้ม → 500 และไม่เขียน DB', async () => {
    upload.mockResolvedValue({ error: { message: 'bucket not found' } });

    await expect(
      service.upload(USER_ID, ROLE_ID.PATIENT, photoFile(jpegWithExif())),
    ).rejects.toThrow(InternalServerErrorException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('เขียน DB ล้ม → ลบไฟล์ที่เพิ่งอัปโหลดแล้ว throw error เดิม', async () => {
    prisma.user.update.mockRejectedValue(new Error('db down'));

    await expect(
      service.upload(USER_ID, ROLE_ID.PATIENT, photoFile(jpegWithExif())),
    ).rejects.toThrow('db down');

    const uploadedPath = callArg<string>(upload);
    expect(remove).toHaveBeenCalledWith([uploadedPath]);
  });

  it('sign ล้ม → photoUrl เป็น null แต่คำขอยังสำเร็จ', async () => {
    createSignedUrl.mockResolvedValue({
      data: null,
      error: { message: 'nope' },
    });

    const result = await service.upload(
      USER_ID,
      ROLE_ID.PATIENT,
      photoFile(jpegWithExif()),
    );

    expect(result.reviewStatus).toBe('approved');
    expect(result.photoUrl).toBeNull();
  });
});
