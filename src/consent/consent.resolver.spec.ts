/**
 * PYG-474 · PYG-540 — เทสของ ConsentResolver (myConsents / withdrawConsent / grantConsent)
 *
 * resolver แค่ส่งต่อให้ ConsentService — สิ่งที่ต้องคุมคือ
 *   - ทำกับ "ผู้ใช้ที่ login อยู่" เท่านั้น (ใช้ id + role จาก token)
 *   - IP / user agent ดึงจาก request (ไม่ใช่ให้ FE ส่งมา) แล้วส่งต่อเป็นหลักฐาน
 *   - แปลงค่า null ของ service เป็น undefined ให้ตรงกับ field nullable ของ GraphQL
 */
import { ConsentResolver } from './consent.resolver';
import type { ConsentPolicyService } from './consent-policy.service';
import type { ConsentService, MyConsentStatus } from './consent.service';
import {
  CONSENT_SOURCE,
  CONSENT_TYPE,
  POLICY_VERSION,
} from './consent.constants';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import type { GqlContext } from '../common/types/gql-context.type';

const USER: AuthUser = {
  id: 'user-1',
  supabaseUid: 'sb-1',
  email: 'somsri@example.com',
  role: 1,
  isSuspended: false,
};

/** request ปลอมที่มี IP + user agent ครบ */
const CTX = {
  req: {
    headers: { 'x-forwarded-for': '203.0.113.9', 'user-agent': 'jest/1.0' },
  },
} as unknown as GqlContext;

function status(overrides: Partial<MyConsentStatus> = {}): MyConsentStatus {
  return {
    type: CONSENT_TYPE.MARKETING,
    granted: false,
    answered: false,
    policyVersion: null,
    answeredAt: null,
    source: null,
    isCurrentVersion: false,
    required: false,
    withdrawable: true,
    ...overrides,
  };
}

describe('ConsentResolver (PYG-474 · PYG-540)', () => {
  let service: {
    getMyConsents: jest.Mock<Promise<MyConsentStatus[]>, [string, number]>;
    withdraw: jest.Mock;
    grant: jest.Mock;
  };
  let resolver: ConsentResolver;

  beforeEach(() => {
    service = {
      getMyConsents: jest.fn<Promise<MyConsentStatus[]>, [string, number]>(),
      withdraw: jest.fn().mockResolvedValue(status()),
      grant: jest.fn().mockResolvedValue(status({ granted: true })),
    };
    resolver = new ConsentResolver(
      {} as ConsentPolicyService,
      service as unknown as ConsentService,
    );
  });

  describe('myConsents', () => {
    it('★ อ่านด้วย id + role ของผู้ใช้ที่ login อยู่', async () => {
      service.getMyConsents.mockResolvedValue([]);
      await resolver.myConsents(USER);
      expect(service.getMyConsents).toHaveBeenCalledWith('user-1', 1);
    });

    it('แปลง null เป็น undefined (ข้อที่ยังไม่เคยตอบ) และคงค่าที่มีอยู่', async () => {
      const answeredAt = new Date('2026-09-22T10:00:00Z');
      service.getMyConsents.mockResolvedValue([
        status({
          type: CONSENT_TYPE.TERMS_OF_SERVICE,
          granted: true,
          answered: true,
          policyVersion: POLICY_VERSION,
          answeredAt,
          source: CONSENT_SOURCE.REGISTER,
          isCurrentVersion: true,
          required: true,
          withdrawable: false,
        }),
        status(),
      ]);

      await expect(resolver.myConsents(USER)).resolves.toEqual([
        {
          type: CONSENT_TYPE.TERMS_OF_SERVICE,
          granted: true,
          answered: true,
          policyVersion: POLICY_VERSION,
          answeredAt,
          source: CONSENT_SOURCE.REGISTER,
          isCurrentVersion: true,
          required: true,
          withdrawable: false,
        },
        {
          type: CONSENT_TYPE.MARKETING,
          granted: false,
          answered: false,
          policyVersion: undefined,
          answeredAt: undefined,
          source: undefined,
          isCurrentVersion: false,
          required: false,
          withdrawable: true,
        },
      ]);
    });
  });

  it('★ withdrawConsent ส่ง id + role ของตัวเอง และหลักฐานจาก request', async () => {
    await resolver.withdrawConsent(USER, CONSENT_TYPE.MARKETING, CTX);
    expect(service.withdraw).toHaveBeenCalledWith(
      'user-1',
      1,
      CONSENT_TYPE.MARKETING,
      { ipAddress: '203.0.113.9', userAgent: 'jest/1.0' },
    );
  });

  it('★ grantConsent ส่ง policyVersion ที่ผู้ใช้เห็นต่อให้ service ตรวจ', async () => {
    await resolver.grantConsent(USER, CONSENT_TYPE.MARKETING, '1.0', CTX);
    expect(service.grant).toHaveBeenCalledWith(
      'user-1',
      1,
      CONSENT_TYPE.MARKETING,
      '1.0',
      { ipAddress: '203.0.113.9', userAgent: 'jest/1.0' },
    );
  });
});
