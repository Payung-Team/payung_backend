/**
 * PDPA consent — ค่าคงที่และเวอร์ชันนโยบาย (PYG-472)
 *
 * ★ ที่เดียวของทั้งระบบ: ค่า `consent_type` และ `policy_version` ถูกเขียนลง `user_consents`
 *   (PYG-473) แบบ append-only — แก้แถวเดิมไม่ได้ (trigger บล็อก UPDATE ไว้)
 *   ถ้า FE ส่งค่าที่สะกดต่างจาก BE แม้ตัวเดียว ประวัติความยินยอมจะแตกเป็นสองชุดถาวร
 *   และเวลาตรวจว่า "คนนี้ยินยอมหรือยัง" จะตอบผิดโดยไม่มี error ให้เห็น
 *   → FE ต้องดึงรายการจาก query `consentPolicy` ไม่ใช่ hardcode ฝั่งตัวเอง
 *
 * ขอบเขตรอบนี้ (PYG-472): **ผู้รับบริการ (role 1)** เท่านั้น
 *   ข้อความของผู้ดูแล (KYC, รูปใบหน้า, บัญชีรับเงิน) เป็นการ์ดถัดไป — ดู CAREGIVER_ONLY ด้านล่าง
 */

/**
 * เวอร์ชันนโยบายที่บังคับใช้อยู่
 *
 * ★ กฎการเปลี่ยนเวอร์ชัน: **ขึ้นเวอร์ชันเมื่อสาระเปลี่ยน** เท่านั้น
 *   (เพิ่ม/ลดวัตถุประสงค์การเก็บ, เปลี่ยนผู้รับข้อมูล, เปลี่ยนระยะเวลาเก็บ, เปลี่ยนสิทธิ์)
 *   แก้คำผิดหรือจัดหน้าใหม่ **ห้ามขึ้นเวอร์ชัน** — ไม่งั้นผู้ใช้ทุกคนจะโดนขอ consent ใหม่
 *   ทั้งที่ไม่มีอะไรเปลี่ยนจริง ซึ่งทำให้คนกดผ่าน ๆ จนความยินยอมไม่มีความหมาย
 *
 * ★ เทียบด้วย `!==` ไม่ใช่เทียบมากกว่า/น้อยกว่า — ระบบสนใจแค่ "ตรงเวอร์ชันปัจจุบันไหม"
 *   ถ้าไม่ตรง = ต้องขอใหม่ (re-consent, PYG-504)
 */
export const POLICY_VERSION = '1.0';

/** วันที่นโยบายเวอร์ชันนี้เริ่มใช้ — โชว์ท้ายประกาศความเป็นส่วนตัว */
export const POLICY_EFFECTIVE_DATE = '2026-09-22';

/**
 * ประเภทความยินยอม — ค่าที่เขียนลง `user_consents.consent_type`
 *
 * ★ ห้ามเปลี่ยนสตริงที่ปล่อยไปแล้ว — แถวเก่าใน user_consents จะกำพร้าทันที
 *   และตารางแก้ย้อนหลังไม่ได้ (append-only) ถ้าต้องเปลี่ยนความหมาย ให้เพิ่มค่าใหม่
 */
export const CONSENT_TYPE = {
  /** ข้อกำหนดการใช้บริการ — บังคับ ตอนสมัคร */
  TERMS_OF_SERVICE: 'terms_of_service',
  /** เก็บและใช้ข้อมูลส่วนบุคคลทั่วไปตามประกาศความเป็นส่วนตัว — บังคับ ตอนสมัคร */
  PRIVACY_POLICY: 'privacy_policy',
  /**
   * ข้อมูลสุขภาพ — **ข้อมูลอ่อนไหวตาม ม.26** ต้องขอความยินยอมโดยชัดแจ้งและ**แยกจากข้ออื่น**
   * ขอตอน Onboarding ซึ่งเป็นจุดที่เริ่มเก็บจริง (อายุ เพศ ระดับการช่วยเหลือ โรคประจำตัว ยา การแพ้)
   */
  SENSITIVE_HEALTH_DATA: 'sensitive_health_data',
  /**
   * เปิดเผยข้อมูลสุขภาพให้ผู้ดูแลที่รับงาน — ขอตอนจองครั้งแรก
   * แยกจาก SENSITIVE_HEALTH_DATA เพราะ "ยอมให้เก็บ" กับ "ยอมให้เปิดเผยแก่บุคคลที่สาม"
   * เป็นคนละเรื่องตามกฎหมาย ผู้ใช้อาจยอมอย่างแรกแต่ไม่ยอมอย่างหลัง
   */
  DISCLOSE_TO_CAREGIVER: 'disclose_to_caregiver',
  /** เปิดเผยให้สมาชิกกลุ่มครอบครัว — ขอตอนเข้าร่วม/สร้างกลุ่ม */
  DISCLOSE_TO_FAMILY_GROUP: 'disclose_to_family_group',
  /** ข่าวสารและโปรโมชัน — ไม่บังคับ ปฏิเสธได้โดยยังใช้บริการได้ครบ */
  MARKETING: 'marketing',

  /**
   * ภาพใบหน้าเพื่อยืนยันตัวตน — ข้อมูลชีวภาพตาม ม.26 · **ของผู้ดูแลเท่านั้น**
   * ยังไม่มีข้อความในรอบนี้ (ขอบเขต PYG-472 = ผู้รับบริการ) แต่ประกาศค่าไว้ก่อน
   * เพื่อให้ TODO ใน profile-photo.service.ts มีชื่อที่อ้างถึงได้และสะกดตรงกันตั้งแต่ต้น
   */
  SENSITIVE_BIOMETRIC: 'sensitive_biometric',
} as const;

