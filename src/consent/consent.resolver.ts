/**
 * ConsentResolver — เสิร์ฟข้อความ consent ให้ FE (PYG-472) + สถานะความยินยอมของฉัน (PYG-474)
 *
 * ★ `consentPolicy` ไม่มี guard โดยตั้งใจ: ข้อความต้องอ่านได้ "ก่อน" สมัครสมาชิก
 *   ถ้าบังคับ login ผู้ใช้จะต้องสร้างบัญชีก่อนถึงจะได้อ่านว่าเรากำลังจะเก็บอะไรของเขา
 *   ซึ่งกลับหัวกลับหางกับหลักการของ PDPA — และเนื้อหาไม่ใช่ความลับอยู่แล้ว
 *
 * ★ `myConsents` ต้อง login — เป็นข้อมูลส่วนตัวของผู้ใช้แต่ละคน
 *   และอ่านได้เฉพาะของตัวเองเท่านั้น (ใช้ id จาก token ไม่รับ userId จาก client)
 */
import { UseGuards } from '@nestjs/common';
import { Args, Query, Resolver } from '@nestjs/graphql';
import { ConsentPolicyService } from './consent-policy.service';
import { ConsentService } from './consent.service';
import { ConsentPolicy } from './entities/consent-policy.entity';
import { ConsentStatus } from './entities/consent-status.entity';
import {
  CONSENT_SOURCE,
  type ConsentSource,
  POLICY_VERSION,
} from './consent.constants';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import {
  AuthUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator';

const SOURCES = Object.values(CONSENT_SOURCE);

@Resolver(() => ConsentPolicy)
export class ConsentResolver {
  constructor(
    private readonly policy: ConsentPolicyService,
    // PYG-474: อ่านความยินยอมล่าสุดของผู้ใช้จาก user_consents
    private readonly consentService: ConsentService,
  ) {}

  @Query(() => ConsentPolicy, {
    name: 'consentPolicy',
    description:
      'ข้อความความยินยอมและประกาศความเป็นส่วนตัวที่บังคับใช้อยู่ · ' +
      'ส่ง source เพื่อขอเฉพาะข้อที่ต้องแสดง ณ จุดนั้น (register / onboarding / booking / ' +
      'family_group / settings) · ไม่ส่ง = ได้ทุกข้อ',
  })
  consentPolicy(
    @Args('source', { nullable: true, description: 'จุดในแอปที่กำลังขอความยินยอม' })
    source?: string,
  ): ConsentPolicy {
    // ค่าที่ไม่รู้จัก → ถือว่าไม่ได้ระบุ แล้วคืนทุกข้อ
    // ★ ไม่ throw เพราะผลเสียของการคืนข้อมากเกินไปคือ "ผู้ใช้เห็นข้อที่ยังไม่ต้องตอบ"
    //   ส่วนผลเสียของการ throw คือหน้าสมัครพังทั้งหน้า ซึ่งแย่กว่ามาก
    const valid = SOURCES.includes(source as ConsentSource)
      ? (source as ConsentSource)
      : undefined;
    return this.policy.getPolicy(valid);
  }

  /**
   * myConsents — ความยินยอมล่าสุดของผู้ใช้ที่ login อยู่ ข้อละหนึ่งรายการ (PYG-474)
   *
   * ```graphql
   * query { myConsents { type granted policyVersion answeredAt source isCurrentVersion } }
   * ```
   * คืนเฉพาะข้อที่เคยตอบ · ข้อความของแต่ละข้อให้จับคู่กับ `consentPolicy.items[].type`
   */
  @Query(() => [ConsentStatus], {
    name: 'myConsents',
    description:
      'ความยินยอมล่าสุดของผู้ใช้ที่ login อยู่ ข้อละหนึ่งรายการ (เฉพาะข้อที่เคยตอบ) · ' +
      'จับคู่ข้อความกับ consentPolicy.items[].type',
  })
  @UseGuards(SupabaseAuthGuard)
  async myConsents(@CurrentUser() user: AuthUser): Promise<ConsentStatus[]> {
    const latest = await this.consentService.findLatestByUser(user.id);
    return latest.map((record) => ({
      type: record.type,
      granted: record.granted,
      policyVersion: record.policyVersion,
      answeredAt: record.answeredAt,
      source: record.source ?? undefined,
      isCurrentVersion: record.policyVersion === POLICY_VERSION,
    }));
  }
}
