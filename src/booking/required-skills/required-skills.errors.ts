import { UnprocessableEntityException } from '@nestjs/common';
import { GraphQLError } from 'graphql';

export class SkillRuleInvalidError extends GraphQLError {
  constructor() {
    super(
      'ไม่สามารถสร้างรายการทักษะที่ booking ต้องการได้ เนื่องจากกติกาทักษะไม่ถูกต้อง',
      {
        extensions: { code: 'SKILL_RULE_INVALID', statusCode: 422 },
      },
    );
  }
}

export function skillErrorForTransport(
  error: unknown,
  transport: 'graphql' | 'rest',
): never {
  if (error instanceof SkillRuleInvalidError && transport === 'rest') {
    throw new UnprocessableEntityException({
      statusCode: 422,
      code: 'SKILL_RULE_INVALID',
      message: error.message,
    });
  }
  throw error;
}
