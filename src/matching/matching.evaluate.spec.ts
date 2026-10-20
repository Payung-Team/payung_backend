import { CareLevel, CARE_LEVELS } from '../common/care-level/care-level';
import {
  evaluateCaregiverMatch,
  MatchingBooking,
  MatchingCaregiver,
} from './matching.evaluate';
const day = new Date('2026-10-25T00:00:00+07:00');
const booking = (
  overrides: Partial<MatchingBooking> = {},
): MatchingBooking => ({
  requiredLevel: 'basic',
  requiredSkills: [],
  ...overrides,
});
const candidate = (
  overrides: Partial<MatchingCaregiver> = {},
): MatchingCaregiver => ({
  careLevel: 'advanced',
  profession: 'nurse',
  skills: ['injection', 'physiotherapy'],
  evidence: {
    profession: 'nurse',
    status: 'approved',
    expiresAt: new Date('2027-01-01T00:00:00Z'),
  },
  ...overrides,
});
const locked = (code = 'injection', profession = 'nurse') => ({
  code,
  lockedProfessions: [profession],
});
const evaluate = (b = booking(), c = candidate(), date = day) =>
  evaluateCaregiverMatch(b, c, date);
describe('S18 pure four-condition matching', () => {
  it.each(
    CARE_LEVELS.flatMap((required, i) =>
      CARE_LEVELS.map((careLevel, j) => [required, careLevel, j >= i] as const),
    ),
  )('level %s vs %s => %s', (requiredLevel, careLevel, passed) => {
    const result = evaluate(
      booking({ requiredLevel }),
      candidate({ careLevel }),
    );
    expect(result.passed).toBe(passed);
    expect(result.checks.level).toBe(passed);
    expect(result.reasons).toEqual(passed ? [] : [{ reason: 'LEVEL_TOO_LOW' }]);
  });
  it.each([null, 'invalid'])(
    'unknown caregiver level %s is never basic',
    (careLevel) => {
      expect(evaluate(booking(), candidate({ careLevel }))).toMatchObject({
        passed: false,
        reasons: [{ reason: 'LEVEL_NOT_SET' }],
      });
    },
  );
  it.each([
    { requiredLevel: null },
    { requiredLevel: 'unknown' },
    { requiredSkills: null },
  ])('legacy/unmatchable booking fails closed %j', (value) => {
    expect(() => evaluate(booking(value))).toThrow(
      expect.objectContaining({
        extensions: { code: 'BOOKING_NOT_MATCHABLE', statusCode: 422 },
      }),
    );
  });
  it('an empty computed skill list checks only level', () => {
    expect(
      evaluate(
        booking(),
        candidate({
          profession: 'general_caregiver',
          skills: [],
          evidence: null,
        }),
      ),
    ).toEqual({
      passed: true,
      checks: { level: true, skills: true, profession: true, evidence: true },
      reasons: [],
    });
  });
  it('unlocked skills require codes but no professional license', () => {
    const b = booking({
      requiredSkills: [{ code: 'bathing', lockedProfessions: [] }],
    });
    expect(
      evaluate(b, candidate({ skills: ['อาบน้ำ'], evidence: null })),
    ).toMatchObject({
      passed: false,
      reasons: [{ reason: 'SKILL_MISSING', skillCode: 'bathing' }],
    });
    expect(
      evaluate(b, candidate({ skills: ['bathing'], evidence: null })).passed,
    ).toBe(true);
  });
  it('does not short-circuit; reports level, each missing skill, profession and evidence', () => {
    const result = evaluate(
      booking({
        requiredLevel: 'advanced',
        requiredSkills: [locked('physiotherapy', 'physiotherapist'), locked()],
      }),
      candidate({
        careLevel: null,
        profession: 'general_caregiver',
        skills: [],
        evidence: null,
      }),
    );
    expect(result.checks).toEqual({
      level: false,
      skills: false,
      profession: false,
      evidence: false,
    });
    expect(result.reasons).toEqual([
      { reason: 'LEVEL_NOT_SET' },
      { reason: 'SKILL_MISSING', skillCode: 'injection' },
      { reason: 'SKILL_MISSING', skillCode: 'physiotherapy' },
      { reason: 'PROFESSION_MISMATCH', skillCode: 'injection' },
      { reason: 'PROFESSION_MISMATCH', skillCode: 'physiotherapy' },
      { reason: 'EVIDENCE_NOT_APPROVED', skillCode: 'injection' },
      { reason: 'EVIDENCE_NOT_APPROVED', skillCode: 'physiotherapy' },
    ]);
  });
  it('AC5: a BASIC physiotherapy booking still requires a physiotherapist', () => {
    const b = booking({
      requiredSkills: [locked('physiotherapy', 'physiotherapist')],
    });
    expect(evaluate(b).reasons).toContainEqual({
      reason: 'PROFESSION_MISMATCH',
      skillCode: 'physiotherapy',
    });
    expect(
      evaluate(
        b,
        candidate({
          profession: 'physiotherapist',
          evidence: {
            profession: 'physiotherapist',
            status: 'approved',
            expiresAt: new Date('2027-01-01'),
          },
        }),
      ).passed,
    ).toBe(true);
  });
  it.each(['nurse', 'physiotherapist', 'general_caregiver'])(
    'injection + physiotherapy is impossible for one profession %s',
    (profession) => {
      const b = booking({
        requiredSkills: [locked(), locked('physiotherapy', 'physiotherapist')],
      });
      expect(evaluate(b, candidate({ profession })).passed).toBe(false);
    },
  );
  it.each([null, 'pending', 'rejected', 'unknown'])(
    'evidence status %s is not approved',
    (status) => {
      expect(
        evaluate(
          booking({ requiredSkills: [locked()] }),
          candidate({
            evidence: {
              profession: 'nurse',
              status,
              expiresAt: new Date('2027-01-01'),
            },
          }),
        ),
      ).toMatchObject({
        passed: false,
        reasons: [{ reason: 'EVIDENCE_NOT_APPROVED', skillCode: 'injection' }],
      });
    },
  );
  it('missing evidence/expiry and evidence for a pending different profession never qualifies', () => {
    for (const evidence of [
      null,
      { profession: 'nurse', status: 'approved', expiresAt: null },
      {
        profession: 'physiotherapist',
        status: 'approved',
        expiresAt: new Date('2027-01-01'),
      },
    ])
      expect(
        evaluate(
          booking({ requiredSkills: [locked()] }),
          candidate({ evidence }),
        ).checks.evidence,
      ).toBe(false);
  });
  it.each(['expired', 'approved'])(
    'expired evidence %s is rejected even before the daily cron runs',
    (status) => {
      expect(
        evaluate(
          booking({ requiredSkills: [locked()] }),
          candidate({
            evidence: {
              profession: 'nurse',
              status,
              expiresAt: new Date(day.getTime() - 1),
            },
          }),
        ).reasons,
      ).toEqual([{ reason: 'EVIDENCE_EXPIRED', skillCode: 'injection' }]);
    },
  );
  it('expiry boundary: equality is expired, one millisecond before is valid', () => {
    const b = booking({ requiredSkills: [locked()] });
    const c = candidate({
      evidence: { profession: 'nurse', status: 'approved', expiresAt: day },
    });
    expect(evaluate(b, c, day).passed).toBe(false);
    expect(evaluate(b, c, new Date(day.getTime() - 1)).passed).toBe(true);
  });
  it('can reject a license still valid on listing day but expired before the supplied service date', () => {
    const b = booking({ requiredSkills: [locked()] });
    const c = candidate({
      evidence: {
        profession: 'nurse',
        status: 'approved',
        expiresAt: new Date('2026-10-24T23:59:59.999+07:00'),
      },
    });
    expect(evaluate(b, c, new Date('2026-10-20T12:00:00+07:00')).passed).toBe(
      true,
    );
    expect(evaluate(b, c, day).reasons).toEqual([
      { reason: 'EVIDENCE_EXPIRED', skillCode: 'injection' },
    ]);
  });
  it('uses profession locks supplied by S17, including future multi-profession metadata', () => {
    const b = booking({
      requiredSkills: [
        {
          code: 'future_skill',
          lockedProfessions: ['nurse', 'trained_assistant'],
        },
      ],
    });
    const c = candidate({
      profession: 'trained_assistant',
      skills: ['future_skill'],
      evidence: {
        profession: 'trained_assistant',
        status: 'approved',
        expiresAt: new Date('2027-01-01'),
      },
    });
    expect(evaluate(b, c).passed).toBe(true);
    expect(
      evaluate(
        b,
        candidate({
          profession: 'general_caregiver',
          skills: ['future_skill'],
        }),
      ).passed,
    ).toBe(false);
  });
  it('requires every skill; duplicate caregiver codes do not compensate for a missing code', () => {
    const b = booking({
      requiredSkills: [
        { code: 'a', lockedProfessions: [] },
        { code: 'b', lockedProfessions: [] },
      ],
    });
    expect(evaluate(b, candidate({ skills: ['a', 'a'] })).reasons).toEqual([
      { reason: 'SKILL_MISSING', skillCode: 'b' },
    ]);
  });
  it('is deterministic, does not mutate inputs and has no internal clock', () => {
    const b = booking({
      requiredSkills: [locked('physiotherapy', 'physiotherapist'), locked()],
    });
    const c = candidate();
    const before = JSON.stringify({ b, c });
    const a = evaluate(b, c);
    expect(evaluate(b, c)).toEqual(a);
    expect(JSON.stringify({ b, c })).toBe(before);
    expect(() => evaluate(b, c, new Date('invalid'))).toThrow(RangeError);
    expect(CareLevel.BASIC).toBe('basic');
  });
});
