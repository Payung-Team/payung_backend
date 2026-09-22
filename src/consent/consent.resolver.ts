/**
 * ConsentResolver — เสิร์ฟข้อความ consent ให้ FE (PYG-472) + สถานะความยินยอมของฉัน (PYG-474)
 *
 * ★ `consentPolicy` ไม่มี guard โดยตั้งใจ: ข้อความต้องอ่านได้ "ก่อน" สมัครสมาชิก
 *   ถ้าบังคับ login ผู้ใช้จะต้องสร้างบัญชีก่อนถึงจะได้อ่านว่าเรากำลังจะเก็บอะไรของเขา
 *   ซึ่งกลับหัวกลับหางกับหลักการของ PDPA — และเนื้อหาไม่ใช่ความลับอยู่แล้ว
 *
 * ★ `myConsents` / `withdrawConsent` / `grantConsent` ต้อง login — เป็นข้อมูลส่วนตัวของแต่ละคน
 *   และทำได้เฉพาะของตัวเองเท่านั้น (ใช้ id + role จาก token ไม่รับ userId จาก client)
 *   ★ ไม่มีทางให้ใคร "ถอนแทน" คนอื่นได้ — ความยินยอมเป็นของเจ้าของข้อมูลเท่านั้น
 */
import { UseGuards } from '@nestjs/common';
import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ConsentPolicyService } from './consent-policy.service';
import { ConsentService, type MyConsentStatus } from './consent.service';
import { ConsentPolicy } from './entities/consent-policy.entity';
import { ConsentStatus } from './entities/consent-status.entity';
import { CONSENT_SOURCE, type ConsentSource } from './consent.constants';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import {
  AuthUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import type { GqlContext } from '../common/types/gql-context.type';
import { requestEvidenceOf } from '../common/utils/request-evidence';

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
    @Args('source', {
      nullable: true,
      description: 'จุดในแอปที่กำลังขอความยินยอม',
    })
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
   * myConsents — สถานะความยินยอมของผู้ใช้ที่ login อยู่ (PYG-474 · PYG-540)
   *
   * ```graphql
   * query { myConsents { type granted answered policyVersion answeredAt source
   *                      isCurrentVersion required withdrawable } }
   * ```
   * PYG-540: คืน "ทุกข้อที่เกี่ยวกับ role" รวมข้อที่ยังไม่เคยตอบ (answered = false)
   * ข้อความของแต่ละข้อให้จับคู่กับ `consentPolicy.items[].type`
   */
  @Query(() => [ConsentStatus], {
    name: 'myConsents',
    description:
      'สถานะความยินยอมของผู้ใช้ที่ login อยู่ ทุกข้อที่เกี่ยวกับ role (รวมข้อที่ยังไม่เคยตอบ) · ' +
      'จับคู่ข้อความกับ consentPolicy.items[].type',
  })
  @UseGuards(SupabaseAuthGuard)
  async myConsents(@CurrentUser() user: AuthUser): Promise<ConsentStatus[]> {
    const statuses = await this.consentService.getMyConsents(
      user.id,
      user.role,
    );
    return statuses.map(toGraphql);
  }

  /**
   * withdrawConsent — ถอนความยินยอม (PYG-540)
   *
   * เขียนแถวใหม่ granted = false · source = 'settings' · IP + user agent จาก request
   * ถอนข้อที่ไม่เคยให้ = ผ่าน (idempotent) · ถอนข้อกำหนด/ประกาศความเป็นส่วนตัว = CONSENT_NOT_WITHDRAWABLE
   * มีผลไปข้างหน้าเท่านั้น ไม่ลบข้อมูลย้อนหลัง
   */
  @Mutation(() => ConsentStatus, {
    name: 'withdrawConsent',
    description:
      'ถอนความยินยอมหนึ่งข้อ — มีผลทันที (จองใหม่ไม่ได้ / กลุ่มไม่เห็นข้อมูล / หยุดอีเมลข่าวสาร ' +
      'ตามข้อที่ถอน) · ไม่ลบข้อมูลย้อนหลัง',
  })
  @UseGuards(SupabaseAuthGuard)
  async withdrawConsent(
    @CurrentUser() user: AuthUser,
    @Args('type', { description: 'ค่าจาก consentPolicy.items[].type' })
    type: string,
    @Context() ctx: GqlContext,
  ): Promise<ConsentStatus> {
    const status = await this.consentService.withdraw(
      user.id,
      user.role,
      type,
      requestEvidenceOf(ctx.req),
    );
    return toGraphql(status);
  }

  /**
   * grantConsent — ให้ความยินยอม (กลับ) หนึ่งข้อ (PYG-540)
   *
   * ใช้กับข้อที่เคยปฏิเสธ/ถอน (เช่น marketing) และ re-consent เมื่อนโยบายขึ้นเวอร์ชัน
   * policyVersion ต้องมาจาก consentPolicy.version — ไม่ตรง = CONSENT_POLICY_VERSION_MISMATCH
   */
  @Mutation(() => ConsentStatus, {
    name: 'grantConsent',
    description:
      'ให้ความยินยอมหนึ่งข้อ (รวมถึงให้กลับหลังถอน / re-consent) · ' +
      'policyVersion ต้องมาจาก consentPolicy.version',
  })
  @UseGuards(SupabaseAuthGuard)
  async grantConsent(
    @CurrentUser() user: AuthUser,
    @Args('type', { description: 'ค่าจาก consentPolicy.items[].type' })
    type: string,
    @Args('policyVersion', {
      description:
        'เวอร์ชันนโยบายที่ผู้ใช้เห็นตอนกด (จาก consentPolicy.version)',
    })
    policyVersion: string,
    @Context() ctx: GqlContext,
  ): Promise<ConsentStatus> {
    const status = await this.consentService.grant(
      user.id,
      user.role,
      type,
      policyVersion,
      requestEvidenceOf(ctx.req),
    );
    return toGraphql(status);
  }
}

/** null → undefined ให้ตรงกับ field แบบ nullable ของ code-first */
function toGraphql(status: MyConsentStatus): ConsentStatus {
  return {
    type: status.type,
    granted: status.granted,
    answered: status.answered,
    policyVersion: status.policyVersion ?? undefined,
    answeredAt: status.answeredAt ?? undefined,
    source: status.source ?? undefined,
    isCurrentVersion: status.isCurrentVersion,
    required: status.required,
    withdrawable: status.withdrawable,
  };
}
