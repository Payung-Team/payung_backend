/**
 * OmiseService — PYG-461/462: idempotency header ของ reverse/void + timeout ของ call ที่ถือ row lock
 *
 * ไม่มีการยิง Omise จริง — mock global fetch ทั้งหมด
 */
import { OmiseService } from './omise.service';

function makeService(
  env: Record<string, string | undefined> = {},
): OmiseService {
  const values: Record<string, string | undefined> = {
    OMISE_SECRET_KEY: 'skey_test_x',
    OMISE_API_BASE: 'https://api.omise.test',
    ...env,
  };
  const config = { get: (k: string, d?: unknown) => values[k] ?? d };
  return new OmiseService(config as never);
}

const okJson = (body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

type FetchInit = { headers?: Record<string, string>; signal?: AbortSignal };

describe('OmiseService — PYG-461/462 (settle: header + timeout)', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  const initOf = (i = 0) => fetchSpy.mock.calls[i][1] as FetchInit;

  it('reverseCharge ส่ง Omise-Idempotency-Key เมื่อระบุ', async () => {
    fetchSpy.mockResolvedValue(
      okJson({ object: 'charge', id: 'chrg_1', status: 'reversed' }),
    );

    await makeService().reverseCharge('chrg_1', 'void:chrg_1');

    expect(initOf().headers?.['Omise-Idempotency-Key']).toBe('void:chrg_1');
  });

  it('reverseCharge ไม่ระบุ key (caller เดิม: payment-cron) → ไม่มี header เหมือนเดิม', async () => {
    fetchSpy.mockResolvedValue(
      okJson({ object: 'charge', id: 'chrg_1', status: 'reversed' }),
    );

    await makeService().reverseCharge('chrg_1');

    expect(initOf().headers).not.toHaveProperty('Omise-Idempotency-Key');
  });

  it('voidCharge ส่ง key ต่อให้ reverseCharge (endpoint เดียวกัน)', async () => {
    fetchSpy.mockResolvedValue(
      okJson({ object: 'charge', id: 'chrg_1', status: 'reversed' }),
    );

    await makeService().voidCharge('chrg_1', 'void:chrg_1');

    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://api.omise.test/charges/chrg_1/reverse',
    );
    expect(initOf().headers?.['Omise-Idempotency-Key']).toBe('void:chrg_1');
  });

  it.each([
    ['reverseCharge', (s: OmiseService) => s.reverseCharge('chrg_1', 'k')],
    [
      'createRefund',
      (s: OmiseService) => s.createRefund('chrg_1', undefined, 'k'),
    ],
    ['retrieveCharge', (s: OmiseService) => s.retrieveCharge('chrg_1')],
  ])('%s ส่ง AbortSignal (timeout) ไปกับ fetch', async (_name, call) => {
    fetchSpy.mockResolvedValue(
      okJson({ object: 'charge', id: 'chrg_1', status: 'reversed' }),
    );

    await call(makeService());

    expect(initOf().signal).toBeInstanceOf(AbortSignal);
  });

  it('createCharge ไม่มี timeout โดยตั้งใจ (timeout ขณะ authorize = สถานะกำกวม ต้องการ์ดแยก)', async () => {
    fetchSpy.mockResolvedValue(
      okJson({
        object: 'charge',
        id: 'chrg_1',
        status: 'pending',
        authorized: true,
        paid: false,
      }),
    );

    await makeService()
      .createCharge(1000, 'tokn_1')
      .catch(() => undefined);

    expect(initOf().signal).toBeUndefined();
  });

  it('Omise ค้างเกิน OMISE_HTTP_TIMEOUT_MS → reverseCharge throw (ไม่ถือ lock ค้าง)', async () => {
    fetchSpy.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = (init as FetchInit).signal!;
          signal.addEventListener('abort', () =>
            reject(signal.reason as Error),
          );
        }),
    );

    const started = Date.now();
    await expect(
      makeService({ OMISE_HTTP_TIMEOUT_MS: '50' }).reverseCharge('chrg_1', 'k'),
    ).rejects.toThrow(/ติดต่อ Omise ไม่สำเร็จ/);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
