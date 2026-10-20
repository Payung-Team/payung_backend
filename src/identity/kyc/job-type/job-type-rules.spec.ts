/**
 * ตัวตรวจกลางประเภทงาน — ตาราง 3 วิชาชีพ x 5 ประเภทงาน x 5 สถานะใบประกอบฯ (PYG-592 · PYG-590)
 */
import {
  JOB_TYPES,
  LicenseSnapshot,
  evaluateJobType,
} from './job-type-rules';

const NOW = new Date('2026-10-18T03:00:00Z');
const FUTURE = new Date('2027-12-31T16:59:59.999Z');
const PAST = new Date('2026-10-01T16:59:59.999Z');
const UPLOADED = new Date('2026-09-01T00:00:00Z');

type LicenseState = 'none' | 'pending' | 'approved' | 'rejected' | 'expired';

/** สถานะใบประกอบฯ -> ใบที่ DB มี */
function licensesFor(state: LicenseState): LicenseSnapshot[] {
  switch (state) {
    case 'none':
      return [];
    case 'pending':
      return [{ reviewStatus: 'pending', expiresAt: FUTURE, uploadedAt: UPLOADED }];
    case 'approved':
      return [{ reviewStatus: 'approved', expiresAt: FUTURE, uploadedAt: UPLOADED }];
    case 'rejected':
      return [{ reviewStatus: 'rejected', expiresAt: FUTURE, uploadedAt: UPLOADED }];
    case 'expired':
      return [{ reviewStatus: 'expired', expiresAt: PAST, uploadedAt: UPLOADED }];
  }
}

const PROFESSIONS = ['general_caregiver', 'nurse', 'physiotherapist'] as const;
const STATES: LicenseState[] = ['none', 'pending', 'approved', 'rejected', 'expired'];

describe('evaluateJobType — ตารางครบทุกช่อง', () => {
  const cases: Array<[string, string, LicenseState, boolean, string | null]> = [];
  for (const profession of PROFESSIONS) {
    for (const jobType of JOB_TYPES) {
      for (const state of STATES) {
        let selectable = true;
        let reason: string | null = null;
        if (jobType === 'physiotherapy') {
          if (profession !== 'physiotherapist') {
            selectable = false;
            reason = 'PROFESSION_MISMATCH';
          } else if (state === 'approved') {
            selectable = true;
          } else {
            selectable = false;
            reason = state === 'expired' ? 'LICENSE_EXPIRED' : 'LICENSE_NOT_APPROVED';
          }
        }
        cases.push([profession, jobType, state, selectable, reason]);
      }
    }
  }

  it('ครอบคลุม 3 x 5 x 5 = 75 ช่อง', () => expect(cases).toHaveLength(75));

  it.each(cases)('%s / %s / ใบ:%s -> selectable=%s reason=%s', (profession, jobType, state, selectable, reason) => {
    const r = evaluateJobType(jobType, profession, licensesFor(state), NOW);
    expect(r).toEqual({ jobType, selectable, blockedReason: reason });
  });

  it('medication ผ่านทุกช่องของตาราง (ทุกวิชาชีพ ทุกสถานะใบ)', () => {
    for (const profession of PROFESSIONS) {
      for (const state of STATES) {
        const r = evaluateJobType('medication', profession, licensesFor(state), NOW);
        expect(r.selectable).toBe(true);
        expect(r.blockedReason).toBeNull();
      }
    }
  });

  it('ประเภทที่ไม่ผูกวิชาชีพ (general_care, bedridden_care, companion) ผ่านทุกช่อง', () => {
    for (const jobType of ['general_care', 'bedridden_care', 'companion']) {
      for (const profession of PROFESSIONS) {
        for (const state of STATES) {
          expect(evaluateJobType(jobType, profession, licensesFor(state), NOW).selectable).toBe(true);
        }
      }
    }
  });
});

describe('evaluateJobType — เวลาและลำดับเหตุผล', () => {
  it('ใบ approved แต่ expires_at ถึงแล้ว (งานรายวันยังไม่รัน) -> LICENSE_EXPIRED', () => {
    const r = evaluateJobType(
      'physiotherapy',
      'physiotherapist',
      [{ reviewStatus: 'approved', expiresAt: PAST, uploadedAt: UPLOADED }],
      NOW,
    );
    expect(r).toMatchObject({ selectable: false, blockedReason: 'LICENSE_EXPIRED' });
  });

  it('เทียบเวลาตอนตรวจ: expires_at = ตอนนี้พอดี ถือว่าหมดอายุ · เลยไป 1 ms ยังใช้ได้', () => {
    const at = (expiresAt: Date) =>
      evaluateJobType('physiotherapy', 'physiotherapist', [{ reviewStatus: 'approved', expiresAt, uploadedAt: UPLOADED }], NOW);
    expect(at(new Date(NOW.getTime())).blockedReason).toBe('LICENSE_EXPIRED');
    expect(at(new Date(NOW.getTime() + 1)).selectable).toBe(true);
  });

  it('วิชาชีพไม่ตรงมาก่อนเสมอ แม้ใบหมดอายุหรือไม่มี', () => {
    expect(evaluateJobType('physiotherapy', 'nurse', licensesFor('expired'), NOW).blockedReason).toBe(
      'PROFESSION_MISMATCH',
    );
    expect(evaluateJobType('physiotherapy', 'general_caregiver', licensesFor('none'), NOW).blockedReason).toBe(
      'PROFESSION_MISMATCH',
    );
  });

  it('วิชาชีพไม่ตรงต่อให้มีใบ approved ก็ยังไม่ผ่าน (E6: พยาบาลเลือก physiotherapy)', () => {
    const r = evaluateJobType('physiotherapy', 'nurse', licensesFor('approved'), NOW);
    expect(r).toMatchObject({ selectable: false, blockedReason: 'PROFESSION_MISMATCH' });
  });

  it('มีใบที่ใช้ได้อย่างน้อยหนึ่งใบ = ผ่าน แม้มีใบเก่าที่หมดอายุ/ถูกปฏิเสธปนอยู่', () => {
    const r = evaluateJobType(
      'physiotherapy',
      'physiotherapist',
      [
        { reviewStatus: 'expired', expiresAt: PAST, uploadedAt: new Date('2025-01-01') },
        { reviewStatus: 'rejected', expiresAt: FUTURE, uploadedAt: new Date('2026-01-01') },
        { reviewStatus: 'approved', expiresAt: FUTURE, uploadedAt: new Date('2026-06-01') },
      ],
      NOW,
    );
    expect(r.selectable).toBe(true);
  });

  it('ไม่มีใบที่ใช้ได้: ใบล่าสุดตัดสินเหตุผล — ใบใหม่รอตรวจหลังใบเก่าหมดอายุ = NOT_APPROVED', () => {
    const r = evaluateJobType(
      'physiotherapy',
      'physiotherapist',
      [
        { reviewStatus: 'expired', expiresAt: PAST, uploadedAt: new Date('2026-01-01') },
        { reviewStatus: 'pending', expiresAt: FUTURE, uploadedAt: new Date('2026-10-10') },
      ],
      NOW,
    );
    expect(r.blockedReason).toBe('LICENSE_NOT_APPROVED');
  });

  it('review_status = null (ไม่เคยถูกตั้งสถานะ) ไม่นับว่าอนุมัติ', () => {
    const r = evaluateJobType(
      'physiotherapy',
      'physiotherapist',
      [{ reviewStatus: null, expiresAt: FUTURE, uploadedAt: UPLOADED }],
      NOW,
    );
    expect(r.blockedReason).toBe('LICENSE_NOT_APPROVED');
  });
});
