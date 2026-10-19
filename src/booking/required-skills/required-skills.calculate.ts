import { SkillRuleInvalidError } from './required-skills.errors';
import type { RequiredSkillResult, SkillSource } from './required-skills.types';

export interface SkillRule {
  source: string;
  sourceCode: string;
  scoreMin: number | null;
  scoreMax: number | null;
  skillCode: string;
  isActive: boolean;
  skill: { code: string; isActive: boolean } | null;
}

export interface SkillInputs {
  adlAnswers: Readonly<Record<string, number | null>>;
  flags: readonly string[];
  serviceCodes: readonly string[];
}

const SOURCES: readonly SkillSource[] = ['adl', 'flag', 'service'];

/** No IO or total-score input. Thresholds come exclusively from rule rows. */
export function calculateRequiredSkills(
  input: SkillInputs,
  rules: readonly SkillRule[],
): RequiredSkillResult[] {
  const flags = new Set(input.flags);
  const services = new Set(input.serviceCodes);
  const skills = new Map<string, Set<SkillSource>>();
  for (const rule of rules) {
    if (!rule.isActive) continue;
    if (!SOURCES.includes(rule.source as SkillSource))
      throw new SkillRuleInvalidError();
    let matches = false;
    if (rule.source === 'adl') {
      const answer = input.adlAnswers[rule.sourceCode];
      if (answer === undefined) throw new SkillRuleInvalidError();
      // S08 contract: Sammy 9 Oct 2026, null is 0 for skill-rule matching too.
      const score = answer ?? 0;
      matches =
        (rule.scoreMin === null || score >= rule.scoreMin) &&
        (rule.scoreMax === null || score <= rule.scoreMax);
    } else if (rule.source === 'flag') {
      matches = flags.has(rule.sourceCode);
    } else {
      matches = services.has(rule.sourceCode);
    }
    if (!matches) continue;
    if (
      !rule.skill ||
      !rule.skill.isActive ||
      rule.skill.code !== rule.skillCode
    ) {
      throw new SkillRuleInvalidError();
    }
    const sources = skills.get(rule.skillCode) ?? new Set<SkillSource>();
    sources.add(rule.source as SkillSource);
    skills.set(rule.skillCode, sources);
  }
  return [...skills.keys()].sort().map((code) => ({
    code,
    sources: SOURCES.filter((source) => skills.get(code)!.has(source)),
  }));
}
