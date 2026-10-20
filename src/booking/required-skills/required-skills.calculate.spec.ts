import { readFileSync } from 'fs';
import { join } from 'path';
import {
  calculateRequiredSkills,
  SkillInputs,
  SkillRule,
} from './required-skills.calculate';
import { ADL_ITEMS } from '../../assessment/assessment.constants';

// Test the actual configured rows, with independent expected cases below.
const sql = readFileSync(
  join(
    __dirname,
    '../../../prisma/migrations/20261009000000_pyg570_seed_required_skills/migration.sql',
  ),
  'utf8',
);
const rules: SkillRule[] = [
  ...sql.matchAll(
    /\('(adl|flag|service)',\s*'([^']+)',\s*(NULL|\d+),\s*(NULL|\d+),\s*'([^']+)'\)/g,
  ),
].map((m) => ({
  source: m[1],
  sourceCode: m[2],
  scoreMin: m[3] === 'NULL' ? null : Number(m[3]),
  scoreMax: m[4] === 'NULL' ? null : Number(m[4]),
  skillCode: m[5],
  isActive: true,
  skill: { code: m[5], isActive: true },
}));
const input = (changes: Partial<SkillInputs> = {}): SkillInputs => ({
  adlAnswers: Object.fromEntries(
    ADL_ITEMS.map((item) => [item.code, item.maxScore]),
  ),
  flags: [],
  serviceCodes: [],
  ...changes,
});
const adlCases = [
  ['transfers', 1, 'transfer_assist', 2],
  ['mobility', 1, 'wheelchair_push', 2],
  ['feeding', 1, 'feeding_assist', 2],
  ['bladder', 0, 'toileting_care', 1],
  ['bowels', 0, 'toileting_care', 1],
  ['bathing', 0, 'bathing', 1],
  ['dressing', 1, 'dressing_assist', 2],
] as const;

