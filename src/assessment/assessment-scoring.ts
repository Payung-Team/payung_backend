import {
  ADL_ITEMS,
  ASSESSMENT_FLAG_CODES,
  UNSURE_FLAG_THRESHOLD,
  type AdlAnswers,
} from './assessment.constants';
import { ASSESSMENT_ERROR, AssessmentError } from './assessment.errors';

export interface AssessmentValuesInput {
  answers: unknown;
  flags: unknown;
  noSpecialConditions: unknown;
  dementiaSevere?: unknown;
}

/** Pure: preserve null in storage, use zero only when calculating. */
export function calculateAdlAssessment(answers: unknown) {
  if (!Array.isArray(answers)) {
    throw new AssessmentError(
      ASSESSMENT_ERROR.INCOMPLETE,
      'กรุณาตอบแบบประเมิน ADL ให้ครบทุกข้อ',
      {
        missingAnswerCodes: ADL_ITEMS.map((item) => item.code),
      },
    );
  }
  const byCode = new Map<string, Record<string, unknown>>();
  // เก็บรหัสที่ผิดทั้งหมดก่อนโยน ให้ FE ชี้ข้อที่ผิดได้ (contract PYG-607 §8 · PYG-666)
  const invalidAnswerCodes: string[] = [];
  const duplicateAnswerCodes: string[] = [];
  let malformed = false;
  for (const answer of answers as unknown[]) {
    if (
      !answer ||
      typeof answer !== 'object' ||
      !('code' in answer) ||
      typeof answer.code !== 'string'
    ) {
      malformed = true;
      continue;
    }
    const code = answer.code;
    if (!ADL_ITEMS.some((item) => item.code === code)) {
      if (!invalidAnswerCodes.includes(code)) invalidAnswerCodes.push(code);
    } else if (byCode.has(code)) {
      if (!duplicateAnswerCodes.includes(code)) duplicateAnswerCodes.push(code);
    } else {
      byCode.set(code, answer as Record<string, unknown>);
    }
  }
  if (malformed || invalidAnswerCodes.length || duplicateAnswerCodes.length) {
    throw new AssessmentError(
      ASSESSMENT_ERROR.ANSWER_INVALID,
      'รหัสข้อ ADL ไม่ถูกต้องหรือซ้ำกัน',
      {
        ...(invalidAnswerCodes.length && { invalidAnswerCodes }),
        ...(duplicateAnswerCodes.length && { duplicateAnswerCodes }),
      },
    );
  }
  const missingAnswerCodes = ADL_ITEMS.filter((item) => {
    const answer = byCode.get(item.code);
    return (
      !answer || !Object.hasOwn(answer, 'value') || answer.value === undefined
    );
  }).map((item) => item.code);
  if (missingAnswerCodes.length) {
    throw new AssessmentError(
      ASSESSMENT_ERROR.INCOMPLETE,
      'กรุณาตอบแบบประเมิน ADL ให้ครบทุกข้อ',
      { missingAnswerCodes },
    );
  }
  const adlAnswers = {} as AdlAnswers;
  let adlTotalScore = 0;
  let unsureCount = 0;
  for (const item of ADL_ITEMS) {
    const value = byCode.get(item.code)!.value;
    if (
      value !== null &&
      (typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > item.maxScore)
    ) {
      throw new AssessmentError(
        ASSESSMENT_ERROR.ANSWER_INVALID,
        'คะแนน ADL อยู่นอกตัวเลือกที่กำหนด',
        { invalidAnswerCodes: [item.code] },
      );
    }
    adlAnswers[item.code] = value;
    adlTotalScore += value ?? 0;
    if (value === null) unsureCount++;
  }
  return {
    adlAnswers,
    adlTotalScore,
    unsureCount,
    hasUnsureFlag: unsureCount >= UNSURE_FLAG_THRESHOLD,
  };
}

export function validateAssessmentValues(input: AssessmentValuesInput) {
  const adl = calculateAdlAssessment(input.answers);
  const suppliedFlags = input.flags;
  if (
    !Array.isArray(suppliedFlags) ||
    suppliedFlags.some(
      (flag) => !ASSESSMENT_FLAG_CODES.includes(flag as never),
    ) ||
    new Set(suppliedFlags).size !== suppliedFlags.length
  ) {
    throw new AssessmentError(
      ASSESSMENT_ERROR.FLAG_INVALID,
      'เงื่อนไขพิเศษไม่ถูกต้องหรือซ้ำกัน',
      { fields: ['flags'] },
    );
  }
  const flags = ASSESSMENT_FLAG_CODES.filter((flag) =>
    suppliedFlags.includes(flag),
  );
  if (input.noSpecialConditions === true && flags.length) {
    throw new AssessmentError(
      ASSESSMENT_ERROR.FLAGS_CONFLICT,
      'ไม่มีเงื่อนไขพิเศษไม่สามารถเลือกพร้อมเงื่อนไขอื่นได้',
      { fields: ['flags', 'noSpecialConditions'] },
    );
  }
  if (
    typeof input.noSpecialConditions !== 'boolean' ||
    (!input.noSpecialConditions && flags.length === 0)
  ) {
    throw new AssessmentError(
      ASSESSMENT_ERROR.INCOMPLETE,
      'กรุณาระบุเงื่อนไขพิเศษหรือยืนยันว่าไม่มีเงื่อนไขพิเศษ',
      { fields: ['flags', 'noSpecialConditions'] },
    );
  }
  const hasDementia = flags.includes('dementia');
  if (!hasDementia && input.dementiaSevere != null) {
    throw new AssessmentError(
      ASSESSMENT_ERROR.FLAGS_CONFLICT,
      'ระบุความรุนแรงได้เมื่อเลือกเงื่อนไขสมองเสื่อมเท่านั้น',
      { fields: ['flags', 'dementiaSevere'] },
    );
  }
  if (hasDementia && typeof input.dementiaSevere !== 'boolean') {
    throw new AssessmentError(
      ASSESSMENT_ERROR.INCOMPLETE,
      'กรุณาระบุความรุนแรงของสมองเสื่อม',
      { fields: ['dementiaSevere'] },
    );
  }
  return {
    ...adl,
    flags,
    noSpecialConditions: input.noSpecialConditions,
    dementiaSevere: hasDementia ? (input.dementiaSevere as boolean) : null,
  };
}
