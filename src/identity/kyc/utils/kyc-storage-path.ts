/**
 * kyc-storage-path — ตัวกลางเดียวที่ตัดสินว่า "path ของเอกสาร KYC อันไหนใช้ได้"
 *
 * ── ช่องโหว่ที่ไฟล์นี้มีไว้ปิด ───────────────────────────────────────────────
 * uploadKycDocument รับ `fileUrl` จาก client ตรง ๆ โดย validate แค่ `@IsUrl()`
 * แล้ว getDocumentsWithSignedUrls "แกะชื่อ bucket ออกจากค่าที่เก็บไว้" แล้วเซ็น
 * ด้วย service role ซึ่ง bypass Storage RLS ทั้งหมด
 *
 * ลูกโซ่ที่ caregiver คนเดียวทำเองได้ครบ:
 *   1) uploadKycDocument(fileUrl: '.../kyc-documents/<uid ของคนอื่น>/id_card_front.jpg')
 *      → แถวถูกสร้างโดย userId = ตัวเอง
 *   2) submitKyc(documentIds: [แถวนั้น]) → updateMany กรองแค่ id + userId ซึ่งผ่าน
 *      → caregiverId ผูกเข้าตัวเอง
 *   3) kycStatus → ระบบเซ็น URL ให้ อายุ 1 ชม.
 *   ⇒ ได้ไฟล์ bucket ไหน path ไหนก็ได้ในโปรเจกต์ รวมรูปบัตรของคนอื่นและ job-evidence
 *
 * หลักฐานว่าช่องนี้ใช้ได้จริง ไม่ใช่ทฤษฎี: ใน staging มีแถวที่ file_url เป็น
 * `https://example.com/id-card.jpg` เก็บอยู่จริง
 *
 * ── กติกาหลังแก้ ────────────────────────────────────────────────────────────
 *   • bucket ถูก "ตรึง" ไว้ในโค้ด ห้ามอ่านจากข้อมูลที่ผู้ใช้ส่งมาอีก
 *   • เก็บลง DB เป็น storage path (`<uid>/<file>`) ไม่ใช่ URL เต็ม
 *   • โฟลเดอร์แรกของ path ต้องเท่ากับ supabase_uid ของคนที่เรียกเท่านั้น
 *     (ตรงกับ Storage policy ของ bucket: auth.uid() = foldername(name)[1])
 */
import { BadRequestException } from '@nestjs/common';

/** bucket เดียวที่เอกสาร KYC อยู่ได้ — ตรึงในโค้ด ห้ามรับจาก input */
export const KYC_BUCKET = 'kyc-documents';

/** อายุ signed URL (วินาที) — สั้นพอที่ URL หลุดแล้วไม่เป็นกุญแจถาวร */
export const KYC_SIGNED_URL_TTL_SECONDS = 900; // 15 นาที

/** uid ของ Supabase เป็น UUID เสมอ — ใช้กัน path traversal ตั้งแต่ชั้นรูปแบบ */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * ดึงส่วน path ออกจากค่าที่รับมา ซึ่งอาจเป็นได้ 3 แบบ:
 *   1. path ล้วน                          `<uid>/<file>`
 *   2. URL เต็มแบบ public ของโปรเจกต์เรา   `https://<ref>.supabase.co/storage/v1/object/public/kyc-documents/<uid>/<file>`
 *   3. URL เต็มแบบ authenticated           `https://<ref>.supabase.co/storage/v1/object/kyc-documents/<uid>/<file>`
 *
 * รับ URL เต็มไว้เพื่อความเข้ากันได้กับ FE ที่ยังส่งแบบเดิมมา แต่จะถูกแปลงเป็น
 * path ก่อนเก็บเสมอ และต้องเป็นโดเมนของโปรเจกต์เราเท่านั้น
 */