describe('S17 Required Skills pure calculator', () => {
  it('loads the current 18 seed rows (7 ADL / 5 flag / 6 service), not the older story count', () => {
    expect(rules).toHaveLength(18);
    expect(
      ['adl', 'flag', 'service'].map(
        (s) => rules.filter((r) => r.source === s).length,
      ),
    ).toEqual([7, 5, 6]);
  });
  it.each(adlCases)(
    'ADL %s matches its range and excludes the next score',
    (code, score, skill, outside) => {
      const base = input();
      expect(
        calculateRequiredSkills(
          input({ adlAnswers: { ...base.adlAnswers, [code]: score } }),
          rules,
        ),
      ).toEqual([{ code: skill, sources: ['adl'] }]);
      expect(
        calculateRequiredSkills(
          input({ adlAnswers: { ...base.adlAnswers, [code]: 0 } }),
          rules,
        ),
      ).toEqual([{ code: skill, sources: ['adl'] }]);
      expect(
        calculateRequiredSkills(
          input({ adlAnswers: { ...base.adlAnswers, [code]: outside } }),
          rules,
        ),
      ).toEqual([]);
    },
  );
  it.each([
    ['pressure_ulcer', 'pressure_ulcer_care'],
    ['ng_tube', 'tube_feeding'],
    ['dementia', 'dementia_care'],
    ['diabetes', 'glucose_diet_care'],
    ['injection', 'injection'],
  ])('Flag %s yields %s', (flag, code) => {
    expect(calculateRequiredSkills(input({ flags: [flag] }), rules)).toEqual([
      { code, sources: ['flag'] },
    ]);
  });
  it.each([
    ['F03', 'physiotherapy'],
    ['C04', 'tube_feeding'],
    ['D05', 'injection'],
    ['E04', 'suction'],
    ['E05', 'tracheostomy_care'],
    ['E07', 'abdominal_wound_care'],
  ])('Service %s yields %s independently of booking level', (service, code) => {
    expect(
      calculateRequiredSkills(input({ serviceCodes: [service] }), rules),
    ).toEqual([{ code, sources: ['service'] }]);
  });
  it('AC6: transfers=1 and bathing=0 return both, sorted by code', () => {
    const adlAnswers = { ...input().adlAnswers, transfers: 1, bathing: 0 };
    expect(calculateRequiredSkills(input({ adlAnswers }), rules)).toEqual([
      { code: 'bathing', sources: ['adl'] },
      { code: 'transfer_assist', sources: ['adl'] },
    ]);
  });
  it('deduplicates a skill from two sources and repeated flags/services/rules', () => {
    expect(
      calculateRequiredSkills(
        input({ flags: ['ng_tube', 'ng_tube'], serviceCodes: ['C04', 'C04'] }),
        [...rules, ...rules],
      ),
    ).toEqual([{ code: 'tube_feeding', sources: ['flag', 'service'] }]);
  });
  it('deduplicates multiple ADL items and unions all three sources deterministically', () => {
    const duplicate: SkillRule = {
      ...rules[0],
      skillCode: 'tube_feeding',
      skill: { code: 'tube_feeding', isActive: true },
    };
    const all = input({
      adlAnswers: {
        ...input().adlAnswers,
        transfers: 1,
        bladder: 0,
        bowels: 0,
      },
      flags: ['ng_tube'],
      serviceCodes: ['C04'],
    });
    const result = calculateRequiredSkills(
      all,
      [...rules, duplicate].reverse(),
    );
    expect(result).toEqual([
      { code: 'toileting_care', sources: ['adl'] },
      { code: 'transfer_assist', sources: ['adl'] },
      { code: 'tube_feeding', sources: ['adl', 'flag', 'service'] },
    ]);
    expect(result).toEqual(calculateRequiredSkills(all, [...rules, duplicate]));
  });
  it('returns [] for no matches, unknown services/flags, and no rules', () => {
    expect(
      calculateRequiredSkills(
        input({ flags: ['unsure'], serviceCodes: ['unknown'] }),
        rules,
      ),
    ).toEqual([]);
    expect(calculateRequiredSkills(input(), [])).toEqual([]);
  });
  it('uses S08 null=0 for skills; unsure flag only contributes if configured', () => {
    expect(
      calculateRequiredSkills(
        input({
          adlAnswers: { ...input().adlAnswers, bathing: null },
          flags: ['unsure'],
        }),
        rules,
      ),
    ).toEqual([{ code: 'bathing', sources: ['adl'] }]);
    const configured = { ...rules[7], sourceCode: 'unsure' };
    expect(
      calculateRequiredSkills(input({ flags: ['unsure'] }), [configured]),
    ).toEqual([{ code: configured.skillCode, sources: ['flag'] }]);
  });
  it('equal totals can produce different skills; total score and free text are not inputs', () => {
    const a = input({ adlAnswers: { ...input().adlAnswers, transfers: 1 } });
    const b = input({ adlAnswers: { ...input().adlAnswers, mobility: 1 } });
    expect(
      Object.values(a.adlAnswers).reduce<number>(
        (sum, score) => sum + (score ?? 0),
        0,
      ),
    ).toBe(
      Object.values(b.adlAnswers).reduce<number>(
        (sum, score) => sum + (score ?? 0),
        0,
      ),
    );
    expect(calculateRequiredSkills(a, rules)).not.toEqual(
      calculateRequiredSkills(b, rules),
    );
  });
  it.each([null, { code: 'bathing', isActive: false }])(
    'E11 rejects missing/inactive skill without dropping the rule',
    (skill) => {
      const rule = { ...rules.find((r) => r.skillCode === 'bathing')!, skill };
      let error: unknown;
      try {
        calculateRequiredSkills(
          input({ adlAnswers: { ...input().adlAnswers, bathing: 0 } }),
          [rule],
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        extensions: { code: 'SKILL_RULE_INVALID', statusCode: 422 },
      });
    },
  );
  it('inactive rules are ignored even if their target is invalid', () => {
    expect(
      calculateRequiredSkills(input(), [
        { ...rules[0], isActive: false, skill: null },
      ]),
    ).toEqual([]);
  });
  it('takes thresholds from data, including open endpoints', () => {
    const rule = { ...rules[0], scoreMin: 2, scoreMax: null };
    expect(calculateRequiredSkills(input(), [rule])).toEqual([
      { code: 'transfer_assist', sources: ['adl'] },
    ]);
    expect(
      calculateRequiredSkills(
        input({ adlAnswers: { ...input().adlAnswers, transfers: 1 } }),
        [rule],
      ),
    ).toEqual([]);
  });
});
