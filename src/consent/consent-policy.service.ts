/**
 * ConsentPolicyService — ประกอบนโยบายความยินยอมที่บังคับใช้อยู่ (PYG-472)
 *
 * อ่านอย่างเดียว ไม่แตะ DB — บันทึกคำตอบเป็นงานของ PYG-474
 *
 * ★ ประกาศความเป็นส่วนตัวอ่านจากไฟล์ .md ตอน bootstrap ครั้งเดียว แล้วถือไว้ในหน่วยความจำ
 *   ถ้าอ่านทุกคำขอ จะมี disk I/O ต่อทุกครั้งที่มีคนเปิดหน้าสมัคร ทั้งที่ไฟล์ไม่เคยเปลี่ยน
 *   ระหว่างรัน (เปลี่ยนเมื่อ deploy เท่านั้น)
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
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

/** จุดที่มีหัวข้อ/คำนำเตรียมไว้ — จุดอื่นคืน screen = null ให้ FE ใช้ข้อความของตัวเอง */
const SCREEN_COPY_BY_SOURCE: Partial<Record<ConsentSource, ConsentScreenCopy>> = {
  [CONSENT_SOURCE.REGISTER]: CONSENT_SCREEN_COPY.register,
  [CONSENT_SOURCE.ONBOARDING]: CONSENT_SCREEN_COPY.onboarding,
  [CONSENT_SOURCE.BOOKING]: CONSENT_SCREEN_COPY.booking,
};

@Injectable()
export class ConsentPolicyService implements OnModuleInit {
  private readonly logger = new Logger(ConsentPolicyService.name);
  private privacyNoticeTh = '';
  private privacyNoticeEn = '';

  onModuleInit(): void {
    this.privacyNoticeTh = this.readNotice('privacy-notice.th.md');
    this.privacyNoticeEn = this.readNotice('privacy-notice.en.md');
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
    };
  }

  /**
   * อ่านไฟล์ประกาศ — ล้มแล้วคืนสตริงว่างแทนการ throw
   *
   * ★ ตั้งใจไม่ทำให้แอปไม่ขึ้น: ไฟล์หายเป็นปัญหา deploy ไม่ใช่ปัญหาข้อมูล
   *   ถ้า throw ระบบทั้งระบบล่มรวมถึงการจองและการชำระเงินที่ไม่เกี่ยวกับ consent เลย
   *   FE เห็นข้อความว่าง = โชว์ลิงก์ไปหน้าเว็บนโยบายแทนได้ และ log ดังพอให้เรารู้
   */
  private readNotice(fileName: string): string {
    try {
      return readFileSync(join(__dirname, fileName), 'utf8');
    } catch (err) {
      this.logger.error({
        event: 'consent.privacy_notice_missing',
        fileName,
        reason: err instanceof Error ? err.message : String(err),
      });
      return '';
    }
  }
}
