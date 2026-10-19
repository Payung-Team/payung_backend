/**
 * kyc-storage-path — เทสต์ปิดช่อง IDOR ของเอกสาร KYC
 *
 * ช่องเดิม: uploadKycDocument รับ fileUrl จาก client โดย validate แค่ @IsUrl()
 * แล้วฝั่งอ่านแกะ bucket จากค่านั้นไปเซ็นด้วย service role (bypass Storage RLS)
 * ⇒ caregiver ชี้ไปโฟลเดอร์ของคนอื่น แล้วขอ signed URL ของรูปบัตรคนนั้นได้
 *
 * หลักฐานว่าใช้ได้จริง: staging มีแถว file_url = 'https://example.com/id-card.jpg'
 */
import { BadRequestException } from '@nestjs/common';
import {
  KYC_BUCKET,
  KYC_SIGNED_URL_TTL_SECONDS,
  normalizeKycStoragePath,
  toStoragePathForSigning,
} from './kyc-storage-path';

const SUPABASE_URL = 'https://evsewucpighcbnhofmug.supabase.co';

/**
 * ★ ค่าจริงจากแถว fixture ใน staging
 *   id = 87d7fa1c-caf2-4de5-ac0c-e4315a5c76b8  doc_type = id_card_front
 *   จงใจไม่ลบแถวนี้ออกจาก DB — มันคือหลักฐานว่า @IsUrl() ปล่อยอะไรผ่านได้บ้าง
 *   ถ้าวันหนึ่งมีคนลบแถวนั้นทิ้ง เทสต์ตรงนี้ยังตรึงพฤติกรรมไว้แทน
 */
const FIXTURE_EXTERNAL_URL = 'https://example.com/id-card.jpg';
const ME = 'dcc37326-2625-4ba0-bfd9-ff0da2b099b4';
const SOMEONE_ELSE = '8863204a-328c-43e7-8d07-f53644f0426d';

const norm = (raw: string, uid = ME) => normalizeKycStoragePath(raw, uid, SUPABASE_URL);

describe('normalizeKycStoragePath — ปิด IDOR', () => {
  it('URL แบบ public ของโปรเจกต์เรา → แปลงเป็น path', () => {
    expect(
      norm(`${SUPABASE_URL}/storage/v1/object/public/${KYC_BUCKET}/${ME}/id_card_front.jpg`),
    ).toBe(`${ME}/id_card_front.jpg`);
  });

  it('URL แบบ authenticated → แปลงเป็น path เหมือนกัน', () => {
    expect(
      norm(`${SUPABASE_URL}/storage/v1/object/${KYC_BUCKET}/${ME}/selfie.png`),
    ).toBe(`${ME}/selfie.png`);
  });

  it('ส่ง path ล้วนมาก็รับ (FE ใหม่ควรส่งแบบนี้)', () => {
    expect(norm(`${ME}/id_card_front.jpg`)).toBe(`${ME}/id_card_front.jpg`);
  });

  // ── เคสที่เคยหลุดเข้า DB จริง ────────────────────────────────────────────
  it('URL ภายนอก (example.com) → ปฏิเสธ — นี่คือค่าจริงของแถว fixture ใน staging', () => {
    expect(() => norm(FIXTURE_EXTERNAL_URL)).toThrow(BadRequestException);
  });

  it('โปรเจกต์ Supabase อื่น → ปฏิเสธ', () => {
    expect(() =>
      norm(`https://evil.supabase.co/storage/v1/object/public/${KYC_BUCKET}/${ME}/x.jpg`),
    ).toThrow(BadRequestException);
  });

  // ── หัวใจ: ห้ามชี้ไปโฟลเดอร์คนอื่น ────────────────────────────────────────
  it('ชี้ไปโฟลเดอร์ของ caregiver คนอื่น → ปฏิเสธ', () => {
    expect(() =>
      norm(
        `${SUPABASE_URL}/storage/v1/object/public/${KYC_BUCKET}/${SOMEONE_ELSE}/id_card_front.jpg`,
      ),
    ).toThrow(BadRequestException);
  });

  it('ส่ง path ล้วนที่เป็นของคนอื่น → ปฏิเสธเช่นกัน', () => {
    expect(() => norm(`${SOMEONE_ELSE}/id_card_front.jpg`)).toThrow(BadRequestException);
  });

  // ── bucket อื่นในโปรเจกต์เดียวกัน ────────────────────────────────────────
  it('ชี้ไป bucket job-evidence → ปฏิเสธ (bucket ถูกตรึงไว้ที่ kyc-documents)', () => {
    expect(() =>
      norm(`${SUPABASE_URL}/storage/v1/object/public/job-evidence/${ME}/proof.jpg`),
    ).toThrow(BadRequestException);
  });

  it('ชี้ไป bucket avatars → ปฏิเสธ', () => {
    expect(() =>
      norm(`${SUPABASE_URL}/storage/v1/object/public/avatars/${ME}/a.png`),
    ).toThrow(BadRequestException);
  });

  // ── path traversal / รูปแบบเพี้ยน ────────────────────────────────────────
  it.each([
    ['path traversal', `${ME}/../${SOMEONE_ELSE}/id.jpg`],
    ['backslash', `${ME}\\id.jpg`],
    ['ไม่มีโฟลเดอร์', 'id_card_front.jpg'],
    ['โฟลเดอร์ไม่ใช่ uuid', `not-a-uuid/id.jpg`],
    ['ค่าว่าง', ''],
  ])('%s → ปฏิเสธ', (_label, value) => {
    expect(() => norm(value)).toThrow(BadRequestException);
  });

  it('นำหน้าด้วย / → normalize ทิ้ง แล้วผ่าน (ยังบังคับเจ้าของโฟลเดอร์อยู่)', () => {
    expect(norm(`/${ME}/id.jpg`)).toBe(`${ME}/id.jpg`);
    // แต่ของคนอื่นยังถูกปฏิเสธเหมือนเดิม
    expect(() => norm(`/${SOMEONE_ELSE}/id.jpg`)).toThrow(BadRequestException);
  });

  it('URL ที่ไม่มี /storage/v1/object/ → ปฏิเสธ', () => {
    expect(() => norm(`${SUPABASE_URL}/rest/v1/kyc_documents`)).toThrow(BadRequestException);
  });
});

