import {
  calculateBookingLevel,
  BookingLevelInputs,
  BookingLevelRule,
} from './booking-level.calculate';
import {
  CareLevel,
  CARE_LEVELS,
  compareCareLevels,
  highestCareLevel,
} from '../../common/care-level/care-level';
import { seededBookingLevelRules } from '../../../test/fixtures/booking-level-rules';
const rules = seededBookingLevelRules();
const input = (
  patch: Partial<BookingLevelInputs> = {},
): BookingLevelInputs => ({
  adlTotalScore: 20,
  flags: [],
  hasUnsureFlag: false,
  dementiaSevere: null,
  services: [],
  ...patch,
});
const errorCode = (fn: () => unknown, code: string) => {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ extensions: { code, statusCode: 422 } });
};
const service = (code: string | null, careLevel: string | null) => ({
  code,
  careLevel,
});
describe('S16 pure booking-level calculator', () => {
  it('uses the 12 real seed rows including the approved advanced F03 correction', () => {
    expect(rules).toHaveLength(12);
    expect(
      rules.find((r) => r.source === 'service' && r.code === 'F03')?.level,
    ).toBe('advanced');
    expect(rules.every((r) => r.level !== null)).toBe(true);
  });
  it.each([
    [0, 'advanced'],
    [4, 'advanced'],
    [5, 'intermediate'],
    [11, 'intermediate'],
    [12, 'basic'],
    [20, 'basic'],
  ])('ADL boundary %s gives %s', (score, level) => {
    expect(
      calculateBookingLevel(input({ adlTotalScore: Number(score) }), rules),
    ).toEqual({
      requiredLevel: level,
      adl: level,
      flags: null,
      services: null,
    });
  });
  it('covers all 21 valid integer scores using the shared S09 classifier', () => {
    const expected = [
      ...Array<string>(5).fill('advanced'),
      ...Array<string>(7).fill('intermediate'),
      ...Array<string>(9).fill('basic'),
    ];
    expect(
      expected.map(
        (_, score) =>
          calculateBookingLevel(input({ adlTotalScore: score }), rules).adl,
      ),
    ).toEqual(expected);
  });
  it.each([-1, 21, 0.5, NaN, Infinity, '12', null, undefined, true])(
    'rejects invalid ADL %s without clamping',
    (value) => {
      errorCode(
        () =>
          calculateBookingLevel(
            input({ adlTotalScore: value as number }),
            rules,
          ),
        'BOOKING_LEVEL_INPUT_INVALID',
      );
    },
  );
  it.each([
    ['ng_tube', 'advanced'],
    ['urinary_catheter', 'advanced'],
    ['oxygen', 'advanced'],
    ['pressure_ulcer', 'advanced'],
    ['injection', 'advanced'],
    ['end_of_life', 'advanced'],
    ['dementia', 'intermediate'],
    ['diabetes', 'intermediate'],
    ['fall_risk', 'intermediate'],
    ['unsure', 'intermediate'],
  ])('Flag %s uses the stored %s rule', (code, level) => {
    expect(calculateBookingLevel(input({ flags: [code] }), rules).flags).toBe(
      level,
    );
  });
  it.each([false, null])(
    'dementiaSevere=%s uses the general rule rather than hard-coded advanced',
    (dementiaSevere) => {
      expect(
        calculateBookingLevel(
          input({ flags: ['dementia'], dementiaSevere }),
          rules,
        ).requiredLevel,
      ).toBe('intermediate');
    },
  );
  it('severe dementia uses the exact severe rule and cannot silently fall back if missing', () => {
    expect(
      calculateBookingLevel(
        input({ flags: ['dementia'], dementiaSevere: true }),
        rules,
      ).flags,
    ).toBe('advanced');
    errorCode(
      () =>
        calculateBookingLevel(
          input({ flags: ['dementia'], dementiaSevere: true }),
          rules.filter((r) => r.variant !== 'severe'),
        ),
      'BOOKING_LEVEL_RULE_MISSING',
    );
    expect(
      calculateBookingLevel(input({ dementiaSevere: true }), rules).flags,
    ).toBeNull();
  });
  it('system unsure is injected even when no flags were selected; clearing it removes its effect', () => {
    expect(
      calculateBookingLevel(input({ hasUnsureFlag: true }), rules).flags,
    ).toBe('intermediate');
    expect(
      calculateBookingLevel(input({ hasUnsureFlag: false }), rules).flags,
    ).toBeNull();
  });
  it('takes the maximum across flags and all criteria, regardless of order or duplicates', () => {
    const value = input({
      adlTotalScore: 10,
      flags: ['diabetes', 'injection', 'injection'],
      services: [service('A01', 'basic')],
    });
    expect(calculateBookingLevel(value, [...rules].reverse())).toEqual({
      adl: 'intermediate',
      flags: 'advanced',
      services: 'basic',
      requiredLevel: 'advanced',
    });
  });
  it('F03 alone raises a basic-ADL booking to advanced, as corrected on 9 Oct', () => {
    expect(
      calculateBookingLevel(
        input({ services: [service('F03', 'basic')] }),
        rules,
      ),
    ).toEqual({
      adl: 'basic',
      flags: null,
      services: 'advanced',
      requiredLevel: 'advanced',
    });
    expect(
      calculateBookingLevel(
        input({ adlTotalScore: 0, services: [service('F03', 'advanced')] }),
        rules,
      ).requiredLevel,
    ).toBe('advanced');
  });
  it('service overrides win over the activity level; the calculator does not hard-code F03 advanced', () => {
    const changed = rules.map((r) =>
      r.code === 'F03' ? { ...r, level: 'intermediate' } : r,
    );
    expect(
      calculateBookingLevel(
        input({ services: [service('F03', 'advanced')] }),
        changed,
      ).services,
    ).toBe('intermediate');
  });
  it.each(['basic', 'intermediate', 'advanced'])(
    'no service override is normal and falls back to activity level %s',
    (level) => {
      expect(
        calculateBookingLevel(
          input({ services: [service('OTHER', level)] }),
          rules,
        ).services,
      ).toBe(level);
      expect(
        calculateBookingLevel(
          input({ services: [service(null, level)] }),
          rules,
        ).services,
      ).toBe(level);
    },
  );
  it('explicit null override means no effect; unlike an absent override it must not fall through', () => {
    const none: BookingLevelRule = {
      source: 'service',
      code: 'NONE',
      variant: '',
      level: null,
      isActive: true,
    };
    expect(
      calculateBookingLevel(
        input({ services: [service('NONE', 'advanced')] }),
        [none],
      ).services,
    ).toBeNull();
  });
  it('inactive service override is ignored and activity fallback remains valid', () => {
    const inactive = rules.map((r) => ({ ...r, isActive: false }));
    expect(
      calculateBookingLevel(
        input({ services: [service('F03', 'advanced')] }),
        inactive,
      ).services,
    ).toBe('advanced');
  });
  it('missing or inactive exact flag rule is RULE_MISSING as confirmed by the user', () => {
    errorCode(
      () => calculateBookingLevel(input({ flags: ['unknown'] }), rules),
      'BOOKING_LEVEL_RULE_MISSING',
    );
    errorCode(
      () =>
        calculateBookingLevel(
          input({ flags: ['injection'] }),
          rules.map((r) => ({ ...r, isActive: false })),
        ),
      'BOOKING_LEVEL_RULE_MISSING',
    );
  });
  it('missing service override and missing fallback is RULE_MISSING, not basic', () => {
    errorCode(
      () =>
        calculateBookingLevel(
          input({ services: [service('UNKNOWN', null)] }),
          rules,
        ),
      'BOOKING_LEVEL_RULE_MISSING',
    );
  });
  it('invalid rule/fallback levels are configuration errors', () => {
    errorCode(
      () =>
        calculateBookingLevel(
          input({ flags: ['injection'] }),
          rules.map((r) =>
            r.code === 'injection' ? { ...r, level: 'expert' } : r,
          ),
        ),
      'BOOKING_LEVEL_RULE_INVALID',
    );
    errorCode(
      () =>
        calculateBookingLevel(
          input({ services: [service(null, 'expert')] }),
          rules,
        ),
      'BOOKING_LEVEL_RULE_INVALID',
    );
  });
  it('uses the same level ordering S18 can import; no-effect values never raise a level', () => {
    expect(CARE_LEVELS).toEqual([
      CareLevel.BASIC,
      CareLevel.INTERMEDIATE,
      CareLevel.ADVANCED,
    ]);
    expect(
      compareCareLevels(CareLevel.ADVANCED, CareLevel.BASIC),
    ).toBeGreaterThan(0);
    expect(highestCareLevel([null, CareLevel.BASIC, null])).toBe(
      CareLevel.BASIC,
    );
    expect(highestCareLevel([])).toBeNull();
  });
});
