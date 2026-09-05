/**
 * OmiseController — เทสต์ FAIL CLOSED
 *
 * บั๊กเดิมคือ fail-open: ไม่มี `OMISE_WEBHOOK_SECRET` → log warn → **ไหลลงไปประมวลผลต่อ**
 * และ header ที่อ่านผิดชื่อทำให้ signature เป็น undefined เสมอ → เข้าเส้นเดียวกัน
 *
 * เทสต์ชุดนี้ตรึงว่า "ทุกเส้นทางที่ตรวจไม่ได้ ต้องจบด้วย error และห้ามแตะ service เลย"
 * ถ้าวันหนึ่งมีใครเติม else ที่ปล่อยผ่าน เทสต์กลุ่มนี้จะแดงทันที
 */
import * as crypto from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { OmiseController } from './omise.controller';
import { PaymentService } from '../payment.service';
import { RefundService } from '../refund.service';
import { OMISE_SIGNATURE_TOLERANCE_SECONDS } from './omise-signature';

const SECRET_B64 = Buffer.from('super-secret-key-for-tests-32byte').toString('base64');

const BODY = { key: 'charge.complete', data: { id: 'chrg_test_1' } };
const RAW = Buffer.from(JSON.stringify(BODY), 'utf8');

function sign(rawBody: Buffer, timestamp: string): string {
  return crypto
    .createHmac('sha256', Buffer.from(SECRET_B64, 'base64'))
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest('hex');
}

/** จำลอง req ที่มี rawBody (มาจาก NestFactory { rawBody: true }) */
function reqWith(rawBody?: Buffer): RawBodyRequest<Request> {
  return { rawBody } as RawBodyRequest<Request>;
}

describe('OmiseController — fail closed', () => {
  let controller: OmiseController;
  let paymentService: { captureFromWebhook: jest.Mock; voidFromWebhook: jest.Mock };
  let refundService: { reconcileFromWebhook: jest.Mock };
  let config: { get: jest.Mock };

  const nowTs = () => String(Math.floor(Date.now() / 1000));

  beforeEach(async () => {
    paymentService = {
      captureFromWebhook: jest.fn().mockResolvedValue(undefined),
      voidFromWebhook: jest.fn().mockResolvedValue(undefined),
    };
    refundService = { reconcileFromWebhook: jest.fn().mockResolvedValue(undefined) };
    config = { get: jest.fn().mockReturnValue(SECRET_B64) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [OmiseController],
      providers: [
        { provide: ConfigService, useValue: config },
        { provide: PaymentService, useValue: paymentService },
        { provide: RefundService, useValue: refundService },
      ],
    }).compile();

    controller = moduleRef.get(OmiseController);
  });

  /** ยืนยันว่าไม่มี service ไหนถูกแตะเลย */
  const expectNothingProcessed = () => {
    expect(paymentService.captureFromWebhook).not.toHaveBeenCalled();
    expect(paymentService.voidFromWebhook).not.toHaveBeenCalled();
    expect(refundService.reconcileFromWebhook).not.toHaveBeenCalled();
  };

  // ── เส้นที่เคย fail-open ────────────────────────────────────────────────
  it('ไม่ได้ตั้ง OMISE_WEBHOOK_SECRET → 500 และไม่ประมวลผลอะไรเลย (เดิมปล่อยผ่าน)', async () => {
    config.get.mockReturnValue(undefined);
    const ts = nowTs();

    await expect(
      controller.handle(reqWith(RAW), BODY, sign(RAW, ts), ts),
    ).rejects.toBeInstanceOf(InternalServerErrorException);

    expectNothingProcessed();
  });

  it('secret ตั้งไว้เป็นค่าที่ decode base64 ไม่ออก → 500 ไม่ใช่ปล่อยผ่าน', async () => {
    config.get.mockReturnValue('!!!!');
    const ts = nowTs();

    await expect(
      controller.handle(reqWith(RAW), BODY, sign(RAW, ts), ts),
    ).rejects.toBeInstanceOf(InternalServerErrorException);

    expectNothingProcessed();
  });

  it('ไม่มี signature header → 400 (เดิม header ผิดชื่อ ทำให้เข้าเส้นนี้ตลอดแล้วปล่อยผ่าน)', async () => {
    await expect(
      controller.handle(reqWith(RAW), BODY, undefined, nowTs()),
    ).rejects.toBeInstanceOf(BadRequestException);

    expectNothingProcessed();
  });

  it('ไม่มี timestamp header → 400', async () => {
    const ts = nowTs();
    await expect(
      controller.handle(reqWith(RAW), BODY, sign(RAW, ts), undefined),
    ).rejects.toBeInstanceOf(BadRequestException);

    expectNothingProcessed();
  });

  it('req.rawBody เป็น undefined → 400 ห้าม fallback ไป JSON.stringify(body)', async () => {
    const ts = nowTs();
    // ลายเซ็นถูกต้องทุกอย่าง ขาดแค่ rawBody — ถ้ามี fallback เทสต์นี้จะผ่านแบบผิด ๆ
    await expect(
      controller.handle(reqWith(undefined), BODY, sign(RAW, ts), ts),
    ).rejects.toBeInstanceOf(BadRequestException);

    expectNothingProcessed();
  });

  // ── เส้นที่พิสูจน์ตัวตนไม่ผ่าน ────────────────────────────────────────────
  it('ลายเซ็นไม่ตรง → 401', async () => {
    await expect(
      controller.handle(reqWith(RAW), BODY, 'a'.repeat(64), nowTs()),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expectNothingProcessed();
  });

  it('body ถูกแก้หลังเซ็น → 401 (ลายเซ็นของ body เดิมใช้กับ body ใหม่ไม่ได้)', async () => {
    const ts = nowTs();
    const goodSig = sign(RAW, ts);
    const tampered = Buffer.from(
      JSON.stringify({ key: 'charge.complete', data: { id: 'chrg_ATTACKER' } }),
      'utf8',
    );

    await expect(
      controller.handle(reqWith(tampered), BODY, goodSig, ts),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expectNothingProcessed();
  });

  it('replay ลายเซ็นเก่า → 401 แม้ลายเซ็นถูกต้อง', async () => {
    const oldTs = String(
      Math.floor(Date.now() / 1000) - OMISE_SIGNATURE_TOLERANCE_SECONDS - 60,
    );

    await expect(
      controller.handle(reqWith(RAW), BODY, sign(RAW, oldTs), oldTs),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expectNothingProcessed();
  });

  // ── เส้นที่ผ่านจริง ─────────────────────────────────────────────────────
  it('ลายเซ็นถูกต้อง → ประมวลผล event ตามปกติ', async () => {
    const ts = nowTs();

    const result = await controller.handle(reqWith(RAW), BODY, sign(RAW, ts), ts);

    expect(result).toEqual({ received: true });
    expect(paymentService.captureFromWebhook).toHaveBeenCalledWith('chrg_test_1');
  });

  it('ลายเซ็นหลายตัวคั่น comma ตอนหมุน secret → ผ่านถ้าตัวใดตัวหนึ่งถูก', async () => {
    const ts = nowTs();
    const header = `${'b'.repeat(64)},${sign(RAW, ts)}`;

    await expect(
      controller.handle(reqWith(RAW), BODY, header, ts),
    ).resolves.toEqual({ received: true });

    expect(paymentService.captureFromWebhook).toHaveBeenCalledWith('chrg_test_1');
  });
});