describe('toStoragePathForSigning — ใช้ตอนอ่านแถวเดิม', () => {
  const sign = (v: string) => toStoragePathForSigning(v, SUPABASE_URL);

  it('แถวใหม่ที่เก็บเป็น path → ใช้ได้ตรง ๆ', () => {
    expect(sign(`${ME}/id_card_front.jpg`)).toBe(`${ME}/id_card_front.jpg`);
  });

  it('แถวเก่าที่ยังเป็น URL เต็ม → แปลงให้ (เข้ากันได้ก่อน migration รัน)', () => {
    expect(
      sign(`${SUPABASE_URL}/storage/v1/object/public/${KYC_BUCKET}/${ME}/id_card_front.jpg`),
    ).toBe(`${ME}/id_card_front.jpg`);
  });

  it('แถว fixture example.com → null ไม่ออก signed URL ให้ แม้จะอยู่ใน DB แล้ว', () => {
    expect(sign(FIXTURE_EXTERNAL_URL)).toBeNull();
  });

  it('bucket อื่น → null (ไม่เซ็นข้าม bucket แม้เป็นแถวที่อยู่ใน DB แล้ว)', () => {
    expect(sign(`${SUPABASE_URL}/storage/v1/object/public/job-evidence/${ME}/p.jpg`)).toBeNull();
  });

  it('ไม่เช็คเจ้าของ (แถวถูกกรองด้วย caregiver_id มาแล้ว) แต่ยังตรึง bucket', () => {
    expect(sign(`${SOMEONE_ELSE}/id_card_front.jpg`)).toBe(`${SOMEONE_ELSE}/id_card_front.jpg`);
  });
});

describe('ค่าคงที่', () => {
  it('signed URL อายุสั้นลงจากเดิม 1 ชม. (3600 วิ)', () => {
    expect(KYC_SIGNED_URL_TTL_SECONDS).toBeLessThan(3600);
    expect(KYC_SIGNED_URL_TTL_SECONDS).toBe(900);
  });

  it('bucket ถูกตรึงเป็น kyc-documents', () => {
    expect(KYC_BUCKET).toBe('kyc-documents');
  });
});
