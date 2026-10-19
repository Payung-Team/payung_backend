/**
 * JPEG ปลอมสำหรับเทส PYG-466 — โครงสร้าง segment ถูกต้องตามสเปก แต่ไม่ต้อง decode ได้จริง
 * (โค้ดที่ทดสอบแค่อ่าน marker/length ไม่ได้ถอดรหัสภาพ)
 *
 * อยู่ใน test/ เพื่อไม่ให้หลุดเข้า dist (tsconfig.build exclude "test")
 */

/** ข้อความที่ฝังใน Exif/XMP — ถ้ายังเจอใน buffer ที่อัปโหลด = strip ไม่ทำงาน */
export const GPS_SECRET = 'GPS-13.7768N-100.5793E';

export function segment(marker: number, payload: Buffer): Buffer {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), length, payload]);
}

export const SOI = Buffer.from([0xff, 0xd8]);
export const APP0_JFIF = segment(
  0xe0,
  Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'binary'),
);
export const APP1_EXIF = segment(
  0xe1,
  Buffer.from(`Exif\0\0${GPS_SECRET}`, 'binary'),
);
export const APP1_XMP = segment(
  0xe1,
  Buffer.from(
    `http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>${GPS_SECRET}</x:xmpmeta>`,
    'binary',
  ),
);
/** ICC profile (APP2) — ต้องรอดผ่านการ strip ทุก byte */
export const APP2_ICC = segment(
  0xe2,
  Buffer.from('ICC_PROFILE\0\x01\x01fake-display-p3-profile', 'binary'),
);
/** MPF index (APP2) — ชี้ไปภาพที่สองที่ต่อท้าย ต้องถูกตัดพร้อมภาพนั้น */
export const APP2_MPF = segment(
  0xe2,
  Buffer.from('MPF\0MM\0\x2a\0\0\0\x08index-to-second-image', 'binary'),
);
export const DQT = segment(0xdb, Buffer.alloc(65, 1));
/**
 * SOS + entropy-coded data + EOI
 * มี FF 00 (byte-stuffing) และ FF D3 (RST) ปนอยู่ — ต้องไม่ถูกตีความเป็นจุดจบของภาพ
 * (JPEG จริงมี FF ในข้อมูลภาพได้แค่สองรูปแบบนี้เท่านั้น)
 */
export const SCAN = Buffer.concat([
  segment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])),
  Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd3, 0x78]),
  Buffer.from([0xff, 0xd9]),
]);

/** JPEG ภาพที่สอง (gain map / MPF) ที่ต่อท้าย — มี FF D9 ของตัวเอง */
export const SECOND_IMAGE = Buffer.concat([SOI, DQT, SCAN]);

/** motion photo ของ Samsung/Google: MP4 ต่อท้ายหลัง EOI พร้อม location atom (©xyz) */
export const MOTION_PHOTO_TRAILER = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42', 'latin1'),
  Buffer.alloc(12),
  Buffer.from('\xa9xyz+13.7768+100.5793/', 'latin1'),
]);

export function buildJpeg(
  options: {
    exif?: boolean;
    xmp?: boolean;
    icc?: boolean;
    mpf?: boolean;
    trailer?: boolean;
  } = {},
): Buffer {
  const {
    exif = true,
    xmp = true,
    icc = false,
    mpf = false,
    trailer = false,
  } = options;
  return Buffer.concat([
    SOI,
    APP0_JFIF,
    ...(exif ? [APP1_EXIF] : []),
    ...(xmp ? [APP1_XMP] : []),
    ...(icc ? [APP2_ICC] : []),
    ...(mpf ? [APP2_MPF] : []),
    DQT,
    SCAN,
    ...(mpf ? [SECOND_IMAGE] : []),
    ...(trailer ? [MOTION_PHOTO_TRAILER] : []),
  ]);
}

/** PNG signature + IHDR เริ่มต้น — ใช้เป็น "ไฟล์ที่อ้างว่าเป็น image/jpeg แต่ไม่ใช่" */
export const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52,
]);
