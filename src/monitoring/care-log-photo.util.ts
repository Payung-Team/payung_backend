/**
 * care-log-photo.util — ตรวจ/ล้างไฟล์ JPEG ของรูปประกอบ "บันทึกจากผู้ดูแล" (PYG-466)
 *
 * ★ ตรวจจาก byte จริงเท่านั้น ห้ามเชื่อชื่อไฟล์ / นามสกุล / MIME ที่ client ส่งมา
 * ★ เขียนเองโดยตั้งใจ ไม่ใช้ sharp (มติการ์ด): ไม่ decode / ไม่ re-encode รูป
 *   แค่ตัด segment APP1 (Exif + XMP) ทิ้ง เพื่อไม่ให้พิกัด GPS ในบ้านผู้ป่วยขึ้น storage
 *
 * ⚠ ผลข้างเคียงที่รับแล้ว: tag Orientation อยู่ใน Exif จึงหายไปด้วย
 *   FE ต้อง re-encode ผ่าน canvas ก่อนส่ง (หมุนรูปให้ตั้งแต่ต้นทาง) — ฝั่งนี้เป็นแค่ safety net
 *   ห้ามแก้ไปเป็นการ parse IFD เพื่อเก็บ Orientation ไว้ (เกินขอบเขต + เสี่ยง)
 */

/** โครงสร้าง JPEG ไม่ถูกต้อง — ผ่าน signature มาได้แต่อ่าน segment ต่อไม่ได้ */
export class InvalidJpegError extends Error {}

/** SOI + byte แรกของ marker ถัดไป: ไฟล์ JPEG ทุกชนิดขึ้นต้นด้วย FF D8 FF */
export function hasJpegSignature(buf: Buffer): boolean {
  return (
    buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
  );
}

const MARKER_SOS = 0xda; // Start of Scan — หลังจากนี้เป็นข้อมูลภาพ ไม่มี segment metadata แล้ว
const MARKER_EOI = 0xd9;
const MARKER_APP1 = 0xe1; // Exif และ XMP

/** marker ที่ไม่มี length ตามหลัง (TEM, RST0–RST7) */
function isStandalone(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

/**
 * คืน buffer ใหม่ที่ไม่มี segment APP1 — segment อื่นและข้อมูลภาพคงเดิมทุก byte
 * @throws InvalidJpegError ถ้าไม่ใช่ JPEG หรือโครงสร้าง segment เสีย
 */
export function stripJpegApp1(buf: Buffer): Buffer {
  if (!hasJpegSignature(buf)) {
    throw new InvalidJpegError('missing JPEG signature');
  }

  const kept: Buffer[] = [buf.subarray(0, 2)]; // SOI
  let offset = 2;

  while (offset < buf.length) {
    if (buf[offset] !== 0xff) {
      throw new InvalidJpegError(`expected marker at offset ${offset}`);
    }

    // FF ซ้ำ ๆ ก่อน marker = fill byte ตามสเปก ข้ามได้
    let markerAt = offset + 1;
    while (markerAt < buf.length && buf[markerAt] === 0xff) markerAt++;
    if (markerAt >= buf.length) {
      throw new InvalidJpegError('truncated marker');
    }
    const marker = buf[markerAt];
    const segmentStart = markerAt - 1;

    if (marker === MARKER_SOS || marker === MARKER_EOI) {
      kept.push(buf.subarray(segmentStart));
      return Buffer.concat(kept);
    }

    if (isStandalone(marker)) {
      kept.push(buf.subarray(segmentStart, markerAt + 1));
      offset = markerAt + 1;
      continue;
    }

    if (markerAt + 2 >= buf.length) {
      throw new InvalidJpegError('truncated segment length');
    }
    // length นับรวม 2 byte ของตัวมันเอง แต่ไม่รวม FF xx
    const length = buf.readUInt16BE(markerAt + 1);
    const segmentEnd = markerAt + 1 + length;
    if (length < 2 || segmentEnd > buf.length) {
      throw new InvalidJpegError(
        `invalid segment length at offset ${segmentStart}`,
      );
    }

    if (marker !== MARKER_APP1) {
      kept.push(buf.subarray(segmentStart, segmentEnd));
    }
    offset = segmentEnd;
  }

  throw new InvalidJpegError('no image data (SOS) found');
}
