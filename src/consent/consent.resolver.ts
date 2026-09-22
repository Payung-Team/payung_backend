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
import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ConsentPolicyService } from './consent-policy.service';
import {
  type LatestConsentRecord,
  ConsentService,
} from './consent.service';
import { ConsentPolicy } from './entities/consent-policy.entity';
import { ConsentStatus } from './entities/consent-status.entity';
import {
  CONSENT_SOURCE,
  type ConsentSource,
  POLICY_VERSION,
} from './consent.constants';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { requestEvidenceOf } from '../common/utils/request-evidence';
import type { GqlContext } from '../common/types/gql-context.type';
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
    return latest.map(toStatus);
  }

  /**
   * grantConsent / withdrawConsent — จัดการความยินยอมทีละข้อจากหน้าตั้งค่า (PYG-540)
   *
   * ★ ประกาศความเป็นส่วนตัวของเราบอกผู้ใช้ว่า "ถอนความยินยอมได้ทุกเมื่อ" (PYG-472)
   *   สองเมธอดนี้คือทางที่ทำให้คำสัญญานั้นเป็นจริง ไม่ใช่แค่ข้อความในเอกสาร
   *
   * ★ การถอน **มีผลไปข้างหน้า** ไม่ลบข้อมูลที่เก็บไปแล้ว และไม่กระทบงานที่รับไปแล้ว
   *   (ตรงกับที่เขียนไว้ในประกาศ) · การขอ "ลบ" ข้อมูลเป็นสิทธิ์คนละข้อ ยังไม่มีในระบบ
   */
  @Mutation(() => ConsentStatus, {
    description:
      'ให้ความยินยอมข้อหนึ่ง — policyVersion ต้องเป็นค่าจาก consentPolicy.version ' +
      'ไม่งั้นได้ CONSENT_POLICY_VERSION_MISMATCH',
  })
  @UseGuards(SupabaseAuthGuard)
  async grantConsent(
    @CurrentUser() user: AuthUser,
    @Args('type', { description: 'ค่าจาก consentPolicy.items[].type' }) type: string,
    @Args('policyVersion', { description: 'ค่าจาก consentPolicy.version' })
    policyVersion: string,
    @Context() ctx: GqlContext,
  ): Promise<ConsentStatus> {
    const record = await this.consentService.setConsent(
      user.id,
      type,
      true,
      { source: CONSENT_SOURCE.SETTINGS, ...requestEvidenceOf(ctx.req) },
      policyVersion,
    );
    return toStatus(record);
  }

  @Mutation(() => ConsentStatus, {
    description:
      'ถอนความยินยอมข้อหนึ่ง · ถอนข้อที่ไม่เคยให้ความยินยอมก็ทำได้ (idempotent) · ' +
      'มีผลไปข้างหน้า ไม่ลบข้อมูลที่เก็บไปแล้ว',
  })
  @UseGuards(SupabaseAuthGuard)
  async withdrawConsent(
    @CurrentUser() user: AuthUser,
    @Args('type', { description: 'ค่าจาก consentPolicy.items[].type' }) type: string,
    @Context() ctx: GqlContext,
  ): Promise<ConsentStatus> {
    // ★ ไม่ต้องส่ง policyVersion — การถอนไม่ได้ขึ้นกับว่าอ่านฉบับไหนมา
    //   ถ้าบังคับส่ง ผู้ใช้ที่ยินยอมไว้กับฉบับเก่าจะถอนไม่ได้ ซึ่งกลับหัวกลับหาง
    const record = await this.consentService.setConsent(user.id, type, false, {
      source: CONSENT_SOURCE.SETTINGS,
      ...requestEvidenceOf(ctx.req),
    });
    return toStatus(record);
  }
}

/** LatestConsentRecord → ConsentStatus ของ GraphQL */
function toStatus(record: LatestConsentRecord): ConsentStatus {
  return {
    type: record.type,
    granted: record.granted,
    policyVersion: record.policyVersion,
    answeredAt: record.answeredAt,
    source: record.source ?? undefined,
    isCurrentVersion: record.policyVersion === POLICY_VERSION,
  };
}
