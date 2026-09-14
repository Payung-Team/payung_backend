/**
 * Unit tests สำหรับ care-log-photo.util (PYG-466)
 * ตรวจ signature จาก byte จริง + ตัด APP1 (Exif/XMP), APP2-MPF และทุก byte หลัง EOI
 * โดยไม่แตะข้อมูลภาพและ ICC
 */
import {
  hasJpegSignature,
  InvalidJpegError,
  stripJpegMetadata,
} from './care-log-photo.util';
import {
  APP0_JFIF,
  APP2_ICC,
  APP2_MPF,
  buildJpeg,
  DQT,
  GPS_SECRET,
  MOTION_PHOTO_TRAILER,
  PNG_BYTES,
  SCAN,
  SECOND_IMAGE,
  SOI,
  segment,
} from '../../test/fixtures/jpeg.fixture';

const EOI = Buffer.from([0xff, 0xd9]);
const SOS_HEADER = segment(
  0xda,
  Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
);

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

describe('stripJpegMetadata', () => {
  it('ตัด Exif และ XMP ทิ้ง — ไม่เหลือพิกัด GPS ใน buffer', () => {
    const out = stripJpegMetadata(buildJpeg());

    expect(out.includes(Buffer.from(GPS_SECRET))).toBe(false);
    expect(out.includes(Buffer.from('Exif\0\0', 'binary'))).toBe(false);
  });

  it('segment อื่นและข้อมูลภาพหลัง SOS คงเดิมทุก byte (รวม FF 00 และ RST ใน scan data)', () => {
    const out = stripJpegMetadata(buildJpeg());

    expect(out.equals(Buffer.concat([SOI, APP0_JFIF, DQT, SCAN]))).toBe(true);
  });

  it('ไม่มีอะไรให้ตัด → ผลลัพธ์เท่ากับ input', () => {
    const input = buildJpeg({ exif: false, xmp: false, icc: true });
    expect(stripJpegMetadata(input).equals(input)).toBe(true);
  });

  it('ข้าม fill byte (FF ซ้ำ) ก่อน marker ได้', () => {
    const input = Buffer.concat([SOI, Buffer.from([0xff]), APP0_JFIF, SCAN]);
    const out = stripJpegMetadata(input);
    expect(out.subarray(0, 2).equals(SOI)).toBe(true);
    expect(out.includes(SCAN)).toBe(true);
  });

  // ─── ข้อมูลต่อท้ายหลัง EOI ──────────────────────────────────────────────
  describe('ข้อมูลต่อท้ายหลัง EOI', () => {
    it('motion photo (MP4 มีพิกัด) ต่อท้าย → output จบที่ FF D9 พอดี (trailing === 0) และไม่มีพิกัด', () => {
      const input = buildJpeg({ trailer: true });
      const out = stripJpegMetadata(input);

      expect(out.subarray(-2).equals(EOI)).toBe(true);
      expect(out.equals(Buffer.concat([SOI, APP0_JFIF, DQT, SCAN]))).toBe(true);
      expect(out.includes(MOTION_PHOTO_TRAILER)).toBe(false);
      expect(input.includes(Buffer.from('+13.7768+100.5793'))).toBe(true);
      expect(out.includes(Buffer.from('+13.7768+100.5793'))).toBe(false);
    });

    it('ภาพที่สอง (gain map / MPF) ที่มี FF D9 ของตัวเอง → ตัดที่ EOI ของภาพหลักตัวแรก', () => {
      const input = Buffer.concat([
        buildJpeg({ exif: false, xmp: false }),
        SECOND_IMAGE,
      ]);
      const out = stripJpegMetadata(input);

      expect(out.equals(buildJpeg({ exif: false, xmp: false }))).toBe(true);
    });

    it('fill byte ก่อน EOI (FF FF D9) → จบที่ EOI ตัวนั้น', () => {
      const input = Buffer.concat([
        SOI,
        DQT,
        SOS_HEADER,
        Buffer.from([0x11, 0xff, 0xff, 0xd9]),
        MOTION_PHOTO_TRAILER,
      ]);
      const out = stripJpegMetadata(input);

      expect(out.subarray(-3).equals(Buffer.from([0xff, 0xff, 0xd9]))).toBe(
        true,
      );
      expect(out.includes(MOTION_PHOTO_TRAILER)).toBe(false);
    });

    it('RST (FF D0–D7) กลาง scan data ไม่ถูกตีความว่าเป็นจุดจบ', () => {
      const scanData = Buffer.from([0x01, 0xff, 0xd0, 0x02, 0xff, 0xd7, 0x03]);
      const input = Buffer.concat([
        SOI,
        DQT,
        SOS_HEADER,
        scanData,
        EOI,
        MOTION_PHOTO_TRAILER,
      ]);

      expect(
        stripJpegMetadata(input).equals(
          Buffer.concat([SOI, DQT, SOS_HEADER, scanData, EOI]),
        ),
      ).toBe(true);
    });

    it('progressive: หลาย SOS + DHT ระหว่าง scan ที่ payload มี byte FF D9 → เก็บครบถึง EOI จริง', () => {
      // payload ของ DHT มี FF D9 — ถ้าสแกนหา FF D9 ตรง ๆ จะตัดภาพกลางคัน
      const dhtWithFfD9 = segment(
        0xc4,
        Buffer.from([0x10, 0xff, 0xd9, 0x00, 0x01]),
      );
      const primary = Buffer.concat([
        SOI,
        DQT,
        SOS_HEADER,
        Buffer.from([0xaa, 0xff, 0x00, 0xbb]),
        dhtWithFfD9,
        SOS_HEADER,
        Buffer.from([0xcc, 0xdd]),
        EOI,
      ]);
      const out = stripJpegMetadata(
        Buffer.concat([primary, MOTION_PHOTO_TRAILER]),
      );

      expect(out.equals(primary)).toBe(true);
    });
  });

  // ─── APP2 ───────────────────────────────────────────────────────────────
  describe('APP2', () => {
    it('ICC_PROFILE อยู่ครบทุก byte, MPF หาย', () => {
      const out = stripJpegMetadata(
        buildJpeg({ icc: true, mpf: true, trailer: true }),
      );

      expect(out.includes(APP2_ICC)).toBe(true);
      expect(out.includes(APP2_MPF)).toBe(false);
      expect(out.includes(Buffer.from('MPF\0', 'latin1'))).toBe(false);
      expect(
        out.equals(Buffer.concat([SOI, APP0_JFIF, APP2_ICC, DQT, SCAN])),
      ).toBe(true);
    });

    it('APP2 ที่ไม่ใช่ MPF (เช่น FlashPix) คงไว้ตามเดิม', () => {
      const flashPix = segment(0xe2, Buffer.from('FPXR\0\0data', 'latin1'));
      const input = Buffer.concat([SOI, APP0_JFIF, flashPix, DQT, SCAN]);

      expect(stripJpegMetadata(input).equals(input)).toBe(true);
    });
  });

  // ─── ไฟล์เสีย ───────────────────────────────────────────────────────────
  describe('ไฟล์เสีย → InvalidJpegError', () => {
    it('ไม่มี signature', () => {
      expect(() => stripJpegMetadata(PNG_BYTES)).toThrow(InvalidJpegError);
    });

    it('ไม่มี EOI หลัง scan data', () => {
      const noEoi = Buffer.concat([
        SOI,
        DQT,
        SOS_HEADER,
        Buffer.from([0x12, 0xff, 0x00, 0x34]),
      ]);
      expect(() => stripJpegMetadata(noEoi)).toThrow(
        new InvalidJpegError('no EOI found'),
      );
    });

    it('scan data จบด้วย FF เดี่ยว (ไฟล์ถูกตัด)', () => {
      const truncated = Buffer.concat([
        SOI,
        DQT,
        SOS_HEADER,
        Buffer.from([0x12, 0xff]),
      ]);
      expect(() => stripJpegMetadata(truncated)).toThrow(InvalidJpegError);
    });

    it('EOI มาก่อน SOS (ไม่มีข้อมูลภาพ)', () => {
      const noScan = Buffer.concat([SOI, APP0_JFIF, DQT, EOI]);
      expect(() => stripJpegMetadata(noScan)).toThrow(InvalidJpegError);
    });

    it('length ของ segment ยาวเกินไฟล์', () => {
      const broken = Buffer.concat([
        SOI,
        Buffer.from([0xff, 0xe1, 0x7f, 0xff, 0x00]),
      ]);
      expect(() => stripJpegMetadata(broken)).toThrow(InvalidJpegError);
    });

    it('length < 2', () => {
      const broken = Buffer.concat([
        SOI,
        Buffer.from([0xff, 0xe0, 0x00, 0x01]),
        SCAN,
      ]);
      expect(() => stripJpegMetadata(broken)).toThrow(InvalidJpegError);
    });

    it('เจอ byte ที่ไม่ใช่ marker ในส่วน header', () => {
      const broken = Buffer.concat([
        SOI,
        Buffer.from([0xff]),
        Buffer.from([0x00, 0x00]),
      ]);
      expect(() => stripJpegMetadata(broken)).toThrow(InvalidJpegError);
    });

    it('จบไฟล์ก่อนเจอ SOS', () => {
      const noScan = Buffer.concat([
        SOI,
        APP0_JFIF,
        segment(0xdb, Buffer.alloc(4)),
      ]);
      expect(() => stripJpegMetadata(noScan)).toThrow(InvalidJpegError);
    });

    it('ไฟล์ถูกตัดกลาง segment length', () => {
      const truncated = Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0x00])]);
      expect(() => stripJpegMetadata(truncated)).toThrow(InvalidJpegError);
    });
  });
});
