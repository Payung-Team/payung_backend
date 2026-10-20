import { readFileSync } from 'fs';
import { join } from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import {
  Args,
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  ID,
  Query,
  Resolver,
} from '@nestjs/graphql';
import {
  graphql,
  GraphQLObjectType,
  GraphQLSchema,
  printSchema,
} from 'graphql';
import { BookingSummary } from '../dto/booking-summary.types';
import { CaregiverBookingSummary } from '../dto/caregiver-booking.types';
import { GroupBookingSummary } from '../../family-group/entities/group-booking.entity';
import {
  BookingLevelReader,
  BookingLevelResolver,
  CaregiverBookingLevelResolver,
  GroupBookingLevelResolver,
} from './booking-level.resolver';
import {
  bookingLevelForRest,
  readSavedBookingLevels,
} from './booking-level.read';
@Resolver()
class LevelQueries {
  @Query(() => BookingSummary) myBooking(
    @Args('id', { type: () => ID }) _id: string,
  ) {
    return {};
  }
  @Query(() => CaregiverBookingSummary) caregiverView() {
    return {};
  }
  @Query(() => GroupBookingSummary) groupView() {
    return {};
  }
}
describe('PYG-637 booking level contract', () => {
  let schema: GraphQLSchema;
  let moduleRef: TestingModule;
  let findMany: jest.Mock;
  let reader: BookingLevelReader;
  const timestamp = new Date('2026-10-20T08:00:00.000Z');
  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [GraphQLSchemaBuilderModule],
    }).compile();
    schema = await moduleRef
      .get(GraphQLSchemaFactory)
      .create([
        LevelQueries,
        BookingLevelResolver,
        CaregiverBookingLevelResolver,
        GroupBookingLevelResolver,
      ]);
    for (const [name, ResolverType] of [
      ['BookingSummary', BookingLevelResolver],
      ['CaregiverBookingSummary', CaregiverBookingLevelResolver],
      ['GroupBookingSummary', GroupBookingLevelResolver],
    ] as const) {
      for (const field of ['requiredLevel', 'levelBreakdown'] as const) {
        (schema.getType(name) as GraphQLObjectType).getFields()[field].resolve =
          (parent, _args, context) =>
            new ResolverType(reader)[field](parent as never, context as object);
      }
    }
  });
  afterAll(async () => {
    await moduleRef?.close();
  });
  beforeEach(() => {
    findMany = jest.fn();
    reader = new BookingLevelReader({ booking: { findMany } } as never);
  });
  const run = (source: string, id = 'booking') =>
    graphql({
      schema,
      source,
      contextValue: {},
      variableValues: { id },
      rootValue: {
        myBooking: { id },
        caregiverView: { id },
        groupView: { id },
      },
    });
  it('adds nullable snapshots on all booking views with one shared CareLevel enum', () => {
    const sdl = printSchema(schema);
    expect(sdl.match(/enum CareLevel \{/g)).toHaveLength(1);
    for (const name of [
      'BookingSummary',
      'CaregiverBookingSummary',
      'GroupBookingSummary',
    ]) {
      const fields = (schema.getType(name) as GraphQLObjectType).getFields();
      expect(String(fields.requiredLevel.type)).toBe('CareLevel');
      expect(String(fields.levelBreakdown.type)).toBe('BookingLevelBreakdown');
    }
    const fields = (
      schema.getType('BookingLevelBreakdown') as GraphQLObjectType
    ).getFields();
    expect(String(fields.adl.type)).toBe('CareLevel!');
    expect(String(fields.flags.type)).toBe('CareLevel');
    expect(String(fields.services.type)).toBe('CareLevel');
    expect(String(fields.calculatedAt.type)).toBe('DateTime!');
  });
  it('executes the query and all four successful responses directly from the contract', async () => {
    const doc = readFileSync(
      join(
        __dirname,
        '../../../docs/pyg-637-s16-booking-level-api-contract.md',
      ),
      'utf8',
    );
    const query = [...doc.matchAll(/```graphql\n([\s\S]*?)```/g)].find((m) =>
      m[1].includes('query BookingLevel'),
    )![1];
    const examples = [...doc.matchAll(/```json\n([\s\S]*?)```/g)]
      .map((m) => JSON.parse(m[1]))
      .filter((v) => v.data?.myBooking);
    expect(examples).toHaveLength(4);
    for (const expected of examples) {
      const booking = expected.data.myBooking;
      const breakdown = booking.levelBreakdown;
      findMany.mockResolvedValue([
        {
          id: booking.id,
          requiredLevel: booking.requiredLevel?.toLowerCase() ?? null,
          levelCalculatedAt: breakdown ? timestamp : null,
          levelFromAdl: breakdown?.adl.toLowerCase() ?? null,
          levelFromFlags: breakdown?.flags?.toLowerCase() ?? null,
          levelFromServices: breakdown?.services?.toLowerCase() ?? null,
        },
      ]);
      const result = await run(query, booking.id);
      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual(expected.data);
      const saved = (
        await readSavedBookingLevels({ booking: { findMany } } as never, [
          booking.id,
        ])
      ).get(booking.id)!;
      expect(JSON.parse(JSON.stringify(bookingLevelForRest(saved)))).toEqual({
        requiredLevel: booking.requiredLevel,
        levelBreakdown: booking.levelBreakdown,
      });
    }
  });
  it('batches both fields across authorized views without reading rules or assessment', async () => {
    findMany.mockResolvedValue([
      {
        id: 'booking',
        requiredLevel: 'basic',
        levelFromAdl: 'basic',
        levelFromFlags: null,
        levelFromServices: null,
        levelCalculatedAt: timestamp,
      },
    ]);
    const result = await run(
      '{myBooking(id:"booking"){requiredLevel levelBreakdown{adl}} caregiverView{requiredLevel levelBreakdown{flags}} groupView{requiredLevel levelBreakdown{services}}}',
    );
    expect(result.errors).toBeUndefined();
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where).toEqual({
      id: { in: ['booking'] },
    });
  });
  it('uses the calculation marker to distinguish legacy from computed no-effect', async () => {
    findMany.mockResolvedValue([
      {
        id: 'booking',
        requiredLevel: 'basic',
        levelFromAdl: 'basic',
        levelFromFlags: null,
        levelFromServices: null,
        levelCalculatedAt: null,
      },
    ]);
    expect(
      (
        await run(
          '{myBooking(id:"booking"){requiredLevel levelBreakdown{adl}}}',
        )
      ).data?.myBooking,
    ).toEqual({ requiredLevel: null, levelBreakdown: null });
  });
  it.each([null, 'unknown'])(
    'rejects corrupt computed snapshots (%s) rather than computing during reads',
    async (level) => {
      findMany.mockResolvedValue([
        {
          id: 'booking',
          requiredLevel: level,
          levelFromAdl: 'basic',
          levelFromFlags: null,
          levelFromServices: null,
          levelCalculatedAt: timestamp,
        },
      ]);
      const result = await run('{myBooking(id:"booking"){requiredLevel}}');
      expect(result.errors).toHaveLength(1);
    },
  );
});
