/**
 * Unit tests สำหรับ AvatarUrlService (PYG-518 / PYG-508)
 *
 * ธีมที่ทดสอบ:
 *   - path ดิบถูก sign ก่อนคืนเสมอ ไม่มีทางหลุดออกไปเป็น path ดิบ
 *   - URL เต็ม (http/https) ผ่านตรง ไม่ยิง sign ซ้ำ
 *   - ทุก role sign กับ bucket เดียว: profile-photos (PYG-508 — ไม่ย้ายไฟล์ตอนอนุมัติ)
 *   - resolveMany() รวมหลาย path เป็น createSignedUrls ครั้งเดียว ไม่ยิงทีละรูป (dedup path ซ้ำด้วย)
 *   - sign ล้ม (ทั้งเดี่ยวและ batch) → คืน null ไม่ throw
 */
import { Test, TestingModule } from '@nestjs/testing';
import { AvatarUrlService } from './avatar-url.service';
import { SupabaseService } from './supabase.service';
import { PROFILE_PHOTOS_BUCKET } from '../identity/kyc/profile-photo.constants';

describe('AvatarUrlService (PYG-518)', () => {
  let service: AvatarUrlService;
  let storageFrom: jest.Mock;
  let createSignedUrl: jest.Mock;
  let createSignedUrls: jest.Mock;

  beforeEach(async () => {
    createSignedUrl = jest.fn().mockResolvedValue({
      data: { signedUrl: 'https://signed.example/one.jpg' },
      error: null,
    });
    createSignedUrls = jest.fn().mockImplementation((paths: string[]) => ({
      data: paths.map((p) => ({
        path: p,
        signedUrl: `https://signed.example/${p}`,
        error: null,
      })),
      error: null,
    }));
    storageFrom = jest.fn().mockReturnValue({ createSignedUrl, createSignedUrls });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AvatarUrlService,
        {
          provide: SupabaseService,
          useValue: {
            getAdminClient: jest.fn().mockReturnValue({ storage: { from: storageFrom } }),
          },
        },
      ],
    }).compile();

    service = module.get(AvatarUrlService);
  });

  // ── resolve() ───────────────────────────────────────────────────────────

  it('resolve() คืน null ทันทีเมื่อไม่มีค่า — ไม่ยิง storage', async () => {
    expect(await service.resolve(null)).toBeNull();
    expect(await service.resolve(undefined)).toBeNull();
    expect(storageFrom).not.toHaveBeenCalled();
  });

  it('resolve() คืน URL เต็มตามเดิม (http/https) — ไม่ sign ซ้ำ', async () => {
    expect(await service.resolve('https://cdn.example.com/a.png')).toBe(
      'https://cdn.example.com/a.png',
    );
    expect(await service.resolve('http://cdn.example.com/a.png')).toBe(
      'http://cdn.example.com/a.png',
    );
    expect(storageFrom).not.toHaveBeenCalled();
  });

  it('resolve() sign path ดิบกับ bucket profile-photos', async () => {
    const url = await service.resolve('user-1/profile-abc.jpg');
    expect(url).toBe('https://signed.example/one.jpg');
    expect(storageFrom).toHaveBeenCalledWith(PROFILE_PHOTOS_BUCKET);
    expect(createSignedUrl).toHaveBeenCalledWith('user-1/profile-abc.jpg', 3600);
  });

  it('sign เดี่ยวล้ม → คืน null ไม่ throw', async () => {
    createSignedUrl.mockResolvedValue({ data: null, error: { message: 'nope' } });
    await expect(service.resolve('user-1/x.jpg')).resolves.toBeNull();
  });

  it('storage.createSignedUrl throw → คืน null ไม่ throw', async () => {
    createSignedUrl.mockRejectedValue(new Error('network down'));
    await expect(service.resolve('user-1/x.jpg')).resolves.toBeNull();
  });

  // ── resolveMany() — หัวใจของ "ผลค้นหา 20 ใบเซ็นในการเรียกเดียว" ─────────

  it('resolveMany() เซ็นหลาย path ด้วย createSignedUrls ครั้งเดียว ไม่ยิงทีละรูป', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: `cg-${i}`,
      avatarUrl: `cg-${i}/photo.jpg`,
    }));

    const result = await service.resolveMany(rows, (r) => r.avatarUrl);

    // ★ Done criterion: 20 รายการ sign ในการเรียกเดียว
    expect(createSignedUrls).toHaveBeenCalledTimes(1);
    expect(createSignedUrls.mock.calls[0][0]).toHaveLength(20);
    expect(storageFrom).toHaveBeenCalledWith(PROFILE_PHOTOS_BUCKET);

    for (const row of rows) {
      expect(result.get(row)).toBe(`https://signed.example/${row.avatarUrl}`);
    }
  });

  it('resolveMany() dedup path ซ้ำ — ไม่ส่ง path เดียวกันซ้ำใน createSignedUrls', async () => {
    const rows = [
      { id: 'a', avatarUrl: 'shared/photo.jpg' },
      { id: 'b', avatarUrl: 'shared/photo.jpg' },
      { id: 'c', avatarUrl: 'other/photo.jpg' },
    ];

    const result = await service.resolveMany(rows, (r) => r.avatarUrl);

    expect(createSignedUrls).toHaveBeenCalledTimes(1);
    expect(createSignedUrls.mock.calls[0][0]).toEqual(
      expect.arrayContaining(['shared/photo.jpg', 'other/photo.jpg']),
    );
    expect(createSignedUrls.mock.calls[0][0]).toHaveLength(2);
    // ทั้ง a และ b ได้ signed URL เดียวกัน (path เดียวกัน)
    expect(result.get(rows[0])).toBe(result.get(rows[1]));
  });

  it('resolveMany() ไม่ยิง storage เลยถ้าทุก item เป็น null/URL เต็มอยู่แล้ว', async () => {
    const rows = [
      { id: 'a', avatarUrl: null },
      { id: 'b', avatarUrl: 'https://cdn.example.com/b.png' },
    ];

    const result = await service.resolveMany(rows, (r) => r.avatarUrl);

    expect(createSignedUrls).not.toHaveBeenCalled();
    expect(result.get(rows[0])).toBeNull();
    expect(result.get(rows[1])).toBe('https://cdn.example.com/b.png');
  });

  it('resolveMany() batch ล้มทั้งก้อน → ทุก item เป็น null ไม่ throw', async () => {
    createSignedUrls.mockResolvedValue({ data: null, error: { message: 'bucket not found' } });
    const rows = [{ id: 'a', avatarUrl: 'a.jpg' }, { id: 'b', avatarUrl: 'b.jpg' }];

    const result = await service.resolveMany(rows, (r) => r.avatarUrl);

    expect(result.get(rows[0])).toBeNull();
    expect(result.get(rows[1])).toBeNull();
  });

  it('resolveMany() บาง path ใน batch ล้มเฉพาะรายการนั้น — ที่เหลือยัง sign ได้ปกติ', async () => {
    createSignedUrls.mockResolvedValue({
      data: [
        { path: 'ok.jpg', signedUrl: 'https://signed.example/ok.jpg', error: null },
        { path: 'bad.jpg', signedUrl: null, error: { message: 'not found' } },
      ],
      error: null,
    });
    const rows = [{ id: 'a', avatarUrl: 'ok.jpg' }, { id: 'b', avatarUrl: 'bad.jpg' }];

    const result = await service.resolveMany(rows, (r) => r.avatarUrl);

    expect(result.get(rows[0])).toBe('https://signed.example/ok.jpg');
    expect(result.get(rows[1])).toBeNull();
  });
});
