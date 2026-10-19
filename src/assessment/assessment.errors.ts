import { UnprocessableEntityException } from '@nestjs/common';
import { GraphQLError } from 'graphql';

export const ASSESSMENT_ERROR = {
  INCOMPLETE: 'ASSESSMENT_INCOMPLETE',
  ANSWER_INVALID: 'ASSESSMENT_ANSWER_INVALID',
  FLAG_INVALID: 'ASSESSMENT_FLAG_INVALID',
  FLAGS_CONFLICT: 'ASSESSMENT_FLAGS_CONFLICT',
  ACCESS_DENIED: 'ASSESSMENT_ACCESS_DENIED',
  REQUIRED: 'ASSESSMENT_REQUIRED',
} as const;
type AssessmentErrorCode =
  (typeof ASSESSMENT_ERROR)[keyof typeof ASSESSMENT_ERROR];

/** Like ConsentError, expose domain codes directly in extensions.code. */
export class AssessmentError extends GraphQLError {
  constructor(
    code: AssessmentErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message, {
      extensions: {
        code,
        statusCode: code === ASSESSMENT_ERROR.ACCESS_DENIED ? 403 : 422,
        ...details,
      },
    });
  }
}
export function assessmentAccessDenied(): AssessmentError {
  return new AssessmentError(
    ASSESSMENT_ERROR.ACCESS_DENIED,
    'ไม่สามารถเข้าถึงข้อมูลแบบประเมินนี้ได้',
  );
}
export const ASSESSMENT_REQUIRED_MESSAGE =
  'กรุณาทำแบบประเมิน ADL และเงื่อนไขพิเศษของผู้สูงอายุให้ครบก่อนจอง';
export function assessmentRequired(transport: 'graphql' | 'rest'): Error {
  return transport === 'rest'
    ? new UnprocessableEntityException({
        statusCode: 422,
        code: ASSESSMENT_ERROR.REQUIRED,
        message: ASSESSMENT_REQUIRED_MESSAGE,
      })
    : new AssessmentError(
        ASSESSMENT_ERROR.REQUIRED,
        ASSESSMENT_REQUIRED_MESSAGE,
      );
}
