/**
 * หลักฐานประกอบคำขอ (IP + user agent) — PYG-474 / PYG-538
 *
 * ใช้ตอนบันทึกความยินยอม PDPA ลง `user_consents` เพื่อให้พิสูจน์ย้อนหลังได้ว่า
 * "การกดยินยอมครั้งนั้นมาจากไหน ใช้อุปกรณ์อะไร"
 *
 * ★ ดึงจาก request ฝั่ง server เสมอ ไม่ให้ FE ส่งมาเอง
 *   ค่าที่ client ส่งมาเองปลอมได้ทั้งหมด จึงใช้เป็นหลักฐานไม่ได้
 *
 * ★ ทำไมต้อง validate IP ก่อนบันทึก?
 *   คอลัมน์ `user_consents.ip_address` เป็นชนิด `inet` ของ Postgres
 *   ถ้าส่งค่าที่ไม่ใช่ IP (เช่น "unknown", "1.2.3.4:5678" ที่ proxy บางตัวแปะพอร์ตมา)
 *   Postgres จะ error แล้ว **ทรานแซคชันทั้งก้อนล้ม** — ตอนสมัครสมาชิกแปลว่าสมัครไม่ผ่านเลย
 *   เพราะหลักฐานประกอบพังตัวเดียว ซึ่งไม่คุ้มเลย → ค่าที่ไม่ใช่ IP ให้เก็บเป็น null แทน
 *   (บันทึกความยินยอมที่ไม่มี IP ยังใช้ได้ ดีกว่าบันทึกค่าผิดหรือทำให้สมัครไม่ได้)
 *
 * ⚠ ข้อจำกัดที่ต้องรู้: แอปไม่ได้ตั้ง `trust proxy` ไว้ และ X-Forwarded-For ค่าแรกสุด
 *   เป็นค่าที่ client ใส่มาเองได้ → IP ที่ได้คือ "IP ที่ client อ้าง" ไม่ใช่ค่าที่พิสูจน์ได้ 100%
 *   ถ้าอนาคตรู้โครงสร้าง proxy แน่นอนแล้ว ควรเปลี่ยนไปอ่านค่าที่ proxy ของเราเติมเข้ามาแทน
 */
import { isIP } from 'net';
import type { Request } from 'express';

/**
 * ความยาวสูงสุดของ user agent ที่เก็บ
 * user agent ปกติยาวไม่ถึง 300 ตัวอักษร — ตัดไว้กันคนยิง header ยาวผิดปกติมาถมตาราง
 */
export const MAX_USER_AGENT_LENGTH = 512;

/** หลักฐานประกอบคำขอที่ส่งต่อให้ ConsentService.recordMany */
export interface RequestEvidence {
  ipAddress: string | null;
  userAgent: string | null;
}

/** รับแค่ส่วนของ request ที่ต้องใช้ → เทสง่าย ไม่ต้องสร้าง Request เต็มตัว */
type RequestLike = Pick<Request, 'headers'> & { ip?: string };

/**
 * แปลงค่าที่อ่านมาให้เป็น IP ที่ Postgres `inet` รับได้ — ไม่ใช่ IP คืน null
 *
 * รองรับรูปแบบที่เจอจริงจาก proxy:
 *   "203.0.113.9"          → "203.0.113.9"
 *   "203.0.113.9:51234"    → "203.0.113.9"   (Azure App Service แปะพอร์ตมาด้วย)
 *   "[2001:db8::1]:443"    → "2001:db8::1"
 *   "fe80::1%eth0"         → "fe80::1"       (inet ไม่รับ zone id)
 *   "unknown" / ""         → null
 */
export function normalizeIp(value: string | null | undefined): string | null {
  if (!value) return null;
  let ip = value.trim();

  // IPv6 ในวงเล็บเหลี่ยม อาจมีพอร์ตต่อท้าย: [2001:db8::1]:443
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracketed) ip = bracketed[1];

  // IPv4 ที่มีพอร์ตต่อท้าย: 203.0.113.9:51234
  const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(ip);
  if (ipv4WithPort) ip = ipv4WithPort[1];

  // zone id ของ IPv6 (fe80::1%eth0) — Postgres inet ไม่รับ
  const zoneIndex = ip.indexOf('%');
  if (zoneIndex !== -1) ip = ip.slice(0, zoneIndex);

  return isIP(ip) !== 0 ? ip : null;
}

/**
 * IP ของ client
 *
 * อ่าน X-Forwarded-For ก่อน เพราะแอปอยู่หลัง proxy (`req.ip` จะเป็น IP ของ proxy)
 * เอาค่าแรกในลิสต์ = client ส่วนค่าถัดไปคือ proxy ที่ส่งต่อกันมา
 * ถ้าค่าแรกไม่ใช่ IP ที่ถูกต้อง → ถอยไปใช้ `req.ip` → ยังไม่ได้อีกก็คืน null
 */
export function clientIpOf(req: RequestLike): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return normalizeIp(raw?.split(',')[0]) ?? normalizeIp(req.ip);
}

/** User agent ของ client — ตัดความยาวไว้ และค่าว่างถือว่าไม่มี */
export function userAgentOf(req: Pick<Request, 'headers'>): string | null {
  const userAgent = req.headers['user-agent']?.trim();
  return userAgent ? userAgent.slice(0, MAX_USER_AGENT_LENGTH) : null;
}

/** รวม IP + user agent ไว้ในก้อนเดียว — resolver เรียกฟังก์ชันนี้ตัวเดียวพอ */
export function requestEvidenceOf(req: RequestLike): RequestEvidence {
  return { ipAddress: clientIpOf(req), userAgent: userAgentOf(req) };
}
