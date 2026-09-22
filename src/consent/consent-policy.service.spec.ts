/**
 * PYG-472 — เทสของข้อความ PDPA consent
 *
 * ธีมที่คุม (ทุกข้อเป็นเรื่องที่ผิดแล้วไม่มี error ให้เห็น):
 *   - ข้อมูลอ่อนไหว ม.26 ต้องถูกทำเครื่องหมาย sensitive เพื่อให้ FE แยกกล่อง/ห้ามติ๊กล่วงหน้า
 *   - MARKETING ต้องไม่บังคับ (PDPA ห้ามผูกเรื่องที่ไม่จำเป็นเป็นเงื่อนไขของการใช้บริการ)
 *   - required ในข้อความต้องตรงกับ REQUIRED_CONSENTS ที่ BE ใช้ตรวจจริง
 *   - แต่ละจุดขอเฉพาะข้อที่ควรขอ · Onboarding ต้องมีข้อสุขภาพ
 *   - ทุกข้อมีข้อความครบทั้งไทยและอังกฤษ
 *   - version ที่ส่งให้ FE ต้องเป็นตัวเดียวกับที่จะบันทึกลง user_consents
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConsentPolicyService } from './consent-policy.service';
import {
  CONSENT_SOURCE,
  CONSENT_TYPE,
  type ConsentType,
  POLICY_EFFECTIVE_DATE,
  POLICY_VERSION,
  REQUIRED_CONSENTS,
} from './consent.constants';

describe('ConsentPolicyService (PYG-472)', () => {
  let service: ConsentPolicyService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ConsentPolicyService],
    }).compile();

    service = module.get(ConsentPolicyService);
    // onModuleInit ไม่ถูกเรียกเองใน unit test — เรียกเพื่อโหลดไฟล์ประกาศ
    service.onModuleInit();
  });

  // ── ข้อมูลอ่อนไหว ม.26 ────────────────────────────────────────────────
  it('★ ข้อมูลสุขภาพและการเปิดเผยข้อมูล ต้องถูกทำเครื่องหมาย sensitive', () => {
    const items = service.getPolicy().items;
    const bySensitivity = (type: string) =>
      items.find((i) => i.type === type)?.sensitive;

    // ★ ถ้าพลาดเป็น false → FE จะรวมไว้กับ checkbox ทั่วไปและอาจติ๊กมาให้ล่วงหน้า
    //   ซึ่งทำให้ความยินยอมข้อมูลอ่อนไหวไม่ชอบด้วย ม.26 ทั้งที่ระบบดูเหมือนทำงานปกติ
    expect(bySensitivity(CONSENT_TYPE.SENSITIVE_HEALTH_DATA)).toBe(true);
    expect(bySensitivity(CONSENT_TYPE.DISCLOSE_TO_CAREGIVER)).toBe(true);
    expect(bySensitivity(CONSENT_TYPE.DISCLOSE_TO_FAMILY_GROUP)).toBe(true);
  });

  it('ข้อทั่วไปต้องไม่ถูกทำเครื่องหมาย sensitive', () => {
    const items = service.getPolicy().items;
    expect(items.find((i) => i.type === CONSENT_TYPE.TERMS_OF_SERVICE)?.sensitive).toBe(false);
    expect(items.find((i) => i.type === CONSENT_TYPE.PRIVACY_POLICY)?.sensitive).toBe(false);
    expect(items.find((i) => i.type === CONSENT_TYPE.MARKETING)?.sensitive).toBe(false);
  });

  // ── บังคับ / ไม่บังคับ ────────────────────────────────────────────────
  it('★ MARKETING ต้องไม่บังคับ — PDPA ห้ามผูกเป็นเงื่อนไขของการใช้บริการ', () => {
    const marketing = service
      .getPolicy()
      .items.find((i) => i.type === CONSENT_TYPE.MARKETING);

    expect(marketing?.required).toBe(false);
    expect(REQUIRED_CONSENTS).not.toContain(CONSENT_TYPE.MARKETING);
  });

  it('★ required ของทุกข้อต้องตรงกับ REQUIRED_CONSENTS ที่ BE ใช้ตรวจจริง', () => {
    // ★ ถ้าสองฝั่งไม่ตรง ผู้ใช้จะเห็นว่า "ไม่บังคับ" แล้วข้าม แต่ BE ปฏิเสธ
    //   (หรือกลับกัน — เห็นว่าบังคับทั้งที่ BE ปล่อยผ่าน ซึ่งเก็บความยินยอมเกินจำเป็น)
    for (const item of service.getPolicy().items) {
      // entity ประกาศ type เป็น string (GraphQL ไม่มี enum ตัวนี้) — แคสต์กลับเพื่อเทียบ
      const isRequired = REQUIRED_CONSENTS.includes(item.type as ConsentType);
      expect(item.required).toBe(isRequired);
    }
  });

  // ── แต่ละจุดขออะไร ────────────────────────────────────────────────────
  it('หน้าสมัคร: ขอข้อกำหนด + ความเป็นส่วนตัว + การตลาด และยังไม่ขอข้อมูลสุขภาพ', () => {
    const types = service
      .getPolicy(CONSENT_SOURCE.REGISTER)
      .items.map((i) => i.type);

    expect(types).toEqual([
      CONSENT_TYPE.TERMS_OF_SERVICE,
      CONSENT_TYPE.PRIVACY_POLICY,
      CONSENT_TYPE.MARKETING,
    ]);
    // ★ ยังไม่เก็บข้อมูลสุขภาพ ณ จุดนี้ จึงยังไม่ต้องขอ — ขอเกินจำเป็นผิดหลัก PDPA
    expect(types).not.toContain(CONSENT_TYPE.SENSITIVE_HEALTH_DATA);
  });

  it('★ หน้า Onboarding: ขอความยินยอมข้อมูลสุขภาพแยกข้อเดียว', () => {
    const items = service.getPolicy(CONSENT_SOURCE.ONBOARDING).items;

    expect(items).toHaveLength(1);
    expect(items[0].type).toBe(CONSENT_TYPE.SENSITIVE_HEALTH_DATA);
    expect(items[0].sensitive).toBe(true);
    expect(items[0].required).toBe(true);
  });

  it('หน้าจอง: ขอความยินยอมเปิดเผยข้อมูลให้ผู้ดูแล', () => {
    const items = service.getPolicy(CONSENT_SOURCE.BOOKING).items;
    expect(items.map((i) => i.type)).toEqual([CONSENT_TYPE.DISCLOSE_TO_CAREGIVER]);
  });

  it('ไม่ระบุ source → คืนทุกข้อ (หน้าตั้งค่าความเป็นส่วนตัว)', () => {
    const all = service.getPolicy().items;
    expect(all.length).toBeGreaterThanOrEqual(6);
    expect(all.map((i) => i.type)).toContain(CONSENT_TYPE.SENSITIVE_HEALTH_DATA);
  });

  it('ลำดับที่ผู้ใช้เห็นคงที่เสมอ — ข้อไม่บังคับอยู่ท้ายสุด', () => {
    const items = service.getPolicy().items;
    const lastRequiredIndex = items.map((i) => i.required).lastIndexOf(true);
    const firstOptionalIndex = items.map((i) => i.required).indexOf(false);
    expect(firstOptionalIndex).toBeGreaterThan(lastRequiredIndex);
  });

  // ── ความครบของข้อความ ─────────────────────────────────────────────────
  it('ทุกข้อมีข้อความครบทั้งไทยและอังกฤษ', () => {
    for (const item of service.getPolicy().items) {
      expect(item.labelTh.trim().length).toBeGreaterThan(0);
      expect(item.labelEn.trim().length).toBeGreaterThan(0);
      expect(item.descriptionTh.trim().length).toBeGreaterThan(0);
      expect(item.descriptionEn.trim().length).toBeGreaterThan(0);
    }
  });

  it('ประกาศความเป็นส่วนตัวฉบับเต็มถูกอ่านเข้ามาได้ทั้งสองภาษา', () => {
    const policy = service.getPolicy();
    expect(policy.privacyNoticeTh).toContain('ประกาศความเป็นส่วนตัว');
    expect(policy.privacyNoticeEn).toContain('Privacy Notice');
    // ★ ระยะเวลาเก็บต้องอยู่ในประกาศจริง ไม่ใช่แค่ในโค้ด — เป็นข้อที่กฎหมายบังคับให้แจ้ง
    expect(policy.privacyNoticeTh).toContain('2 ปี');
    expect(policy.privacyNoticeEn).toContain('2 years');
  });

  it('ข้อความสิทธิ์เจ้าของข้อมูลมีช่องทางติดต่อ', () => {
    const policy = service.getPolicy();
    expect(policy.rightsNoteTh).toContain('privacy@payung.app');
    expect(policy.rightsNoteEn).toContain('privacy@payung.app');
  });

  // ── เวอร์ชัน ──────────────────────────────────────────────────────────
  it('★ version ที่ส่งให้ FE ต้องเป็นตัวเดียวกับที่บันทึกลง user_consents', () => {
    const policy = service.getPolicy(CONSENT_SOURCE.ONBOARDING);
    expect(policy.version).toBe(POLICY_VERSION);
    expect(policy.effectiveDate).toBe(POLICY_EFFECTIVE_DATE);
  });

  it('หัวข้อ/คำนำมีให้เฉพาะจุดที่เตรียมไว้ จุดอื่นเป็น undefined', () => {
    expect(service.getPolicy(CONSENT_SOURCE.ONBOARDING).screen?.titleTh).toBeTruthy();
    expect(service.getPolicy(CONSENT_SOURCE.SETTINGS).screen).toBeUndefined();
    expect(service.getPolicy().screen).toBeUndefined();
  });
});
