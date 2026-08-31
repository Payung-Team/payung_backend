/**
 * PayoutKillswitch tests (PYG-331 ก้อน B)
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PayoutKillswitch } from './payout-killswitch';

async function make(value?: string) {
  const mod: TestingModule = await Test.createTestingModule({
    providers: [
      PayoutKillswitch,
      {
        provide: ConfigService,
        useValue: {
          get: jest.fn((key: string) =>
            key === 'PAYOUT_KILLSWITCH_ENABLED' ? value : undefined,
          ),
        },
      },
    ],
  }).compile();
  return mod.get(PayoutKillswitch);
}

describe('PayoutKillswitch', () => {
  it.each(['true', 'TRUE', 'True', '1', 'yes', 'YES', ' true '])(
    'isEnabled=true for "%s"',
    async (v) => {
      const ks = await make(v);
      expect(ks.isEnabled()).toBe(true);
    },
  );

  it.each(['false', '0', 'no', '', 'anything else', undefined])(
    'isEnabled=false for "%s"',
    async (v) => {
      const ks = await make(v);
      expect(ks.isEnabled()).toBe(false);
    },
  );

  it('gate returns true when enabled (caller should skip)', async () => {
    const ks = await make('true');
    expect(ks.gate('TestSource')).toBe(true);
  });

  it('gate returns false when disabled (caller should continue)', async () => {
    const ks = await make('false');
    expect(ks.gate('TestSource')).toBe(false);
  });
});
