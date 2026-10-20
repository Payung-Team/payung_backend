import { ADL_ITEMS } from './assessment.constants';
import {
  calculateAdlAssessment,
  validateAssessmentValues,
} from './assessment-scoring';

const answers = (score: 'max' | number | null = 0) =>
  ADL_ITEMS.map(({ code, maxScore }) => ({
    code,
    value: score === 'max' ? maxScore : score,
  }));
const input = (overrides: Record<string, unknown> = {}) => ({
  answers: answers(),
  flags: [],
  noSpecialConditions: true,
  ...overrides,
});
function expectCode(
  fn: () => unknown,
  code: string,
  details: Record<string, unknown> = {},
) {
  try {
    fn();
    throw new Error('Expected assessment error');
  } catch (error) {
    expect(error).toMatchObject({
      extensions: { code, statusCode: 422, ...details },
    });
  }
}

describe('ADL scoring and validation (PYG-609)', () => {
  it.each([
    [0, 0, 0, false],
    ['max', 20, 0, false],
    [null, 0, 10, true],
  ] as const)(
    'score %s preserves answers and computes total=%s, unsure=%s',
    (value, total, unsure, flag) => {
      const result = calculateAdlAssessment(answers(value));
      expect(result).toMatchObject({
        adlTotalScore: total,
        unsureCount: unsure,
        hasUnsureFlag: flag,
      });
      expect(Object.keys(result.adlAnswers)).toHaveLength(10);
      if (value === null)
        expect(Object.values(result.adlAnswers)).toEqual(Array(10).fill(null));
    },
  );
  it('matches Sammy example and sets/removes unsure at the 2/3 boundary', () => {
    const values = [2, null, 1, 2, null, 1, 0, 0, 2, 2];
    const submitted = answers().map((answer, i) => ({
      ...answer,
      value: values[i],
    }));
    expect(calculateAdlAssessment(submitted)).toMatchObject({
      adlTotalScore: 10,
      unsureCount: 2,
      hasUnsureFlag: false,
    });
    submitted[5].value = null;
    expect(calculateAdlAssessment(submitted)).toMatchObject({
      adlTotalScore: 9,
      unsureCount: 3,
      hasUnsureFlag: true,
    });
    submitted[5].value = 1;
    expect(calculateAdlAssessment(submitted).hasUnsureFlag).toBe(false);
  });
  it.each([
    undefined,
    [],
    answers().slice(1),
    answers().map((x, i) => (i ? x : { code: x.code })),
  ])('rejects incomplete answers including an omitted value', (value) => {
    expectCode(() => calculateAdlAssessment(value), 'ASSESSMENT_INCOMPLETE');
  });
  it.each(['Feeding', 'unknown', 'toiletUse', 'unsure'])(
    'rejects unknown code %s',
    (code) => {
      expectCode(
        () =>
          calculateAdlAssessment([{ code, value: 0 }, ...answers().slice(1)]),
        'ASSESSMENT_ANSWER_INVALID',
        { invalidAnswerCodes: [code] },
      );
    },
  );
  it('rejects duplicate codes even with ten entries', () => {
    expectCode(
      () => calculateAdlAssessment([answers()[1], ...answers().slice(1)]),
      'ASSESSMENT_ANSWER_INVALID',
      { duplicateAnswerCodes: [answers()[1].code] },
    );
  });
  it('reports every unknown and duplicate code at once (PYG-666)', () => {
    const [first, second] = answers();
    try {
      calculateAdlAssessment([
        { code: 'eating', value: 0 },
        { code: 'Bladder', value: 0 },
        { code: 'eating', value: 0 },
        ...answers(),
        first,
        second,
        first,
      ]);
      throw new Error('Expected assessment error');
    } catch (error) {
      expect((error as { extensions: unknown }).extensions).toEqual({
        code: 'ASSESSMENT_ANSWER_INVALID',
        statusCode: 422,
        invalidAnswerCodes: ['eating', 'Bladder'],
        duplicateAnswerCodes: [first.code, second.code],
      });
    }
  });
  it.each([null, 'feeding', { value: 0 }, { code: 1, value: 0 }])(
    'rejects malformed answer entry %p without code metadata',
    (entry) => {
      try {
        calculateAdlAssessment([entry, ...answers()]);
        throw new Error('Expected assessment error');
      } catch (error) {
        expect((error as { extensions: unknown }).extensions).toEqual({
          code: 'ASSESSMENT_ANSWER_INVALID',
          statusCode: 422,
        });
      }
    },
  );
  it.each([-1, 3, 0.5, '1', 'unsure', true, NaN, Infinity])(
    'rejects feeding value %s in the service',
    (value) => {
      expectCode(
        () =>
          calculateAdlAssessment([
            { code: 'feeding', value },
            ...answers().slice(1),
          ]),
        'ASSESSMENT_ANSWER_INVALID',
      );
    },
  );
  it.each(ADL_ITEMS)(
    'enforces the individual range for $code',
    ({ code, maxScore }) => {
      expectCode(
        () =>
          calculateAdlAssessment(
            answers().map((a) =>
              a.code === code ? { code, value: maxScore + 1 } : a,
            ),
          ),
        'ASSESSMENT_ANSWER_INVALID',
      );
    },
  );
  it('accepts E2: no special conditions plus system unsure', () => {
    expect(
      validateAssessmentValues(input({ answers: answers(null) })),
    ).toMatchObject({
      flags: [],
      noSpecialConditions: true,
      hasUnsureFlag: true,
    });
  });
  it.each([
    ['unsure'],
    ['none'],
    ['severe'],
    ['oxygen', 'oxygen'],
    ['unknown'],
  ])('rejects invalid/duplicate flags %s', (...flags) => {
    expectCode(
      () =>
        validateAssessmentValues(input({ flags, noSpecialConditions: false })),
      'ASSESSMENT_FLAG_INVALID',
    );
  });
  it('rejects flags with noSpecialConditions', () => {
    expectCode(
      () => validateAssessmentValues(input({ flags: ['oxygen'] })),
      'ASSESSMENT_FLAGS_CONFLICT',
    );
  });
  it('requires an explicit flags/no-special decision', () => {
    expectCode(
      () => validateAssessmentValues(input({ noSpecialConditions: false })),
      'ASSESSMENT_INCOMPLETE',
    );
  });
  it.each([true, false])(
    'rejects orphan dementia severity %s',
    (dementiaSevere) => {
      expectCode(
        () => validateAssessmentValues(input({ dementiaSevere })),
        'ASSESSMENT_FLAGS_CONFLICT',
      );
    },
  );
  it.each([true, false])(
    'persists dementia severity %s and clears it when flag removed',
    (dementiaSevere) => {
      expect(
        validateAssessmentValues(
          input({
            flags: ['dementia'],
            noSpecialConditions: false,
            dementiaSevere,
          }),
        ).dementiaSevere,
      ).toBe(dementiaSevere);
      expect(validateAssessmentValues(input()).dementiaSevere).toBeNull();
    },
  );
  it('requires severity when dementia is selected', () => {
    expectCode(
      () =>
        validateAssessmentValues(
          input({ flags: ['dementia'], noSpecialConditions: false }),
        ),
      'ASSESSMENT_INCOMPLETE',
    );
  });
});
