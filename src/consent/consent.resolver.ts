/**
 * ConsentResolver — เสิร์ฟข้อความ consent ให้ FE (PYG-472)
 *
 * ★ ไม่มี guard โดยตั้งใจ: ข้อความต้องอ่านได้ "ก่อน" สมัครสมาชิก
 *   ถ้าบังคับ login ผู้ใช้จะต้องสร้างบัญชีก่อนถึงจะได้อ่านว่าเรากำลังจะเก็บอะไรของเขา
 *   ซึ่งกลับหัวกลับหางกับหลักการของ PDPA — และเนื้อหาไม่ใช่ความลับอยู่แล้ว
 */
import { Args, Query, Resolver } from '@nestjs/graphql';
import { ConsentPolicyService } from './consent-policy.service';
import { ConsentPolicy } from './entities/consent-policy.entity';
import { CONSENT_SOURCE, type ConsentSource } from './consent.constants';

const SOURCES = Object.values(CONSENT_SOURCE);

@Resolver(() => ConsentPolicy)
export class ConsentResolver {
  constructor(private readonly policy: ConsentPolicyService) {}

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
}
