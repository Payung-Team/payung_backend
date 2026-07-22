/**
 * OmiseService — Recipient/Transfer methods tests (PYG-266)
 *
 * ครอบคลุม:
 *  - createRecipient → REST shape (type=individual, name, email, bank_account[...])
 *  - retrieveRecipient → GET /recipients/:id + normalize
 *  - createTransfer → REST shape (recipient, amount) + Omise-Idempotency-Key header
 *  - error → mapOmiseError / network failure
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { OmiseService } from './omise.service';

const SECRET = 'skey_test_xyz';
const API_BASE = 'https://api.omise.test';
const RECIPIENT_ID = 'recp_test_1';

describe('OmiseService — Recipient/Transfer (PYG-266)', () => {
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

  function ok(body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), { status: 200 });
  }

  function omiseError(message: string, code = 'invalid_request'): Response {
    return new Response(JSON.stringify({ object: 'error', code, message }), { status: 400 });
  }

  // ─── createRecipient ─────────────────────────────────────────────────

  describe('createRecipient', () => {
    it('POST /recipients พร้อม type=individual, name, email, bank_account fields', async () => {
      fetchSpy.mockResolvedValue(
        ok({
          object: 'recipient',
          id: RECIPIENT_ID,
          verified: false,
          active: false,
          bank_account: { brand: 'kbank', last_digits: '6789', name: 'สมชาย ใจดี' },
        }),
      );

      const result = await service.createRecipient({
        name: 'สมชาย ใจดี',
        email: 'somchai@example.com',
        bankCode: 'kbank',
        accountNumber: '1234566789',
        accountName: 'สมชาย ใจดี',
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${API_BASE}/recipients`);
      expect(init?.method).toBe('POST');
      const body = (init?.body as URLSearchParams).toString();
      expect(body).toContain('type=individual');
      expect(body).toContain('email=somchai%40example.com');
      expect(body).toContain('bank_account%5Bbrand%5D=kbank');
      expect(body).toContain('bank_account%5Bnumber%5D=1234566789');

      expect(result).toEqual({
        id: RECIPIENT_ID,
        verified: false,
        active: false,
        bankAccount: { brand: 'kbank', lastDigits: '6789', name: 'สมชาย ใจดี' },
      });
    });

    it('Omise ตอบ error → throw PaymentError', async () => {
      fetchSpy.mockResolvedValue(omiseError('invalid bank account'));

      await expect(
        service.createRecipient({
          name: 'x',
          email: 'x@example.com',
          bankCode: 'kbank',
          accountNumber: '1234566789',
          accountName: 'x',
        }),
      ).rejects.toThrow();
    });

    it('network error → throw PaymentError', async () => {
      fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        service.createRecipient({
          name: 'x',
          email: 'x@example.com',
          bankCode: 'kbank',
          accountNumber: '1234566789',
          accountName: 'x',
        }),
      ).rejects.toThrow();
    });
  });

  // ─── retrieveRecipient ───────────────────────────────────────────────

  describe('retrieveRecipient', () => {
    it('GET /recipients/:id → normalize verified/active', async () => {
      fetchSpy.mockResolvedValue(
        ok({
          object: 'recipient',
          id: RECIPIENT_ID,
          verified: true,
          active: true,
          bank_account: { brand: 'kbank', last_digits: '6789', name: 'สมชาย ใจดี' },
        }),
      );

      const result = await service.retrieveRecipient(RECIPIENT_ID);

      expect(fetchSpy).toHaveBeenCalledWith(
        `${API_BASE}/recipients/${RECIPIENT_ID}`,
        expect.objectContaining({ method: 'GET' }),
      );
      expect(result.verified).toBe(true);
      expect(result.active).toBe(true);
    });
  });

  // ─── createTransfer ──────────────────────────────────────────────────

  describe('createTransfer', () => {
    it('POST /transfers พร้อม recipient + amount และ Omise-Idempotency-Key header', async () => {
      fetchSpy.mockResolvedValue(
        ok({ object: 'transfer', id: 'trsf_test_1', amount: 108000, recipient: RECIPIENT_ID }),
      );

      const result = await service.createTransfer(RECIPIENT_ID, 108000, 'transfer:pay-0001');

      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${API_BASE}/transfers`);
      const headers = init?.headers as Record<string, string>;
      expect(headers['Omise-Idempotency-Key']).toBe('transfer:pay-0001');
      const body = (init?.body as URLSearchParams).toString();
      expect(body).toContain(`recipient=${RECIPIENT_ID}`);
      expect(body).toContain('amount=108000');

      expect(result).toEqual({ id: 'trsf_test_1', amount: 108000, recipient: RECIPIENT_ID });
    });

    it('ไม่ส่ง idempotencyKey → ไม่มี header Omise-Idempotency-Key', async () => {
      fetchSpy.mockResolvedValue(
        ok({ object: 'transfer', id: 'trsf_test_2', amount: 5000, recipient: RECIPIENT_ID }),
      );

      await service.createTransfer(RECIPIENT_ID, 5000);

      const [, init] = fetchSpy.mock.calls[0];
      const headers = init?.headers as Record<string, string>;
      expect(headers['Omise-Idempotency-Key']).toBeUndefined();
    });

    it('Omise ตอบ error → throw', async () => {
      fetchSpy.mockResolvedValue(omiseError('recipient not verified'));

      await expect(service.createTransfer(RECIPIENT_ID, 1000)).rejects.toThrow();
    });
  });
});
