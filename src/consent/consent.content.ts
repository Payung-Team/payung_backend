/**
 * ข้อความ PDPA consent (TH/EN) — PYG-472 · ขอบเขตรอบนี้: ผู้รับบริการ (role 1)
 *
 * ★ ข้อความอยู่ฝั่ง BE ที่เดียว แล้วเสิร์ฟให้ FE ผ่าน query `consentPolicy`
 *   ถ้าให้ FE ถือข้อความเอง วันหนึ่งแก้ข้อความฝั่งเดียวแล้วขึ้นเวอร์ชัน ผู้ใช้จะเห็นข้อความหนึ่ง
 *   แต่ระบบบันทึกว่ายินยอมอีกเวอร์ชันหนึ่ง — ซึ่งทำให้ "หลักฐานความยินยอม" ใช้ไม่ได้ตามกฎหมาย
 *
 * ★ เขียนภาษาไทยให้ผู้สูงอายุอ่านเข้าใจ: ประโยคสั้น ไม่ใช้ศัพท์กฎหมายถ้าเลี่ยงได้
 *   ("ข้อมูลสุขภาพ" ไม่ใช่ "ข้อมูลส่วนบุคคลอ่อนไหวตามมาตรา 26")
 *   ตัวบทกฎหมายอยู่ในประกาศความเป็นส่วนตัวฉบับเต็มแทน
 *
 * ⚠ ข้อความชุดนี้ดัดแปลงจากแม่แบบ PDPA Thailand Starter Kit ให้ตรงกับข้อมูลที่ Payung เก็บจริง
 *   **ยังไม่ผ่านการตรวจโดยผู้มีอำนาจทางกฎหมาย** — ต้องให้อาจารย์ที่ปรึกษา/ผู้รับผิดชอบตรวจ
 *   ก่อนเปิดใช้กับผู้ใช้จริง (ดูหมายเหตุใน PR)
 */
import {
  CONSENT_TYPE,
  type ConsentType,
  DATA_RETENTION_YEARS,
  DATA_CONTROLLER,
} from './consent.constants';

export interface ConsentItemContent {
  type: ConsentType;
  /** ข้อความบน checkbox — สั้น อ่านจบในบรรทัดเดียวสองบรรทัด */
  labelTh: string;
  labelEn: string;
  /** คำอธิบายใต้ checkbox — บอกว่าเอาไปทำอะไร ใครเห็นบ้าง */
  descriptionTh: string;
  descriptionEn: string;
  /** true = ไม่ติ๊กแล้วไปต่อไม่ได้ ณ จุดที่ขอ */
  required: boolean;
  /**
   * true = ข้อมูลอ่อนไหวตาม ม.26 — FE ต้องแสดงแยกกล่อง ไม่รวมกับข้ออื่น
   * และห้ามติ๊กมาให้ล่วงหน้า (ต้องเป็นการกระทำโดยชัดแจ้งของผู้ใช้)
   */
  sensitive: boolean;
}

const RETENTION_HEALTH = DATA_RETENTION_YEARS.HEALTH_RECORDS;

/**
 * รายการความยินยอมของผู้รับบริการ
 *
 * ★ ลำดับในอาร์เรย์ = ลำดับที่แสดงบนหน้าจอ · ข้อบังคับขึ้นก่อน ข้อไม่บังคับอยู่ท้าย
 */
