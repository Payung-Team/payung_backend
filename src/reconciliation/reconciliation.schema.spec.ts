/**
 * PYG-376 — GraphQL schema-build regression test.
 *
 * WHY THIS EXISTS: the recon object types are code-first (@nestjs/graphql, autoSchemaFile).
 * A nullable/array @Field without an explicit type thunk (e.g. `@Field({ nullable: true })`
 * on `string | null`) reflects as `Object` and throws `UndefinedTypeError` — but only at
 * RUNTIME schema build, which `tsc` / `nest build` do NOT catch and the service unit tests
 * miss (they never build the schema). That gap let PR #22 break app bootstrap on dev.
 *
 * This test builds the ACTUAL recon schema the same way the app does (GraphQLSchemaFactory),
 * so any future thunk-less nullable field fails here in CI instead of at a dev's boot.
 * Proven to fail on reintroduction: temporarily change any recon @Field(() => X, {nullable})
 * back to bare @Field({nullable:true}) → this test goes red.
 *
 * Hermetic: builds schema from resolver metadata only — no DB, no Omise, no network
 * (GraphQLSchemaFactory.create reads decorators; it does not instantiate providers).
 */
import { Test } from '@nestjs/testing';
import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from '@nestjs/graphql';
import { printSchema } from 'graphql';
import { ReconciliationResolver } from './reconciliation.resolver';

describe('Reconciliation GraphQL schema (build regression)', () => {
  // build the schema ONCE — GraphQLSchemaFactory registers types in a shared store, so a
  // second create() of the same resolvers throws "multiple types named ReconRow".
  let sdl: string;
  // exact trimmed SDL lines — array toContain is exact-match, so 'X: String' does NOT
  // match 'X: String!' → this asserts nullability (no `!`) precisely.
  let lines: string[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [GraphQLSchemaBuilderModule],
    }).compile();
    const factory = moduleRef.get(GraphQLSchemaFactory);
    // create() throws UndefinedTypeError if any field across ReconReport → ReconRow →
    // ReconFlag / ReconciliationReportInput lacks a valid type thunk. This IS the regression.
    sdl = printSchema(await factory.create([ReconciliationResolver]));
    lines = sdl.split('\n').map((l) => l.trim());
  });

  it('builds the recon schema without UndefinedTypeError (walks the whole object graph)', () => {
    expect(sdl).toContain('type ReconRow');
    expect(sdl).toContain('type ReconReport');
    expect(sdl).toContain('enum ReconFlag');
    expect(sdl).toContain('input ReconciliationReportInput');
  });

  it('nullable fields are typed (not reflection-erased) and stay nullable', () => {
    // the two fields that originally crashed — typed String, nullable (no `!`)
    expect(lines).toContain('omiseStatus: String');
    expect(lines).toContain('payoutStatus: String');
    // nullable money + enum
    expect(lines).toContain('capturedAmount: Float');
    expect(lines).toContain('primaryFlag: ReconFlag');
  });

  it('counts are Int, money is Float, arrays are typed lists', () => {
    expect(lines).toContain('totalRows: Int!');
    expect(lines).toContain('flaggedRows: Int!');
    expect(lines).toContain('unreachableRows: Int!');
    expect(lines).toContain('amount: Float!');
    expect(lines).toContain('reviewReasons: [String!]!');
    expect(lines).toContain('flags: [ReconFlag!]!');
  });
});