export type ConsentType = (typeof CONSENT_TYPE)[keyof typeof CONSENT_TYPE];

/** จุดในแอปที่ขอความยินยอม — เขียนลง `user_consents.source` */
export const CONSENT_SOURCE = {
  REGISTER: 'register',
  ONBOARDING: 'onboarding',
  BOOKING: 'booking',
  FAMILY_GROUP: 'family_group',
  SETTINGS: 'settings',
  RE_CONSENT: 're_consent',
} as const;

export type ConsentSource = (typeof CONSENT_SOURCE)[keyof typeof CONSENT_SOURCE];

/**
 * ความยินยอมที่ "ไม่ยอมแล้วใช้บริการไม่ได้"
 *
 * ★ ตัวที่ไม่อยู่ในลิสต์นี้ = ปฏิเสธได้ และระบบต้องทำงานต่อได้ตามปกติ
 *   PDPA ห้ามบังคับให้ยินยอมเรื่องที่ไม่จำเป็นต่อการให้บริการเป็นเงื่อนไขของการใช้บริการ
 *   (MARKETING จึงห้ามอยู่ในลิสต์นี้เด็ดขาด)
 *
 * ★ SENSITIVE_HEALTH_DATA อยู่ในลิสต์นี้เพราะ "จองผู้ดูแล" ทำไม่ได้เลยถ้าไม่มีข้อมูลสุขภาพ
 *   แต่บังคับ ณ จุด Onboarding เท่านั้น — สมัครบัญชีไว้เฉย ๆ โดยไม่ยินยอมข้อนี้ยังทำได้
 */
export const REQUIRED_CONSENTS: readonly ConsentType[] = [
  CONSENT_TYPE.TERMS_OF_SERVICE,
  CONSENT_TYPE.PRIVACY_POLICY,
  CONSENT_TYPE.SENSITIVE_HEALTH_DATA,
  CONSENT_TYPE.DISCLOSE_TO_CAREGIVER,
];

/** ความยินยอมที่ต้องขอ ณ จุดนั้น ๆ — FE ใช้ตัดสินว่าหน้าไหนโชว์อะไร */
export const CONSENTS_BY_SOURCE: Record<ConsentSource, readonly ConsentType[]> = {
  [CONSENT_SOURCE.REGISTER]: [
    CONSENT_TYPE.TERMS_OF_SERVICE,
    CONSENT_TYPE.PRIVACY_POLICY,
    CONSENT_TYPE.MARKETING,
  ],
  [CONSENT_SOURCE.ONBOARDING]: [CONSENT_TYPE.SENSITIVE_HEALTH_DATA],
  [CONSENT_SOURCE.BOOKING]: [CONSENT_TYPE.DISCLOSE_TO_CAREGIVER],
  [CONSENT_SOURCE.FAMILY_GROUP]: [CONSENT_TYPE.DISCLOSE_TO_FAMILY_GROUP],
  [CONSENT_SOURCE.SETTINGS]: [CONSENT_TYPE.MARKETING],
  // re-consent โชว์เฉพาะตัวที่บังคับและเวอร์ชันไม่ตรง — คำนวณตอนรันไทม์ (PYG-504)
  [CONSENT_SOURCE.RE_CONSENT]: [],
};

/** ระยะเวลาเก็บข้อมูลหลังปิดบัญชี (ปี) — อ้างในประกาศความเป็นส่วนตัว */
export const DATA_RETENTION_YEARS = {
  /** เอกสารที่กฎหมายบัญชี/ภาษีบังคับให้เก็บ */
  FINANCIAL_RECORDS: 5,
  /** ข้อมูลสุขภาพและประวัติการดูแล */
  HEALTH_RECORDS: 2,
  /** บันทึกความยินยอม — ต้องพิสูจน์ได้ว่าเคยยินยอมจริง จึงเก็บนานกว่าตัวข้อมูล */
  CONSENT_RECORDS: 5,
} as const;

/** ช่องทางติดต่อผู้ควบคุมข้อมูล — ปรากฏในประกาศความเป็นส่วนตัวและแบบฟอร์มใช้สิทธิ์ */
export const DATA_CONTROLLER = {
  nameTh: 'ทีมงาน Payung',
  nameEn: 'Payung Team',
  email: 'privacy@payung.app',
} as const;
