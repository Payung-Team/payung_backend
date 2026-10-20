import { UnprocessableEntityException } from '@nestjs/common';
import { GraphQLError } from 'graphql';
export type BookingLevelErrorCode =
  | 'BOOKING_LEVEL_RULE_MISSING'
  | 'BOOKING_LEVEL_RULE_INVALID'
  | 'BOOKING_LEVEL_INPUT_INVALID';
export class BookingLevelError extends GraphQLError {
  constructor(code: BookingLevelErrorCode) {
    super(
      'ไม่สามารถคำนวณระดับ booking ได้ เนื่องจากข้อมูลหรือกติกาไม่ถูกต้อง',
      { extensions: { code, statusCode: 422 } },
    );
  }
}
export function levelErrorForTransport(
  error: unknown,
  transport: 'graphql' | 'rest',
): never {
  if (error instanceof BookingLevelError && transport === 'rest')
    throw new UnprocessableEntityException({
      statusCode: 422,
      code: error.extensions.code,
      message: error.message,
    });
  throw error;
}
