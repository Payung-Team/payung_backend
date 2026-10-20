import { readFileSync } from 'fs';
import { join } from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import {
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
} from '@nestjs/graphql';
import { graphql, GraphQLObjectType, GraphQLSchema } from 'graphql';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { MatchingResolver } from './matching.resolver';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import {
  bookingEvidenceReferenceDate,
  matchingAdminContact,
} from './matching.policy';
import { MatchRejectReason } from './matching.evaluate';
describe('PYG-646 matching contract and boundaries', () => {
  let schema: GraphQLSchema;
  let m: TestingModule;
  const doc = readFileSync(
    join(__dirname, '../../docs/pyg-646-s18-matching-api-contract.md'),
    'utf8',
  );
  const oldContact = process.env.MATCHING_ADMIN_CONTACT_URL;
  beforeAll(async () => {
    m = await Test.createTestingModule({
      imports: [GraphQLSchemaBuilderModule],
    }).compile();
    schema = await m.get(GraphQLSchemaFactory).create([MatchingResolver]);
  });
  afterAll(async () => {
    await m?.close();
  });
  afterEach(() => {
    if (oldContact === undefined) delete process.env.MATCHING_ADMIN_CONTACT_URL;
    else process.env.MATCHING_ADMIN_CONTACT_URL = oldContact;
  });
  it('executes every successful JSON example with the actual generated schema and enum names', async () => {
    const queries = [...doc.matchAll(/```graphql\n([\s\S]*?)```/g)].map(
      (m) => m[1],
    );
    const examples = [...doc.matchAll(/```json\n([\s\S]*?)```/g)]
      .map((m) => JSON.parse(m[1]))
      .filter((v) => v.data);
    expect(examples).toHaveLength(4);
    expect(queries).toHaveLength(3);
    for (const example of examples) {
      const field = Object.keys(example.data)[0];
      const value = example.data[field];
      const root = JSON.parse(JSON.stringify(value));
      if (field === 'eligibleCaregivers')
        for (const c of root.caregivers)
          c.careLevel = c.careLevel.toLowerCase();
      if (field === 'bookingMatchReport') {
        root.evaluatedAt = new Date(root.evaluatedAt);
        root.evidenceReferenceDate = new Date(root.evidenceReferenceDate);
        for (const r of root.results)
          r.caregiver.careLevel = r.caregiver.careLevel.toLowerCase();
      }
      const result = await graphql({
        schema,
        source:
          queries[
            field === 'eligibleCaregivers'
              ? 0
              : field === 'bookingMatchReport'
                ? 1
                : 2
          ],
        rootValue: { [field]: root },
        variableValues: {
          bookingId: '11111111-1111-4111-8111-111111111111',
          caregiverId: '22222222-2222-4222-8222-222222222222',
        },
      });
      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual(example.data);
    }
  });
  it('Elder schema cannot select report/rejected counts or license details', async () => {
    const type = schema.getType('EligibleCaregivers') as GraphQLObjectType;
    expect(Object.keys(type.getFields()).sort()).toEqual([
      'adminContact',
      'caregivers',
      'emptyMessage',
    ]);
    const result = await graphql({
      schema,
      source:
        '{eligibleCaregivers(bookingId:"booking"){reasons filteredCount}}',
    });
    expect(result.errors).toHaveLength(2);
    const fields = (
      schema.getType('CaregiverSummary') as GraphQLObjectType
    ).getFields();
    for (const name of [
      'license',
      'expiresAt',
      'licenseNumber',
      'reasons',
      'evidence',
    ])
      expect(fields[name]).toBeUndefined();
    expect(String(fields.careLevel.type)).toBe('CareLevel');
    expect(Object.values(MatchRejectReason)).toEqual([
      'LEVEL_NOT_SET',
      'LEVEL_TOO_LOW',
      'SKILL_MISSING',
      'PROFESSION_MISMATCH',
      'EVIDENCE_NOT_APPROVED',
      'EVIDENCE_EXPIRED',
    ]);
  });
  it('guards every operation and separates Elder/selection from admin report roles', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, MatchingResolver)).toEqual([
      SupabaseAuthGuard,
      RolesGuard,
    ]);
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        MatchingResolver.prototype.eligibleCaregivers,
      ),
    ).toEqual([1]);
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        MatchingResolver.prototype.selectBookingCaregiver,
      ),
    ).toEqual([1]);
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        MatchingResolver.prototype.bookingMatchReport,
      ),
    ).toEqual([3, 4]);
  });
  it('derives Bangkok service day exclusively from SQL booking_date, not current time', () => {
    expect(
      bookingEvidenceReferenceDate(new Date('2035-10-20T00:00:00Z')),
    ).toEqual(new Date('2035-10-19T17:00:00Z'));
    expect(() => bookingEvidenceReferenceDate(new Date('invalid'))).toThrow(
      RangeError,
    );
  });
  it('uses configured HTTPS/tel contact only and has no invented account fallback', () => {
    delete process.env.MATCHING_ADMIN_CONTACT_URL;
    expect(matchingAdminContact()).toBeNull();
    for (const invalid of [
      'invalid',
      'javascript:alert(1)',
      'http://example.test',
    ]) {
      process.env.MATCHING_ADMIN_CONTACT_URL = invalid;
      expect(matchingAdminContact()).toBeNull();
    }
    for (const url of ['https://example.test/support', 'tel:+66000000000']) {
      process.env.MATCHING_ADMIN_CONTACT_URL = url;
      expect(matchingAdminContact()).toEqual({
        label: 'ติดต่อทีมงาน Payung',
        url,
      });
    }
  });
});
