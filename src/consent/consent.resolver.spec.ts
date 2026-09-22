/**
 * PYG-474 — เทสของ query myConsents
 *
 * resolver แค่แปลงแถวล่าสุดเป็น GraphQL type — สิ่งที่ต้องคุมคือ
 *   - อ่านของ "ผู้ใช้ที่ login อยู่" เท่านั้น (ใช้ id จาก token)
 *   - isCurrentVersion คำนวณเทียบกับ POLICY_VERSION ที่บังคับใช้อยู่
 */
import { ConsentResolver } from './consent.resolver';
import type { ConsentPolicyService } from './consent-policy.service';
import type { ConsentService, LatestConsentRecord } from './consent.service';
import {
  CONSENT_SOURCE,
  CONSENT_TYPE,
  POLICY_VERSION,
} from './consent.constants';
import type { AuthUser } from '../common/decorators/current-user.decorator';

const USER: AuthUser = {
  id: 'user-1',
  supabaseUid: 'sb-1',
  email: 'somsri@example.com',
  role: 1,
  isSuspended: false,
};

describe('ConsentResolver.myConsents (PYG-474)', () => {
  let findLatestByUser: jest.Mock<Promise<LatestConsentRecord[]>, [string]>;
  let resolver: ConsentResolver;

  beforeEach(() => {
    findLatestByUser = jest.fn<Promise<LatestConsentRecord[]>, [string]>();
    resolver = new ConsentResolver(
      {} as ConsentPolicyService,
      { findLatestByUser } as unknown as ConsentService,
    );
  });

  it('★ อ่านด้วย id ของผู้ใช้ที่ login อยู่', async () => {
    findLatestByUser.mockResolvedValue([]);
    await resolver.myConsents(USER);
    expect(findLatestByUser).toHaveBeenCalledWith('user-1');
  });

  it('แปลงแถวล่าสุดเป็น ConsentStatus + บอกว่าตรงเวอร์ชันปัจจุบันไหม', async () => {
    const answeredAt = new Date('2026-09-22T10:00:00Z');
    findLatestByUser.mockResolvedValue([
      {
        type: CONSENT_TYPE.TERMS_OF_SERVICE,
        granted: true,
        policyVersion: POLICY_VERSION,
        answeredAt,
        source: CONSENT_SOURCE.REGISTER,
      },
      {
        // ยินยอมกับนโยบายฉบับเก่า → ต้อง re-consent
        type: CONSENT_TYPE.MARKETING,
        granted: true,
        policyVersion: '0.9',
        answeredAt,
        source: null,
      },
    ]);

    await expect(resolver.myConsents(USER)).resolves.toEqual([
      {
        type: CONSENT_TYPE.TERMS_OF_SERVICE,
        granted: true,
        policyVersion: POLICY_VERSION,
        answeredAt,
        source: CONSENT_SOURCE.REGISTER,
        isCurrentVersion: true,
      },
      {
        type: CONSENT_TYPE.MARKETING,
        granted: true,
        policyVersion: '0.9',
        answeredAt,
        source: undefined,
        isCurrentVersion: false,
      },
    ]);
  });
});
