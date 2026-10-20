import {
  careLevelFromDb,
  compareCareLevels,
} from '../common/care-level/care-level';
import { GraphQLError } from 'graphql';

export enum MatchRejectReason {
  LEVEL_NOT_SET = 'LEVEL_NOT_SET',
  LEVEL_TOO_LOW = 'LEVEL_TOO_LOW',
  SKILL_MISSING = 'SKILL_MISSING',
  PROFESSION_MISMATCH = 'PROFESSION_MISMATCH',
  EVIDENCE_NOT_APPROVED = 'EVIDENCE_NOT_APPROVED',
  EVIDENCE_EXPIRED = 'EVIDENCE_EXPIRED',
}
export interface MatchingSkill {
  code: string;
  lockedProfessions: readonly string[];
}
export interface MatchingBooking {
  requiredLevel: string | null;
  requiredSkills: readonly MatchingSkill[] | null;
}
export interface MatchingEvidence {
  /** The approved profession this evidence belongs to; never a pending request. */
  profession: string;
  status: string | null;
  expiresAt: Date | null;
}
export interface MatchingCaregiver {
  careLevel: string | null;
  profession: string;
  skills: readonly string[];
  evidence: MatchingEvidence | null;
}
export interface MatchRejection {
  reason: MatchRejectReason;
  skillCode?: string;
}
export interface MatchEvaluation {
  passed: boolean;
  checks: {
    level: boolean;
    skills: boolean;
    profession: boolean;
    evidence: boolean;
  };
  reasons: MatchRejection[];
}
export class BookingNotMatchableError extends GraphQLError {
  constructor() {
    super('Booking นี้ยังไม่มีระดับหรือรายการทักษะที่ใช้กรองผู้ดูแล', {
      extensions: { code: 'BOOKING_NOT_MATCHABLE', statusCode: 422 },
    });
  }
}
export function assertMatchableBooking(booking: MatchingBooking): void {
  if (
    !careLevelFromDb(booking.requiredLevel) ||
    booking.requiredSkills === null
  )
    throw new BookingNotMatchableError();
  const codes = new Set<string>();
  for (const skill of booking.requiredSkills) {
    if (!skill.code || codes.has(skill.code))
      throw new BookingNotMatchableError();
    codes.add(skill.code);
  }
}
/** Pure S18 evaluation: no I/O, no clock and no hard-coded skill/profession map. */
export function evaluateCaregiverMatch(
  booking: MatchingBooking,
  caregiver: MatchingCaregiver,
  referenceDate: Date,
): MatchEvaluation {
  assertMatchableBooking(booking);
  if (!Number.isFinite(referenceDate.getTime()))
    throw new RangeError('Invalid evidence reference date');
  const checks = {
    level: true,
    skills: true,
    profession: true,
    evidence: true,
  };
  const reasons: MatchRejection[] = [];
  const caregiverLevel = careLevelFromDb(caregiver.careLevel);
  if (!caregiverLevel) {
    checks.level = false;
    reasons.push({ reason: MatchRejectReason.LEVEL_NOT_SET });
  } else if (
    compareCareLevels(caregiverLevel, careLevelFromDb(booking.requiredLevel)!) <
    0
  ) {
    checks.level = false;
    reasons.push({ reason: MatchRejectReason.LEVEL_TOO_LOW });
  }
  const skills = new Set(caregiver.skills);
  // Stable reason order: condition order first, then canonical skill code.
  const required = [...booking.requiredSkills!].sort((a, b) =>
    a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
  );
  for (const skill of required)
    if (!skills.has(skill.code)) {
      checks.skills = false;
      reasons.push({
        reason: MatchRejectReason.SKILL_MISSING,
        skillCode: skill.code,
      });
    }
  const locked = required.filter((skill) => skill.lockedProfessions.length > 0);
  for (const skill of locked)
    if (!skill.lockedProfessions.includes(caregiver.profession)) {
      checks.profession = false;
      reasons.push({
        reason: MatchRejectReason.PROFESSION_MISMATCH,
        skillCode: skill.code,
      });
    }
  for (const skill of locked) {
    const evidence = caregiver.evidence;
    const scoped =
      evidence &&
      evidence.profession === caregiver.profession &&
      skill.lockedProfessions.includes(evidence.profession);
    let reason: MatchRejectReason | undefined;
    if (!scoped) reason = MatchRejectReason.EVIDENCE_NOT_APPROVED;
    else if (evidence.status === 'expired')
      reason = MatchRejectReason.EVIDENCE_EXPIRED;
    else if (
      evidence.status !== 'approved' ||
      !evidence.expiresAt ||
      !Number.isFinite(evidence.expiresAt.getTime())
    )
      reason = MatchRejectReason.EVIDENCE_NOT_APPROVED;
    else if (evidence.expiresAt.getTime() <= referenceDate.getTime())
      reason = MatchRejectReason.EVIDENCE_EXPIRED;
    if (reason) {
      checks.evidence = false;
      reasons.push({ reason, skillCode: skill.code });
    }
  }
  return { passed: Object.values(checks).every(Boolean), checks, reasons };
}
