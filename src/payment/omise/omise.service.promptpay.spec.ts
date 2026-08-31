/**
 * OmiseService — PromptPay methods tests (PYG-278)
 *
 * ครอบคลุม:
 *  - createPromptPayCharge → REST shape (source[type]=promptpay, no card, no capture flag)
 *  - QR URL extraction จาก nested source.scannable_code.image.download_uri
 *  - retrieveCharge → GET /charges/:id + normalize result
 *  - error → mapOmiseError / throw
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { OmiseService } from './omise.service';

const SECRET = 'skey_test_xyz';
const API_BASE = 'https://api.omise.test';
const CHARGE_ID = 'chrg_test_promptpay_1';
const QR_URL = 'https://api.omise.co/charges/' + CHARGE_ID + '/qr.png';

describe('OmiseService — PromptPay (PYG-278)', () => {
  let service: OmiseService;
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        OmiseService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'OMISE_API_BASE') return API_BASE;
              if (key === 'OMISE_SECRET_KEY') return SECRET;
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(OmiseService);
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // ─── createPromptPayCharge ────────────────────────────────────────────

  describe('createPromptPayCharge', () => {
    function ok(body: Record<string, unknown>): Response {
      return new Response(JSON.stringify(body), { status: 200 });
    }

    it('ส่ง POST /charges กับ source[type]=promptpay (ไม่มี card, ไม่มี capture)', async () => {
      fetchSpy.mockResolvedValue(
        ok({
          id: CHARGE_ID,
          status: 'pending',
          amount: 120000,
          captured: false,
          paid: false,
          authorized: false,
          source: { scannable_code: { image: { download_uri: QR_URL } } },
        }),
      );

      const result = await service.createPromptPayCharge(120000);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${API_BASE}/charges`);
      expect(opts?.method).toBe('POST');

      // body = URLSearchParams → toString แล้วเช็คฟิลด์
      const body = (opts?.body as URLSearchParams).toString();
      expect(body).toContain('amount=120000');
      expect(body).toContain('currency=thb');
      // x-www-form-urlencoded encodes [ as %5B and ] as %5D
      expect(body).toMatch(/source%5Btype%5D=promptpay/);
      expect(body).not.toContain('card=');
      expect(body).not.toContain('capture=');

      // QR URL extracted จาก nested response
      expect(result.id).toBe(CHARGE_ID);
      expect(result.status).toBe('pending');
      expect(result.qrCodeUrl).toBe(QR_URL);
    });

    it('Omise error response (HTTP 400) → throw mapped error', async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({
            object: 'error',
            code: 'invalid_amount',
            message: 'amount must be greater than 100 satangs',
          }),
          { status: 400 },
        ),
      );

      await expect(service.createPromptPayCharge(50)).rejects.toThrow();
    });

    it('Omise คืนไม่มี scannable_code → qrCodeUrl = undefined (ไม่ crash)', async () => {
      fetchSpy.mockResolvedValue(
        ok({ id: CHARGE_ID, status: 'pending', amount: 120000, source: {} }),
      );

      const result = await service.createPromptPayCharge(120000);
      expect(result.qrCodeUrl).toBeUndefined();
    });

    it('network error → throw mapped error', async () => {
      fetchSpy.mockRejectedValue(new Error('ECONNRESET'));
      await expect(service.createPromptPayCharge(120000)).rejects.toThrow();
    });
  });

  // ─── retrieveCharge ───────────────────────────────────────────────────

  describe('retrieveCharge', () => {
    it('GET /charges/:id + normalize result', async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({
            id: CHARGE_ID,
            status: 'successful',
            amount: 120000,
            captured: true,
            paid: true,
            authorized: true,
          }),
          { status: 200 },
        ),
      );

      const result = await service.retrieveCharge(CHARGE_ID);

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${API_BASE}/charges/${CHARGE_ID}`);
      expect(opts?.method).toBe('GET');

      expect(result.status).toBe('successful');
      expect(result.captured).toBe(true);
      expect(result.paid).toBe(true);
    });

    it('chargeId ว่าง → throw (ไม่ยิงไป Omise)', async () => {
      await expect(service.retrieveCharge('')).rejects.toThrow();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('Omise 404 → throw', async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({ object: 'error', code: 'not_found', message: 'charge not found' }),
          { status: 404 },
        ),
      );
      await expect(service.retrieveCharge('chrg_missing')).rejects.toThrow();
    });
  });
});
