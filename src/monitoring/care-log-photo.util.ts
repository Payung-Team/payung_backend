/**
 * care-log-photo.util — ตรวจ/ล้างไฟล์ JPEG ของรูปประกอบ "บันทึกจากผู้ดูแล" (PYG-466)
 *
 * ★ ตรวจจาก byte จริงเท่านั้น ห้ามเชื่อชื่อไฟล์ / นามสกุล / MIME ที่ client ส่งมา
 * ★ เขียนเองโดยตั้งใจ ไม่ใช้ sharp (มติการ์ด): ไม่ decode / ไม่ re-encode รูป
 *   แค่ "ตัดทิ้ง" ส่วนที่พาพิกัด GPS ในบ้านผู้ป่วยขึ้น storage ได้:
 *   - APP1 ทั้งหมด (Exif + XMP)
 *   - APP2 ที่เป็น MPF — index ชี้ไปภาพที่สองซึ่งถูกตัดไปพร้อม trailer แล้ว ทิ้งไว้ decoder บางตัวพัง
 *     (APP2 ICC_PROFILE เก็บไว้ — ไม่มีข้อมูลส่วนตัว และถ้าตัดสีจะเพี้ยน)
 *   - ทุก byte หลัง EOI ของภาพหลัก — motion photo (MP4) ของ Samsung/Google, Samsung trailer,
 *     gain map ของ iPhone ต่อท้ายไว้ตรงนี้ และพกพิกัดของตัวเองมาได้
 *
 * ⚠ ผลข้างเคียงที่รับแล้ว:
 *   - tag Orientation อยู่ใน Exif จึงหายไปด้วย
 *   - HDR gain map / วิดีโอของ motion photo หายไป (เหลือภาพหลัก SDR)
 *   FE ต้อง re-encode ผ่าน canvas ก่อนส่ง (หมุนรูปให้ตั้งแต่ต้นทาง) — ฝั่งนี้เป็นแค่ safety net
 *   ห้ามแก้ไปเป็นการ parse IFD เพื่อเก็บ Orientation ไว้ (เกินขอบเขต + เสี่ยง)
 */

/** โครงสร้าง JPEG ไม่ถูกต้อง — ผ่าน signature มาได้แต่อ่าน segment ต่อไม่ได้ / ไม่มี EOI */
export class InvalidJpegError extends Error {}

/** SOI + byte แรกของ marker ถัดไป: ไฟล์ JPEG ทุกชนิดขึ้นต้นด้วย FF D8 FF */
export function hasJpegSignature(buf: Buffer): boolean {
  return (
    buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
  );
}

const MARKER_SOS = 0xda; // Start of Scan — ตามด้วย entropy-coded data
const MARKER_EOI = 0xd9; // End of Image — จบภาพหลัก
const MARKER_APP1 = 0xe1; // Exif และ XMP
const MARKER_APP2 = 0xe2; // ICC_PROFILE หรือ MPF
const MPF_IDENTIFIER = Buffer.from('MPF\0', 'latin1');

/** RST0–RST7 — อยู่กลาง entropy-coded data ได้ */
function isRestart(marker: number): boolean {
  return marker >= 0xd0 && marker <= 0xd7;
}

/** marker ที่ไม่มี length ตามหลัง (TEM, RST0–RST7) */
function isStandalone(marker: number): boolean {
  return marker === 0x01 || isRestart(marker);
}

function shouldDrop(marker: number, payload: Buffer): boolean {
  if (marker === MARKER_APP1) return true;
  if (marker === MARKER_APP2) {
    return payload.subarray(0, MPF_IDENTIFIER.length).equals(MPF_IDENTIFIER);
  }
  return false;
}

/**
 * หาจุดจบของ entropy-coded data หลัง SOS — คืน offset ของ marker จริงตัวถัดไป
 *
 * FF ในข้อมูลภาพถูก byte-stuff เป็น FF 00 เสมอ, RSTn (FF D0–D7) อยู่ในข้อมูลได้,
 * FF ซ้ำ = fill byte → marker อื่นที่เจอคือของจริง: EOI หรือ DHT/SOS ของ progressive scan ถัดไป
 *
 * ★ ไม่สแกนหา FF D9 ต่อไปทั้งไฟล์ตรง ๆ: ระหว่าง scan ของ progressive มี segment ที่มี length
 *   (DHT/DQT) ซึ่ง payload มี byte FF D9 ได้ — ต้องเดิน segment ตาม length แทน
 */
function entropyEnd(buf: Buffer, start: number): number {
  let i = start;
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const next = buf[i + 1];
    if (next === 0x00 || isRestart(next)) {
      i += 2;
      continue;
    }
    if (next === 0xff) {
      i++;
      continue;
    }
    return i;
  }
  throw new InvalidJpegError('no EOI found');
}

/**
 * คืน buffer ใหม่ที่ไม่มี APP1, ไม่มี APP2-MPF และจบที่ EOI ของภาพหลักพอดี
 * segment อื่น (รวม ICC) และข้อมูลภาพคงเดิมทุก byte
 * @throws InvalidJpegError ถ้าไม่ใช่ JPEG, โครงสร้าง segment เสีย หรือหา EOI ไม่เจอ
 */
export function stripJpegMetadata(buf: Buffer): Buffer {
  if (!hasJpegSignature(buf)) {
    throw new InvalidJpegError('missing JPEG signature');
  }

  const kept: Buffer[] = [buf.subarray(0, 2)]; // SOI
  let offset = 2;
  let seenScan = false;

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

    if (marker === MARKER_EOI) {
      if (!seenScan) {
        throw new InvalidJpegError('EOI before image data (SOS)');
      }
      // ★ จบภาพหลักตรงนี้ — ทุก byte หลังจากนี้ (ภาพที่สอง / วิดีโอ / trailer) ถูกตัดทิ้ง
      kept.push(buf.subarray(segmentStart, markerAt + 1));
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

    if (!shouldDrop(marker, buf.subarray(markerAt + 3, segmentEnd))) {
      kept.push(buf.subarray(segmentStart, segmentEnd));
    }
    offset = segmentEnd;

    if (marker === MARKER_SOS) {
      seenScan = true;
      const scanEnd = entropyEnd(buf, segmentEnd);
      kept.push(buf.subarray(segmentEnd, scanEnd));
      offset = scanEnd;
    }
  }

  throw new InvalidJpegError(
    seenScan ? 'no EOI found' : 'no image data (SOS) found',
  );
}
