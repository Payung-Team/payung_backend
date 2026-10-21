import { readFileSync } from 'fs';
import { join } from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import {
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
} from '@nestjs/graphql';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import {
  graphql,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLError,
  printSchema,
} from 'graphql';
import { RecommendedServicePackagesResolver } from './service-package.resolver';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';

const docs = readFileSync(
  join(
    __dirname,
    '../../docs/s14-recommended-service-packages-api-contract.md',
  ),
  'utf8',
);
const query = [...docs.matchAll(/```graphql\n([\s\S]*?)\n```/g)][1][1];
const examples: unknown[] = [...docs.matchAll(/```json\n([\s\S]*?)\n```/g)].map(
  (m) => JSON.parse(m[1]) as unknown,
);

describe('PYG-626 / PYG-628 GraphQL contract', () => {
  let moduleRef: TestingModule;
  let schema: GraphQLSchema;
  let recommended: jest.Mock;
  let resolver: RecommendedServicePackagesResolver;
  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [GraphQLSchemaBuilderModule],
    }).compile();
    schema = await moduleRef
      .get(GraphQLSchemaFactory)
      .create([RecommendedServicePackagesResolver]);
  });
  afterAll(async () => {
    await moduleRef.close();
  });
  beforeEach(() => {
    recommended = jest.fn();
    resolver = new RecommendedServicePackagesResolver({ recommended } as never);
  });
  function execute(variables: Record<string, unknown>, source = query) {
    return graphql({
      schema,
      source,
      variableValues: variables,
      rootValue: {
        recommendedServicePackages: (args: {
          careRecipientId: string;
          selectedServiceType?: string | null;
        }) =>
          resolver.recommendedServicePackages(
            { id: 'authenticated-actor' } as never,
            args.careRecipientId,
            args.selectedServiceType,
          ),
      },
    });
  }
  it('uses authentication and only exposes careRecipientId and the optional selected service argument', () => {
    const field = schema.getQueryType()!.getFields().recommendedServicePackages;
    expect(String(field.type)).toBe('RecommendedServicePackages!');
    expect(field.args.map((arg) => [arg.name, String(arg.type)])).toEqual([
      ['careRecipientId', 'ID!'],
      ['selectedServiceType', 'String'],
    ]);
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      RecommendedServicePackagesResolver,
    ) as unknown[];
    expect(guards).toContain(SupabaseAuthGuard);
    expect(schema.getMutationType()).toBeUndefined();
  });
  it('matches all agreed types and nullability using the existing ElderCareGroup enum', () => {
    const type = (name: string) =>
      (schema.getType(name) as GraphQLObjectType).getFields();
    expect(String(type('RecommendedServicePackages').careGroup.type)).toBe(
      'ElderCareGroup',
    );
    expect(String(type('RecommendedServicePackages').packages.type)).toBe(
      '[ServicePackage!]!',
    );
    expect(String(type('ServicePackage').items.type)).toBe(
      '[ServicePackageItem!]!',
    );
    expect(
      String(type('ServicePackage').containsSelectedServiceType.type),
    ).toBe('Boolean');
    expect(String(type('ServicePackage').descriptionTh.type)).toBe('String');
    expect(printSchema(schema)).not.toContain('packageId:');
  });
  it.each([0, 2, 4, 6, 8])(
    'executes the actual query and complete JSON response in contract example %i',
    async (index) => {
      const variables = examples[index] as Record<string, unknown>;
      const expected = examples[index + 1] as {
        data: { recommendedServicePackages: unknown };
      };
      recommended.mockResolvedValue(expected.data.recommendedServicePackages);
      const result = await execute(variables);
      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual(expected.data);
      expect(recommended).toHaveBeenCalledWith(
        'authenticated-actor',
        variables.careRecipientId,
        variables.selectedServiceType,
      );
    },
  );
  it('preserves explicit null, rather than using false as an argument default', async () => {
    recommended.mockResolvedValue({ careGroup: null, packages: [] });
    await execute({ careRecipientId: 'recipient', selectedServiceType: null });
    expect(recommended).toHaveBeenCalledWith(
      'authenticated-actor',
      'recipient',
      null,
    );
  });
  it('non-null root propagates the shared access code/403 without a success-empty result', async () => {
    recommended.mockRejectedValue(
      new GraphQLError('denied', {
        extensions: { code: 'ASSESSMENT_ACCESS_DENIED', statusCode: 403 },
      }),
    );
    const result = await execute({ careRecipientId: 'recipient' });
    expect(result.data).toBeNull();
    expect(result.errors?.[0].extensions).toEqual({
      code: 'ASSESSMENT_ACCESS_DENIED',
      statusCode: 403,
    });
    expect(result.errors?.[0].path).toEqual(['recommendedServicePackages']);
  });
  it('does not accept an actor ID supplied by the caller', async () => {
    const result = await execute(
      {},
      '{ recommendedServicePackages(careRecipientId: "recipient", actorId: "victim") { careGroup } }',
    );
    expect(result.errors?.[0].message).toContain('Unknown argument "actorId"');
    expect(recommended).not.toHaveBeenCalled();
  });
});
