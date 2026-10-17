import {
  classifyCareGroup,
  ElderCareGroup,
  storedCareGroupToApi,
} from './care-group';

describe('S09 care group', () => {
  it.each([
    ...[0, 1, 2, 3, 4].map((score) => [score, 'bedridden'] as const),
    ...[5, 6, 7, 8, 9, 10, 11].map((score) => [score, 'homebound'] as const),
    ...[12, 13, 14, 15, 16, 17, 18, 19, 20].map(
      (score) => [score, 'social'] as const,
    ),
  ])('classifies score %s as %s', (score, expected) => {
    expect(classifyCareGroup(score)).toBe(expected);
  });
  it.each([
    -1,
    21,
    0.5,
    4.5,
    11.5,
    NaN,
    Infinity,
    -Infinity,
    '12',
    null,
    undefined,
    false,
  ])('rejects invalid score %s without defaulting to a group', (score) => {
    expect(() => classifyCareGroup(score as number)).toThrow(RangeError);
  });
  it.each([
    ['social', ElderCareGroup.SOCIAL],
    ['homebound', ElderCareGroup.HOMEBOUND],
    ['bedridden', ElderCareGroup.BEDRIDDEN],
  ])('serializes stored %s to API %s', (stored, api) => {
    expect(storedCareGroupToApi(stored)).toBe(api);
  });
  it.each([null, undefined, '', 'unknown', 'SOCIAL'])(
    'does not guess legacy/invalid stored group %s',
    (value) => {
      expect(() => storedCareGroupToApi(value)).toThrow('readiness backfill');
    },
  );
});
