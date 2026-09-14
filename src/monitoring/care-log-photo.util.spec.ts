/**
 * Unit tests สำหรับ care-log-photo.util (PYG-466)
 * ตรวจ signature จาก byte จริง + ตัด APP1 (Exif/XMP) โดยไม่แตะข้อมูลภาพ
 */
import {
  hasJpegSignature,
  InvalidJpegError,
  stripJpegApp1,
} from './care-log-photo.util';
import {
  APP0_JFIF,
  buildJpeg,
  DQT,
  GPS_SECRET,
  PNG_BYTES,
  SCAN,
  SOI,
  segment,
} from '../../test/fixtures/jpeg.fixture';

describe('hasJpegSignature', () => {
  it('รับไฟล์ที่ขึ้นต้นด้วย FF D8 FF', () => {
    expect(hasJpegSignature(buildJpeg())).toBe(true);
  });

  it('ปฏิเสธ PNG', () => {
    expect(hasJpegSignature(PNG_BYTES)).toBe(false);
  });

  it('ปฏิเสธไฟล์สั้นกว่า 3 byte และ FF D8 ที่ไม่ตามด้วย FF', () => {
    expect(hasJpegSignature(Buffer.from([0xff, 0xd8]))).toBe(false);
    expect(hasJpegSignature(Buffer.from([0xff, 0xd8, 0x00, 0xff]))).toBe(false);
    expect(hasJpegSignature(Buffer.alloc(0))).toBe(false);
  });
});

describe('stripJpegApp1', () => {
  it('ตัด Exif และ XMP ทิ้ง — ไม่เหลือพิกัด GPS ใน buffer', () => {
    const out = stripJpegApp1(buildJpeg());

    expect(out.includes(Buffer.from(GPS_SECRET))).toBe(false);
    expect(out.includes(Buffer.from('Exif\0\0', 'binary'))).toBe(false);
  });

  it('segment อื่นและข้อมูลภาพหลัง SOS คงเดิมทุก byte (รวม FF E1 ที่อยู่ใน scan data)', () => {
    const out = stripJpegApp1(buildJpeg());

    expect(out.equals(Buffer.concat([SOI, APP0_JFIF, DQT, SCAN]))).toBe(true);
  });

  it('ไม่มี APP1 อยู่แล้ว → ผลลัพธ์เท่ากับ input', () => {
    const input = buildJpeg({ exif: false, xmp: false });
    expect(stripJpegApp1(input).equals(input)).toBe(true);
  });

  it('ข้าม fill byte (FF ซ้ำ) ก่อน marker ได้', () => {
    const input = Buffer.concat([SOI, Buffer.from([0xff]), APP0_JFIF, SCAN]);
    const out = stripJpegApp1(input);
    expect(out.subarray(0, 2).equals(SOI)).toBe(true);
    expect(out.includes(SCAN)).toBe(true);
  });

  it('throw InvalidJpegError เมื่อไม่มี signature', () => {
    expect(() => stripJpegApp1(PNG_BYTES)).toThrow(InvalidJpegError);
  });

  it('throw เมื่อ length ของ segment ยาวเกินไฟล์', () => {
    const broken = Buffer.concat([
      SOI,
      Buffer.from([0xff, 0xe1, 0x7f, 0xff, 0x00]),
    ]);
    expect(() => stripJpegApp1(broken)).toThrow(InvalidJpegError);
  });

  it('throw เมื่อ length < 2', () => {
    const broken = Buffer.concat([
      SOI,
      Buffer.from([0xff, 0xe0, 0x00, 0x01]),
      SCAN,
    ]);
    expect(() => stripJpegApp1(broken)).toThrow(InvalidJpegError);
  });

  it('throw เมื่อเจอ byte ที่ไม่ใช่ marker ในส่วน header', () => {
    const broken = Buffer.concat([
      SOI,
      Buffer.from([0xff]),
      Buffer.from([0x00, 0x00]),
    ]);
    expect(() => stripJpegApp1(broken)).toThrow(InvalidJpegError);
  });

  it('throw เมื่อจบไฟล์ก่อนเจอ SOS', () => {
    const noScan = Buffer.concat([
      SOI,
      APP0_JFIF,
      segment(0xdb, Buffer.alloc(4)),
    ]);
    expect(() => stripJpegApp1(noScan)).toThrow(InvalidJpegError);
  });

  it('throw เมื่อไฟล์ถูกตัดกลาง segment length', () => {
    const truncated = Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0x00])]);
    expect(() => stripJpegApp1(truncated)).toThrow(InvalidJpegError);
  });
});
