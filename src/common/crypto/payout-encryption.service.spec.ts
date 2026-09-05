/**
 * PayoutEncryptionService tests (PYG-266)
 *
 * ครอบคลุม:
 *  - encrypt → decrypt round-trip คืนค่าเดิม
 *  - encrypt ค่าเดิม 2 ครั้ง ได้ ciphertext ต่างกัน (random IV)
 *  - tamper ciphertext → decrypt throw
 *  - ไม่ตั้งค่า/key ผิดขนาด → throw ตอนเรียก encrypt/decrypt เท่านั้น ไม่ throw ตอน construct
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { InternalServerErrorException } from '@nestjs/common';
import { PayoutEncryptionService } from './payout-encryption.service';

const VALID_KEY = Buffer.alloc(32, 7).toString('base64'); // 32 bytes, deterministic

async function buildService(keyValue: string | undefined): Promise<PayoutEncryptionService> {
  const moduleRef: TestingModule = await Test.createTestingModule({
    providers: [
      PayoutEncryptionService,
      {
        provide: ConfigService,
        useValue: { get: jest.fn().mockReturnValue(keyValue) },
      },
    ],
  }).compile();
  return moduleRef.get(PayoutEncryptionService);
}

describe('PayoutEncryptionService (PYG-266)', () => {
  it('encrypt → decrypt round-trip คืนค่าเดิม', async () => {
    const service = await buildService(VALID_KEY);
    const plaintext = '1234566789';

    const packed = service.encrypt(plaintext);
    expect(service.decrypt(packed)).toBe(plaintext);
  });

  it('packed string เป็น iv:authTag:ciphertext (3 ส่วน คั่นด้วย :)', async () => {
    const service = await buildService(VALID_KEY);
    const packed = service.encrypt('1234566789');
    expect(packed.split(':')).toHaveLength(3);
  });

  it('encrypt ค่าเดิมสองครั้ง → ciphertext ต่างกัน (random IV ทุกครั้ง)', async () => {
    const service = await buildService(VALID_KEY);
    const a = service.encrypt('1234566789');
    const b = service.encrypt('1234566789');
    expect(a).not.toBe(b);
  });

  it('last4 คืนเลข 4 หลักท้าย', async () => {
    const service = await buildService(VALID_KEY);
    expect(service.last4('1234566789')).toBe('6789');
  });

  it('tamper ciphertext → decrypt throw (auth tag mismatch)', async () => {
    const service = await buildService(VALID_KEY);
    const packed = service.encrypt('1234566789');
    const [iv, authTag, ciphertext] = packed.split(':');
    // flip a byte กลาง ๆ ของ ciphertext จริง (ไม่ใช่ string char — กัน edge case
    // ที่ base64 char ตัวสุดท้ายบางตัวไม่ได้เปลี่ยนค่า byte ที่ decode ได้จริง)
    const ciphertextBuf = Buffer.from(ciphertext, 'base64');
    ciphertextBuf[Math.floor(ciphertextBuf.length / 2)] ^= 0xff;
    const tampered = [iv, authTag, ciphertextBuf.toString('base64')].join(':');

    expect(() => service.decrypt(tampered)).toThrow();
  });

  it('ไม่ได้ตั้งค่า PAYOUT_ENCRYPTION_KEY → ไม่ throw ตอน construct (lazy validation)', async () => {
    // instantiating ต้องไม่ throw — ถ้า throw ตรงนี้ทั้งแอปจะบูตไม่ขึ้นในทุก
    // environment ที่ยังไม่ตั้งค่า env ตัวนี้ (service อยู่ใน @Global() CommonModule)
    await expect(buildService(undefined)).resolves.toBeDefined();
  });

  it('ไม่ได้ตั้งค่า PAYOUT_ENCRYPTION_KEY → throw ตอนเรียก encrypt() จริง', async () => {
    const service = await buildService(undefined);
    expect(() => service.encrypt('1234566789')).toThrow(InternalServerErrorException);
  });

  it('key ผิดขนาด (ไม่ใช่ 32 bytes หลัง decode) → throw ตอนเรียก encrypt()', async () => {
    const shortKey = Buffer.alloc(16, 1).toString('base64');
    const service = await buildService(shortKey);
    expect(() => service.encrypt('1234566789')).toThrow(InternalServerErrorException);
  });
});
