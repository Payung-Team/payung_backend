import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import {
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
} from '@nestjs/graphql';
import { graphql, printSchema, type GraphQLSchema } from 'graphql';
import { AssessmentResolver } from './assessment.resolver';
import { AssessmentService } from './assessment.service';
import { SubmitCareRecipientAssessmentInput } from './dto/assessment.types';
import { ADL_ITEMS } from './assessment.constants';

describe('S08 GraphQL contract and global validation compatibility', () => {
  let schema: GraphQLSchema;
  let moduleRef: Awaited<
    ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>
  >;
  let service: AssessmentService;
  let stored: any;
  let actor: string;
  const id = '22222222-2222-4222-8222-222222222222';
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const mutation = `mutation Submit($input: SubmitCareRecipientAssessmentInput!) {
    submitCareRecipientAssessment(input: $input) {
      careRecipientId answers { code value } adlTotalScore unsureCount
      flags noSpecialConditions hasUnsureFlag dementiaSevere assessedAt careGroup
    }
  }`;
  const input = () => ({
    careRecipientId: id,
    answers: ADL_ITEMS.map(({ code, maxScore }) => ({
      code,
      value: maxScore as number | null,
    })),
    flags: [],
    noSpecialConditions: true,
  });
  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [GraphQLSchemaBuilderModule],
    }).compile();
    schema = await moduleRef
      .get(GraphQLSchemaFactory)
      .create([AssessmentResolver]);
  });
  afterAll(async () => {
    await moduleRef?.close();
  });
  beforeEach(() => {
    stored = null;
    actor = 'owner';
    const prisma: any = {
      careRecipient: {
        findUnique: jest.fn().mockResolvedValue({
          patientId: 'owner',
          is_deleted: false,
          familyGroupId: null,
        }),
      },
      booking: { findMany: jest.fn().mockResolvedValue([]) },
      careRecipientAssessment: {
        upsert: jest.fn(({ create }) => {
          stored = create;
          return stored;
        }),
        findUnique: jest.fn(() => stored),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ id }]),
    };
    prisma.$transaction = (fn) => fn(prisma);
    service = new AssessmentService(prisma, {} as never);
  });
  function execute(source: string, variableValues: Record<string, unknown>) {
    return graphql({
      schema,
      source,
      variableValues,
      rootValue: {
        submitCareRecipientAssessment: async ({ input }) => {
          const transformed = await pipe.transform(input, {
            type: 'body',
            metatype: SubmitCareRecipientAssessmentInput,
          });
          return service.submit(actor, transformed);
        },
        careRecipientAssessment: ({ careRecipientId }) =>
          service.read(actor, careRecipientId),
      },
    });
  }
  it('generates the agreed types/nullability without exposing internal fields', () => {
    const sdl = printSchema(schema);
    expect(sdl).toContain(
      'careRecipientAssessment(careRecipientId: ID!): CareRecipientAssessment',
    );
    expect(sdl).toContain(
      'submitCareRecipientAssessment(input: SubmitCareRecipientAssessmentInput!): CareRecipientAssessment!',
    );
    expect(sdl).toContain('answers: [CareRecipientAssessmentAnswerInput!]!');
    expect(sdl).toContain('value: Int\n');
    expect(sdl).not.toContain('assessedBy');
    expect(sdl).toContain('careGroup: ElderCareGroup!');
    expect(sdl).toContain('enum ElderCareGroup');
  });
  it('submit/read examples run through the generated schema and real service', async () => {
    const save = await execute(mutation, { input: input() });
    expect(save.errors).toBeUndefined();
    expect(save.data?.submitCareRecipientAssessment).toMatchObject({
      careRecipientId: id,
      adlTotalScore: 20,
      careGroup: 'SOCIAL',
      unsureCount: 0,
      hasUnsureFlag: false,
      flags: [],
      dementiaSevere: null,
    });
    const read = await execute(
      'query Read($id: ID!) { careRecipientAssessment(careRecipientId: $id) { adlTotalScore careGroup assessedAt } }',
      { id },
    );
    expect(read.errors).toBeUndefined();
    expect(read.data?.careRecipientAssessment).toMatchObject({
      careGroup: 'SOCIAL',
      adlTotalScore: 20,
    });
  });
  it('preserves explicit null through the global ValidationPipe', async () => {
    const data = input();
    data.answers[0].value = null;
    const result = await execute(mutation, { input: data });
    expect(result.errors).toBeUndefined();
    expect(stored.adlAnswers.feeding).toBeNull();
    expect(stored.adlTotalScore).toBe(18);
    expect(stored.unsureCount).toBe(1);
  });
  it('omitted nullable value reaches domain validation as incomplete, not unsure', async () => {
    const data: any = input();
    delete data.answers[0].value;
    const result = await execute(mutation, { input: data });
    expect(result.data).toBeNull();
    expect(result.errors?.[0].extensions).toMatchObject({
      code: 'ASSESSMENT_INCOMPLETE',
      statusCode: 422,
    });
    expect(stored).toBeNull();
  });
  it('unknown code reaches service error instead of DTO BAD_REQUEST', async () => {
    const data = input();
    data.answers[0].code = 'unknown' as never;
    const result = await execute(mutation, { input: data });
    expect(result.errors?.[0].extensions.code).toBe(
      'ASSESSMENT_ANSWER_INVALID',
    );
  });
  it.each(['adlTotalScore', 'careGroup'])(
    'does not accept client-derived %s in input',
    async (field) => {
      const result = await execute(mutation, {
        input: { ...input(), [field]: field === 'careGroup' ? 'SOCIAL' : 20 },
      });
      expect(result.errors).toHaveLength(1);
      expect(stored).toBeNull();
    },
  );
  it('returns nullable read + an access error without disclosing assessment state', async () => {
    actor = 'outsider';
    const result = await execute(
      'query Read($id: ID!) { careRecipientAssessment(careRecipientId: $id) { adlTotalScore } }',
      { id },
    );
    expect(result.data?.careRecipientAssessment).toBeNull();
    expect(result.errors?.[0].extensions).toEqual({
      code: 'ASSESSMENT_ACCESS_DENIED',
      statusCode: 403,
    });
  });
});
