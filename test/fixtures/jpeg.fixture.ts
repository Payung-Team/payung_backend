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
export const DQT = segment(0xdb, Buffer.alloc(65, 1));
/** SOS + entropy-coded data (มี FF 00 และ FF E1 ปนอยู่ ต้องไม่ถูกตีความเป็น marker) + EOI */
export const SCAN = Buffer.concat([
  segment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])),
  Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xe1, 0x00, 0x02, 0x78]),
  Buffer.from([0xff, 0xd9]),
]);

export function buildJpeg(
  options: { exif?: boolean; xmp?: boolean } = {},
): Buffer {
  const { exif = true, xmp = true } = options;
  return Buffer.concat([
    SOI,
    APP0_JFIF,
    ...(exif ? [APP1_EXIF] : []),
    ...(xmp ? [APP1_XMP] : []),
    DQT,
    SCAN,
  ]);
}

/** PNG signature + IHDR เริ่มต้น — ใช้เป็น "ไฟล์ที่อ้างว่าเป็น image/jpeg แต่ไม่ใช่" */
export const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52,
]);