function extractPath(raw: string, supabaseUrl: string): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;

  if (!/^https?:\/\//i.test(value)) {
    // path ล้วน — ตัด / นำหน้าออกให้เป็นรูปแบบเดียวกัน
    return value.replace(/^\/+/, '');
  }

  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(value);
    base = new URL(supabaseUrl);
  } catch {
    return null;
  }

  // ★ ต้องเป็นโฮสต์ของโปรเจกต์เราเท่านั้น — กันเคส https://example.com/id-card.jpg
  //   และกัน URL ของโปรเจกต์ Supabase อื่นที่เราไม่ได้เป็นเจ้าของ
  if (parsed.host !== base.host) return null;

  const marker = '/storage/v1/object/';
  const idx = parsed.pathname.indexOf(marker);
  if (idx === -1) return null;

  let rest = parsed.pathname.slice(idx + marker.length);
  for (const prefix of ['public/', 'sign/', 'authenticated/']) {
    if (rest.startsWith(prefix)) {
      rest = rest.slice(prefix.length);
      break;
    }
  }

  // rest = "<bucket>/<path>" — bucket ต้องเป็นของ KYC เท่านั้น
  const slash = rest.indexOf('/');
  if (slash === -1) return null;
  const bucket = rest.slice(0, slash);
  if (bucket !== KYC_BUCKET) return null;

  return decodeURIComponent(rest.slice(slash + 1));
}

/**
 * normalizeKycStoragePath — แปลงค่าที่ client ส่งมาให้เป็น storage path ที่เชื่อถือได้
 *
 * @param raw         ค่าจาก input (path หรือ URL เต็ม)
 * @param ownerUid    supabase_uid ของ "คนที่กำลังเรียก" — ไม่ใช่ค่าจาก input
 * @param supabaseUrl SUPABASE_URL ของโปรเจกต์
 * @throws BadRequestException ถ้าไม่ผ่านข้อใดข้อหนึ่ง
 */
export function normalizeKycStoragePath(
  raw: string,
  ownerUid: string,
  supabaseUrl: string,
): string {
  const path = extractPath(raw, supabaseUrl);

  if (!path) {
    throw new BadRequestException(
      'ไฟล์เอกสารต้องอยู่ใน storage ของ Payung เท่านั้น (bucket kyc-documents)',
    );
  }

  // กัน path traversal และ path ที่ชี้ออกนอกโฟลเดอร์ตัวเอง
  if (path.includes('..') || path.includes('\\') || path.startsWith('/')) {
    throw new BadRequestException('เส้นทางไฟล์ไม่ถูกต้อง');
  }

  const segments = path.split('/').filter(Boolean);
  if (segments.length < 2) {
    throw new BadRequestException('เส้นทางไฟล์ไม่ถูกต้อง — ต้องอยู่ในโฟลเดอร์ของผู้ใช้');
  }

  const folder = segments[0];
  if (!UUID_RE.test(folder)) {
    throw new BadRequestException('เส้นทางไฟล์ไม่ถูกต้อง');
  }

  // ★ หัวใจของการปิดช่อง: โฟลเดอร์ต้องเป็นของคนที่เรียกเท่านั้น
  //   ownerUid มาจาก session ฝั่ง server ไม่ใช่จาก input ที่ client ส่งมา
  if (folder !== ownerUid) {
    throw new BadRequestException('ไม่สามารถอ้างอิงไฟล์ของผู้ใช้รายอื่นได้');
  }

  return segments.join('/');
}

/**
 * toStoragePathForSigning — ใช้ตอน "อ่าน" แถวที่มีอยู่แล้วใน DB
 *
 * แถวเก่าก่อน data migration ยังเก็บ URL เต็มอยู่ จึงต้องรองรับทั้งสองแบบ
 * ต่างจาก normalize ตรงที่ไม่เช็คเจ้าของ (แถวถูกกรองด้วย caregiver_id มาแล้ว)
 * แต่ยัง "ตรึง bucket" เหมือนกัน — ห้ามแกะ bucket จากค่าที่เก็บไว้เด็ดขาด
 *
 * @returns path หรือ null ถ้าค่าที่เก็บไว้ไม่ใช่ของ bucket KYC (เช่นแถว example.com)
 */
export function toStoragePathForSigning(
  stored: string,
  supabaseUrl: string,
): string | null {
  const path = extractPath(stored, supabaseUrl);
  if (!path) return null;
  if (path.includes('..') || path.startsWith('/')) return null;
  return path.split('/').filter(Boolean).length >= 2 ? path : null;
}
