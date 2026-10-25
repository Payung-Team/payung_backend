/**
 * ConsentPolicyService — ประกอบนโยบายความยินยอมที่บังคับใช้อยู่ (PYG-472)
 *
 * อ่านอย่างเดียว ไม่แตะ DB — บันทึกคำตอบเป็นงานของ PYG-474
 *
 * ★ ประกาศความเป็นส่วนตัว + ข้อกำหนดการใช้บริการ อ่านจากไฟล์ .md ตอน bootstrap ครั้งเดียว แล้วถือไว้ในหน่วยความจำ
 *   ถ้าอ่านทุกคำขอ จะมี disk I/O ต่อทุกครั้งที่มีคนเปิดหน้าสมัคร ทั้งที่ไฟล์ไม่เคยเปลี่ยน
 *   ระหว่างรัน (เปลี่ยนเมื่อ deploy เท่านั้น)
 */
import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  CONSENT_SOURCE,
  type ConsentSource,
  POLICY_EFFECTIVE_DATE,
  POLICY_VERSION,
  REQUIRED_CONSENTS,
  CONSENTS_BY_SOURCE,
} from './consent.constants';
import {
  CONSENT_SCREEN_COPY,
  DATA_SUBJECT_RIGHTS_NOTE,
  PATIENT_CONSENT_ITEMS,
} from './consent.content';
import {
  ConsentItem,
  ConsentPolicy,
  ConsentScreenCopy,
} from './entities/consent-policy.entity';
import {
  PRIVACY_NOTICE_EN,
  PRIVACY_NOTICE_TH,
  TERMS_OF_SERVICE_EN,
  TERMS_OF_SERVICE_TH,
} from './consent-policy.documents.generated';

/** จุดที่มีหัวข้อ/คำนำเตรียมไว้ — จุดอื่นคืน screen = null ให้ FE ใช้ข้อความของตัวเอง */
const SCREEN_COPY_BY_SOURCE: Partial<Record<ConsentSource, ConsentScreenCopy>> =
  {
    [CONSENT_SOURCE.REGISTER]: CONSENT_SCREEN_COPY.register,
    [CONSENT_SOURCE.ONBOARDING]: CONSENT_SCREEN_COPY.onboarding,
    [CONSENT_SOURCE.BOOKING]: CONSENT_SCREEN_COPY.booking,
    [CONSENT_SOURCE.FAMILY_GROUP]: CONSENT_SCREEN_COPY.family_group,
  };

@Injectable()
export class ConsentPolicyService implements OnModuleInit {
  private privacyNoticeTh = '';
  private privacyNoticeEn = '';
  private termsOfServiceTh = '';
  private termsOfServiceEn = '';

  onModuleInit(): void {
    // Cloudflare Workers do not expose the deployed source tree as a normal
    // filesystem. These constants are generated from the Markdown sources at
    // build time so the complete legal documents are bundled with the Worker.
    this.privacyNoticeTh = PRIVACY_NOTICE_TH;
    this.privacyNoticeEn = PRIVACY_NOTICE_EN;
    this.termsOfServiceTh = TERMS_OF_SERVICE_TH;
    this.termsOfServiceEn = TERMS_OF_SERVICE_EN;
  }

  /**
   * นโยบายที่ต้องแสดง ณ จุดหนึ่ง
   *
   * ★ ไม่ส่ง source มา = คืนทุกข้อ — ใช้กับหน้า "ความเป็นส่วนตัว" ในตั้งค่า
   *   ที่ผู้ใช้ดูและถอนความยินยอมย้อนหลังได้ทุกข้อในที่เดียว
   */
  getPolicy(source?: ConsentSource): ConsentPolicy {
    const wanted = source ? CONSENTS_BY_SOURCE[source] : null;

    const items = PATIENT_CONSENT_ITEMS
      // ★ กรองตามลำดับของ PATIENT_CONSENT_ITEMS ไม่ใช่ลำดับใน CONSENTS_BY_SOURCE
      //   ลำดับที่ผู้ใช้เห็นต้องคงที่: ข้อบังคับก่อน ข้อไม่บังคับท้ายสุด
      .filter((item) => !wanted || wanted.includes(item.type))
      .map<ConsentItem>((item) => ({
        type: item.type,
        labelTh: item.labelTh,
        labelEn: item.labelEn,
        descriptionTh: item.descriptionTh,
        descriptionEn: item.descriptionEn,
        // required ของ "ข้อความ" กับของ "นโยบาย" ต้องตรงกัน — อ่านจาก REQUIRED_CONSENTS
        // ที่เดียว เพื่อไม่ให้ข้อความว่าไม่บังคับแต่ BE ปฏิเสธเพราะบังคับ
        required: REQUIRED_CONSENTS.includes(item.type),
        sensitive: item.sensitive,
      }));

    return {
      version: POLICY_VERSION,
      effectiveDate: POLICY_EFFECTIVE_DATE,
      items,
      screen: source ? SCREEN_COPY_BY_SOURCE[source] : undefined,
      rightsNoteTh: DATA_SUBJECT_RIGHTS_NOTE.th,
      rightsNoteEn: DATA_SUBJECT_RIGHTS_NOTE.en,
      privacyNoticeTh: this.privacyNoticeTh,
      privacyNoticeEn: this.privacyNoticeEn,
      termsOfServiceTh: this.termsOfServiceTh,
      termsOfServiceEn: this.termsOfServiceEn,
    };
  }
}
