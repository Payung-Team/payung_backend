/**
 * PYG-581 — ค่าระดับผู้ดูแลและด่านตรวจค่าขาเข้า (contract PYG-579 §2, §5)
 *
 * ตรึงว่า:
 *   1. ค่าที่ client ส่ง = ชื่อ enum ใน GraphQL ตัวพิมพ์ใหญ่ตรงตัว ("BASIC") ↔ ค่าใน DB ('basic')
 *   2. ค่าว่าง → CARE_LEVEL_REQUIRED · ค่านอกรายการ → CARE_LEVEL_INVALID (E9) — code ไปถึง FE ใน extensions
 *   3. เหตุผลว่าง → CARE_LEVEL_REASON_REQUIRED
 */
import {
  CARE_LEVELS,
  CARE_LEVEL_INPUT_VALUES,
  CareLevel,
  careLevelFromDb,
  careLevelFromInput,
} from './care-level';
import {
  CARE_LEVEL_ERROR,
  CareLevelError,
  careLevelKycNotVerifiedError,
  careLevelRequiredError,
  parseCareLevelInput,
  parseCareLevelReason,
  parseOptionalCareLevelInput,
} from './care-level.errors';

/** เรียกฟังก์ชันที่ควร throw แล้วคืน error ออกมาให้ตรวจ extensions ต่อได้ */
function catchError(fn: () => unknown): CareLevelError {
  try {
    fn();
  } catch (err) {
    return err as CareLevelError;
  }
  throw new Error('expected function to throw');
}

describe('CareLevel — ค่าและการแปลง (PYG-581)', () => {
  it('ค่าใน TS enum ตรงกับ CHECK ของ DB และเรียงจากต่ำไปสูง (R1)', () => {
    expect(CARE_LEVELS).toEqual(['basic', 'intermediate', 'advanced']);
  });

  it('ค่าที่ client ส่งได้คือชื่อ enum ใน GraphQL', () => {
    expect(CARE_LEVEL_INPUT_VALUES).toEqual([
      'BASIC',
      'INTERMEDIATE',
      'ADVANCED',
    ]);
  });

  it.each([
    ['BASIC', CareLevel.BASIC],
    ['INTERMEDIATE', CareLevel.INTERMEDIATE],
    ['ADVANCED', CareLevel.ADVANCED],
  ])('careLevelFromInput(%s) → %s', (input, expected) => {
    expect(careLevelFromInput(input)).toBe(expected);
  });

  it.each(['basic', 'Basic', ' BASIC', 'EXPERT', 'toString', '__proto__', ''])(
    'careLevelFromInput(%p) → null (ไม่ trim / ไม่แปลงตัวพิมพ์ / ไม่หลงไปเจอ property ของ Object)',
    (input) => {
      expect(careLevelFromInput(input)).toBeNull();
    },
  );

  it('careLevelFromDb: ค่าใน DB → CareLevel · null/ค่าแปลก → null', () => {
    expect(careLevelFromDb('intermediate')).toBe(CareLevel.INTERMEDIATE);
    expect(careLevelFromDb(null)).toBeNull();
    expect(careLevelFromDb(undefined)).toBeNull();
    expect(careLevelFromDb('INTERMEDIATE')).toBeNull();
  });
});

describe('parseOptionalCareLevelInput — ขาเข้าของ approveKyc', () => {
  it.each([undefined, null, '', '   '])(
    '%p → null (= ไม่ได้เลือก)',
    (input) => {
      expect(parseOptionalCareLevelInput(input)).toBeNull();
    },
  );

  it('ค่าถูก → CareLevel', () => {
    expect(parseOptionalCareLevelInput('ADVANCED')).toBe(CareLevel.ADVANCED);
  });

  it('E9: ค่านอกรายการ → CARE_LEVEL_INVALID พร้อม allowed + received', () => {
    const err = catchError(() => parseOptionalCareLevelInput('EXPERT'));

    expect(err).toBeInstanceOf(CareLevelError);
    expect(err.extensions).toEqual({
      code: CARE_LEVEL_ERROR.INVALID,
      allowed: ['BASIC', 'INTERMEDIATE', 'ADVANCED'],
      received: 'EXPERT',
    });
  });

  it('E9: ค่าใน DB ตัวพิมพ์เล็ก ("basic") ส่งเข้ามาไม่ได้ — client ต้องใช้ชื่อ enum', () => {
    expect(
      catchError(() => parseOptionalCareLevelInput('basic')).extensions.code,
    ).toBe(CARE_LEVEL_ERROR.INVALID);
  });
});

describe('parseCareLevelInput — ขาเข้าของ setCaregiverCareLevel', () => {
  it.each([undefined, null, '', '  '])('%p → CARE_LEVEL_REQUIRED', (input) => {
    const err = catchError(() => parseCareLevelInput(input));
    expect(err.extensions).toEqual({
      code: CARE_LEVEL_ERROR.REQUIRED,
      allowed: ['BASIC', 'INTERMEDIATE', 'ADVANCED'],
    });
  });

  it('ค่านอกรายการ → CARE_LEVEL_INVALID', () => {
    expect(
      catchError(() => parseCareLevelInput('SENIOR')).extensions.code,
    ).toBe(CARE_LEVEL_ERROR.INVALID);
  });

  it('ค่าถูก → CareLevel', () => {
    expect(parseCareLevelInput('BASIC')).toBe(CareLevel.BASIC);
  });
});

describe('parseCareLevelReason', () => {
  it.each([undefined, null, '', '   '])(
    '%p → CARE_LEVEL_REASON_REQUIRED',
    (input) => {
      expect(catchError(() => parseCareLevelReason(input)).extensions).toEqual({
        code: CARE_LEVEL_ERROR.REASON_REQUIRED,
      });
    },
  );

  it('trim ช่องว่างหัวท้ายก่อนบันทึก', () => {
    expect(parseCareLevelReason('  ผ่านอบรมเพิ่ม  ')).toBe('ผ่านอบรมเพิ่ม');
  });
});

describe('error factory', () => {
  it('careLevelRequiredError มี code + allowed', () => {
    expect(careLevelRequiredError().extensions).toEqual({
      code: CARE_LEVEL_ERROR.REQUIRED,
      allowed: ['BASIC', 'INTERMEDIATE', 'ADVANCED'],
    });
  });

  it('careLevelKycNotVerifiedError บอก kycStatus ปัจจุบัน', () => {
    expect(careLevelKycNotVerifiedError('pending').extensions).toEqual({
      code: CARE_LEVEL_ERROR.KYC_NOT_VERIFIED,
      kycStatus: 'pending',
    });
  });
});
