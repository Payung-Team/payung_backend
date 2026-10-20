import { Test, TestingModule } from '@nestjs/testing';
import {
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
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
import { CareSkillResolver } from '../../care-skill/care-skill.resolver';
import {
  RequiredSkillsReader,
  BookingRequiredSkillsResolver,
  CaregiverRequiredSkillsResolver,
  GroupRequiredSkillsResolver,
} from './required-skills.resolver';
import { readSavedRequiredSkills } from './required-skills.read';

@Resolver()
class ContractQueries {
  @Query(() => BookingSummary) myBooking() {
    return {};
  }
  @Query(() => CaregiverBookingSummary) caregiverView() {
    return {};
  }
  @Query(() => GroupBookingSummary) groupView() {
    return {};
  }
}

describe('S17 API contract', () => {
  let schema: GraphQLSchema;
  let moduleRef: TestingModule;
  let raw: jest.Mock;
  let reader: RequiredSkillsReader;
  const context = {};
  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [GraphQLSchemaBuilderModule],
    }).compile();
    schema = await moduleRef
      .get(GraphQLSchemaFactory)
      .create([
        ContractQueries,
        CareSkillResolver,
        BookingRequiredSkillsResolver,
        CaregiverRequiredSkillsResolver,
        GroupRequiredSkillsResolver,
      ]);
    for (const [type, ResolverType] of [
      ['BookingSummary', BookingRequiredSkillsResolver],
      ['CaregiverBookingSummary', CaregiverRequiredSkillsResolver],
      ['GroupBookingSummary', GroupRequiredSkillsResolver],
    ] as const) {
      (
        schema.getType(type) as GraphQLObjectType
      ).getFields().requiredSkills.resolve = (parent, _args, ctx) =>
        new ResolverType(reader).requiredSkills(parent as never, ctx as object);
    }
  });
  afterAll(async () => {
    await moduleRef?.close();
  });
  beforeEach(() => {
    raw = jest.fn().mockResolvedValue([]);
    reader = new RequiredSkillsReader({ $queryRaw: raw } as never);
  });
  const item = (code: string, sources: string[]) => ({
    code,
    nameTh: 'ไทย',
    nameEn: 'English',
    sources,
  });
  const query =
    '{ myBooking { id requiredSkills { skill { code nameTh nameEn lockedProfessions } sources } } }';
  const execute = (source = query) =>
    graphql({
      schema,
      source,
      contextValue: context,
      rootValue: {
        myBooking: { id: 'booking' },
        caregiverView: { id: 'booking' },
        groupView: { id: 'booking' },
      },
    });
  it('generates the agreed nullable lists, non-null members, and profession enum', () => {
    for (const type of [
      'BookingSummary',
      'CaregiverBookingSummary',
      'GroupBookingSummary',
    ]) {
      expect(
        String(
          (schema.getType(type) as GraphQLObjectType).getFields().requiredSkills
            .type,
        ),
      ).toBe('[BookingRequiredSkill!]');
    }
    const fields = (
      schema.getType('BookingRequiredSkill') as GraphQLObjectType
    ).getFields();
    expect(String(fields.skill.type)).toBe('CareSkillItem!');
    expect(String(fields.sources.type)).toBe('[RequiredSkillSource!]!');
    expect(
      String(
        (schema.getType('CareSkillItem') as GraphQLObjectType).getFields()
          .lockedProfessions.type,
      ),
    ).toBe('[CaregiverProfession!]!');
    expect(printSchema(schema)).toContain('  ADL\n  FLAG\n  SERVICE');
  });
  it.each([
    [null, [], null],
    [[], [], []],
    [
      ['physiotherapy'],
      [item('physiotherapy', ['service'])],
      [
        {
          skill: {
            code: 'physiotherapy',
            nameTh: 'ไทย',
            nameEn: 'English',
            lockedProfessions: ['physiotherapist'],
          },
          sources: ['SERVICE'],
        },
      ],
    ],
    [
      ['tube_feeding'],
      [item('tube_feeding', ['service', 'flag', 'flag'])],
      [
        {
          skill: {
            code: 'tube_feeding',
            nameTh: 'ไทย',
            nameEn: 'English',
            lockedProfessions: ['nurse'],
          },
          sources: ['FLAG', 'SERVICE'],
        },
      ],
    ],
  ])(
    'returns the contract shape for stored codes %j',
    async (codes, items, expected) => {
      raw.mockResolvedValue([{ id: 'booking', codes, items }]);
      const result = await execute();
      expect(result.errors).toBeUndefined();
      expect(result.data?.myBooking).toEqual({
        id: 'booking',
        requiredSkills: expected,
      });
    },
  );
  it('batches all authorized booking views and never reads rules/assessments', async () => {
    raw.mockResolvedValue([{ id: 'booking', codes: [], items: [] }]);
    const result = await execute(
      '{ myBooking { requiredSkills { sources } } caregiverView { requiredSkills { sources } } groupView { requiredSkills { sources } } }',
    );
    expect(result.errors).toBeUndefined();
    expect(raw).toHaveBeenCalledTimes(1);
  });
  it('does not treat a legacy null as [] even when the S16 timestamp exists', async () => {
    raw.mockResolvedValue([{ id: 'booking', codes: null, items: [] }]);
    expect((await execute()).data?.myBooking).toEqual({
      id: 'booking',
      requiredSkills: null,
    });
  });
  it('rejects inconsistent snapshots instead of silently dropping missing skills', async () => {
    raw.mockResolvedValue([
      { id: 'booking', codes: ['tube_feeding'], items: [] },
    ]);
    const result = await execute();
    expect(result.errors).toHaveLength(1);
    expect(result.errors?.[0].path).toEqual(['myBooking', 'requiredSkills']);
  });
  it('sorts codes and sources and includes unlicensed metadata as []', async () => {
    raw.mockResolvedValue([
      {
        id: 'booking',
        codes: ['tube_feeding', 'bathing'],
        items: [
          item('tube_feeding', ['service', 'adl']),
          item('bathing', ['adl']),
        ],
      },
    ]);
    const result = await readSavedRequiredSkills({ $queryRaw: raw } as never, [
      'booking',
    ]);
    expect(
      result
        .get('booking')
        ?.map((row) => [
          row.skill.code,
          row.skill.lockedProfessions,
          row.sources,
        ]),
    ).toEqual([
      ['bathing', [], ['ADL']],
      ['tube_feeding', ['nurse'], ['ADL', 'SERVICE']],
    ]);
  });
});
