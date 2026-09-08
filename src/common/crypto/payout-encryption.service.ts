/**
 * PayoutEncryptionService — PYG-266: เข้ารหัส/ถอดรหัสเลขบัญชีธนาคารของ caregiver
 *
 * AES-256-GCM ผ่าน Node `crypto` builtin (ไม่เพิ่ม dependency — เหมือน webhook
 * signature verification ใน payment/webhook/omise.controller.ts ที่ใช้ crypto อยู่แล้ว)
 *
 * Key: PAYOUT_ENCRYPTION_KEY (env, base64, ต้อง decode แล้วได้ 32 ไบต์พอดี)
 * validate แบบ lazy (ตอนเรียก encrypt/decrypt ครั้งแรก) ไม่ throw ตอน constructor
 * เพราะ service นี้อยู่ใน CommonModule ที่เป็น @Global() — ถ้า throw ตอน constructor
 * แอปทั้งตัวจะบูตไม่ขึ้นในทุก environment ที่ยังไม่ตั้งค่า env ตัวนี้ (mirror ของ
 * OmiseService ที่เช็ค OMISE_SECRET_KEY ต่อ-call ไม่ใช่ตอน construction)
 *
 * Format ที่เก็บลง DB (accountNumberEnc, string เดียว):
 *   base64(iv):base64(authTag):base64(ciphertext)
 * (colon ปลอดภัยเป็น delimiter เพราะ base64 alphabet ไม่มี ':')
 */
import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const KEY_LENGTH_BYTES = 32;

@Injectable()
export class PayoutEncryptionService {
  private readonly logger = new Logger(PayoutEncryptionService.name);

  constructor(private readonly config: ConfigService) {}

  private getKey(): Buffer {
    const keyBase64 = this.config.get<string>('PAYOUT_ENCRYPTION_KEY');
    if (!keyBase64) {
      throw new InternalServerErrorException(
        'ยังไม่ได้ตั้งค่า PAYOUT_ENCRYPTION_KEY — ไม่สามารถเข้ารหัส/ถอดรหัสเลขบัญชีได้',
      );
    }
    const key = Buffer.from(keyBase64, 'base64');
    if (key.length !== KEY_LENGTH_BYTES) {
      throw new InternalServerErrorException(
        `PAYOUT_ENCRYPTION_KEY ต้อง decode (base64) แล้วได้ ${KEY_LENGTH_BYTES} ไบต์พอดี (ปัจจุบัน: ${key.length})`,
      );
    }
    return key;
  }

  /** เข้ารหัสเลขบัญชี (plaintext) เป็น string เดียว เก็บลง accountNumberEnc */
  encrypt(plaintext: string): string {
    const key = this.getKey();
    const iv = crypto.randomBytes(IV_LENGTH_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [
      iv.toString('base64'),
      authTag.toString('base64'),
      ciphertext.toString('base64'),
    ].join(':');
  }

  /** ถอดรหัส accountNumberEnc กลับเป็น plaintext — throw ถ้า tamper/key ผิด */
  decrypt(packed: string): string {
    const key = this.getKey();
    const parts = packed.split(':');
    if (parts.length !== 3) {
      throw new InternalServerErrorException('accountNumberEnc มีรูปแบบไม่ถูกต้อง');
    }
    const [ivB64, authTagB64, ciphertextB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');
    const ciphertext = Buffer.from(ciphertextB64, 'base64');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    try {
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plaintext.toString('utf8');
    } catch (err) {
      this.logger.error('[PayoutEncryption] decrypt failed — tamper หรือ key ผิด');
      throw new InternalServerErrorException('ไม่สามารถถอดรหัสเลขบัญชีได้');
    }
  }

  /** เลข 4 หลักสุดท้าย สำหรับแสดงผล/log แทนเลขเต็ม */
  last4(plaintext: string): string {
    return plaintext.slice(-4);
  }
}
