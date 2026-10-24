import { maskEmail } from './mask-email';

describe('maskEmail (PYG-700)', () => {
  it.each([
    ['somchai@example.com', 's***@example.com'],
    ['a@b.co', 'a***@b.co'],
    [null, '(none)'],
    [undefined, '(none)'],
    ['', '(none)'],
    ['no-at-sign', '***'],
    ['@example.com', '***'],
  ])('%j → %j', (input, expected) => {
    expect(maskEmail(input)).toBe(expected);
  });
});