export const PATIENT_CONSENT_ITEMS: readonly ConsentItemContent[] = [
  {
    type: CONSENT_TYPE.TERMS_OF_SERVICE,
    labelTh: 'ฉันยอมรับข้อกำหนดการใช้บริการของ Payung',
    labelEn: 'I accept the Payung Terms of Service',
    descriptionTh:
      'Payung เป็นตัวกลางจับคู่ผู้รับบริการกับผู้ดูแล การดูแลเกิดขึ้นระหว่างคุณกับผู้ดูแลโดยตรง',
    descriptionEn:
      'Payung connects you with caregivers. Care is provided directly by the caregiver, not by Payung.',
    required: true,
    sensitive: false,
  },
  {
    type: CONSENT_TYPE.PRIVACY_POLICY,
    labelTh: 'ฉันได้อ่านและยอมรับประกาศความเป็นส่วนตัว',
    labelEn: 'I have read and accept the Privacy Notice',
    descriptionTh:
      'เราเก็บชื่อ อีเมล เบอร์โทร และที่อยู่ เพื่อสร้างบัญชี ติดต่อคุณ และส่งผู้ดูแลไปให้ถูกที่',
    descriptionEn:
      'We collect your name, email, phone number and address to create your account, contact you, and send a caregiver to the right place.',
    required: true,
    sensitive: false,
  },
  {
    type: CONSENT_TYPE.SENSITIVE_HEALTH_DATA,
    labelTh: 'ฉันยินยอมให้ Payung เก็บข้อมูลสุขภาพของผู้รับบริการ',
    labelEn: 'I consent to Payung collecting the care recipient’s health information',
    descriptionTh:
      'ได้แก่ อายุ เพศ ระดับการช่วยเหลือตัวเอง โรคประจำตัว ยาที่ใช้ ประวัติการแพ้ และคำแนะนำการดูแล ' +
      'เราใช้ข้อมูลนี้เพื่อจับคู่ผู้ดูแลที่เหมาะสมและให้ผู้ดูแลดูแลได้อย่างปลอดภัย ' +
      `เก็บไว้ ${RETENTION_HEALTH} ปีหลังปิดบัญชี แล้วลบทิ้ง · ` +
      'ถ้าไม่ยินยอมข้อนี้จะยังใช้บัญชีได้ แต่จะจองผู้ดูแลไม่ได้ · ถอนความยินยอมได้ทุกเมื่อ',
    descriptionEn:
      'This includes age, gender, mobility level, medical conditions, medications, allergies and care notes. ' +
      'We use it to match a suitable caregiver and to let them care for you safely. ' +
      `Kept for ${RETENTION_HEALTH} years after your account closes, then deleted. ` +
      'Without this consent you can keep your account but cannot book a caregiver. You may withdraw it at any time.',
    required: true,
    sensitive: true,
  },
  {
    type: CONSENT_TYPE.DISCLOSE_TO_CAREGIVER,
    labelTh: 'ฉันยินยอมให้เปิดเผยข้อมูลสุขภาพแก่ผู้ดูแลที่รับงาน',
    labelEn: 'I consent to sharing health information with the caregiver who accepts the job',
    descriptionTh:
      'ผู้ดูแลที่รับงานของคุณจะเห็นชื่อ ที่อยู่ที่ให้บริการ และข้อมูลสุขภาพที่กรอกไว้ ' +
      'ผู้ดูแลคนอื่นที่ยังไม่ได้รับงานจะไม่เห็นข้อมูลนี้',
    descriptionEn:
      'The caregiver who accepts your booking will see your name, the service address, and the health information you provided. ' +
      'Other caregivers who have not accepted the job cannot see it.',
    required: true,
    sensitive: true,
  },
  {
    type: CONSENT_TYPE.DISCLOSE_TO_FAMILY_GROUP,
    labelTh: 'ฉันยินยอมให้สมาชิกในกลุ่มครอบครัวเห็นข้อมูลการดูแลของฉัน',
    labelEn: 'I consent to letting my family group members see my care information',
    descriptionTh:
      'สมาชิกในกลุ่มจะเห็นนัดหมาย สถานะงาน และข้อมูลผู้รับบริการของคุณ เพื่อช่วยกันดูแลและจองแทนได้ ' +
      'ไม่ยินยอมก็ยังใช้บัญชีส่วนตัวได้ตามปกติ',
    descriptionEn:
      'Group members will see your bookings, job status and care recipient details so they can help arrange care for you. ' +
      'You can still use your personal account without this consent.',
    required: false,
    sensitive: true,
  },
  {
    type: CONSENT_TYPE.MARKETING,
    labelTh: 'ฉันยินดีรับข่าวสารและโปรโมชันจาก Payung',
    labelEn: 'I would like to receive news and promotions from Payung',
    descriptionTh:
      'ไม่ยินยอมก็ใช้บริการได้ครบทุกอย่าง · ยกเลิกได้ทุกเมื่อในหน้าตั้งค่า',
    descriptionEn:
      'Declining does not limit any part of the service. You can opt out at any time in Settings.',
    required: false,
    sensitive: false,
  },
];

/** หัวข้อ/คำนำของกล่อง consent แต่ละจุด — ให้ FE ไม่ต้องคิดคำเอง */
export const CONSENT_SCREEN_COPY = {
  register: {
    titleTh: 'ก่อนเริ่มใช้งาน',
    titleEn: 'Before you start',
    introTh: 'กรุณาอ่านและยืนยันข้อตกลงด้านล่างก่อนสมัครสมาชิก',
    introEn: 'Please read and confirm the agreements below before signing up.',
  },
  onboarding: {
    titleTh: 'ข้อมูลสุขภาพของผู้รับบริการ',
    titleEn: 'Care recipient health information',
    introTh:
      'ขั้นตอนถัดไปจะขอข้อมูลสุขภาพ ซึ่งเป็นข้อมูลที่กฎหมายคุ้มครองเป็นพิเศษ ' +
      'กรุณาอ่านให้จบก่อนกดยินยอม',
    introEn:
      'The next step asks for health information, which the law protects with extra care. ' +
      'Please read to the end before giving consent.',
  },
  booking: {
    titleTh: 'การเปิดเผยข้อมูลให้ผู้ดูแล',
    titleEn: 'Sharing information with your caregiver',
    introTh: 'เพื่อให้ผู้ดูแลไปถึงและดูแลได้ถูกต้อง เราต้องส่งข้อมูลบางส่วนให้เขา',
    introEn:
      'So the caregiver can reach you and care for you correctly, we need to share some information with them.',
  },
  family_group: {
    titleTh: 'การเปิดเผยข้อมูลให้สมาชิกกลุ่ม',
    titleEn: 'Sharing information with your family group',
    introTh:
      'ถ้ายินยอม สมาชิกในกลุ่มจะจองผู้ดูแลแทนคุณได้ และเห็นข้อมูลที่คุณกรอกไว้เพื่อเติมให้อัตโนมัติ ' +
      'ไม่ยินยอมก็ยังเข้ากลุ่มได้',
    introEn:
      'If you agree, group members can book care on your behalf and see the details you entered so the form fills in for them. ' +
      'You can still join the group without agreeing.',
  },
} as const;

/** ข้อความสิทธิ์ของเจ้าของข้อมูล — แสดงท้ายกล่อง consent ทุกจุด */
export const DATA_SUBJECT_RIGHTS_NOTE = {
  th:
    'คุณมีสิทธิ์ขอดู ขอแก้ไข ขอลบ ขอให้หยุดใช้ และขอถอนความยินยอมได้ทุกเมื่อ ' +
    `ติดต่อ ${DATA_CONTROLLER.email} · การถอนความยินยอมไม่กระทบการใช้ข้อมูลที่เกิดขึ้นก่อนหน้านั้น`,
  en:
    'You have the right to access, correct, delete, restrict the use of your data, and withdraw consent at any time. ' +
    `Contact ${DATA_CONTROLLER.email}. Withdrawal does not affect processing that already happened.`,
} as const;
