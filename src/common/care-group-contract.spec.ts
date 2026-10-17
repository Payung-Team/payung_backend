import { readFileSync } from 'fs';
import { join } from 'path';
import { buildSchema, isInputObjectType, isObjectType } from 'graphql';
import { ValidationPipe } from '@nestjs/common';
import {
  CreateCareRecipientDto,
  UpdateCareRecipientDto,
} from '../patient/dto/care-recipient.dto';

describe('S09 contract boundaries', () => {
  const schema = buildSchema(
    readFileSync(join(__dirname, '../schema.gql'), 'utf8'),
  );
  it('keeps profile group nullable, assessment group non-null, and adds no field to public/caregiver projections', () => {
    const types = Object.values(schema.getTypeMap()).filter(isObjectType);
    expect(
      types
        .filter((type) => type.getFields().careGroup)
        .map((type) => type.name)
        .sort(),
    ).toEqual(['CareRecipientAssessment', 'GroupCareRecipient']);
    expect(
      String(
        types.find((type) => type.name === 'GroupCareRecipient')!.getFields()
          .careGroup.type,
      ),
    ).toBe('ElderCareGroup');
    expect(
      String(
        types
          .find((type) => type.name === 'CareRecipientAssessment')!
          .getFields().careGroup.type,
      ),
    ).toBe('ElderCareGroup!');
  });
  it('does not accept careGroup in any GraphQL input or operation argument', () => {
    for (const type of Object.values(schema.getTypeMap())) {
      if (isInputObjectType(type))
        expect(type.getFields()).not.toHaveProperty('careGroup');
    }
    for (const root of [schema.getQueryType()!, schema.getMutationType()!]) {
      for (const field of Object.values(root.getFields()))
        expect(field.args.map((arg) => arg.name)).not.toContain('careGroup');
    }
  });
  it.each([CreateCareRecipientDto, UpdateCareRecipientDto])(
    'rejects a client group in REST profile input %p',
    async (metatype) => {
      const pipe = new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      await expect(
        pipe.transform(
          { name: 'Test', careGroup: 'SOCIAL' },
          { type: 'body', metatype },
        ),
      ).rejects.toMatchObject({ status: 400 });
    },
  );
});
