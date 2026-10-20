import { assertBookingAssessment } from './assessment-booking-gate';

describe('booking assessment gate', () => {
  let tx: any;
  const id = '22222222-2222-4222-8222-222222222222';
  beforeEach(() => {
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id }]),
      careRecipientAssessment: {
        findUnique: jest.fn().mockResolvedValue({ id: 'assessment' }),
      },
    };
  });
  it('checks the resolved recipient, never the account or booker', async () => {
    await assertBookingAssessment(tx, id, 'graphql');
    expect(tx.careRecipientAssessment.findUnique).toHaveBeenCalledWith({
      where: { careRecipientId: id },
      select: { id: true },
    });
    expect(tx.$queryRaw.mock.calls[0][0].join('?')).toContain('FOR SHARE');
  });
  it('does not allow name-only booking to bypass the gate', async () => {
    await expect(
      assertBookingAssessment(tx, undefined, 'graphql'),
    ).rejects.toMatchObject({
      extensions: { code: 'ASSESSMENT_REQUIRED', statusCode: 422 },
    });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
  it('returns the agreed GraphQL error when assessment is missing', async () => {
    tx.careRecipientAssessment.findUnique.mockResolvedValue(null);
    await expect(
      assertBookingAssessment(tx, id, 'graphql'),
    ).rejects.toMatchObject({
      extensions: { code: 'ASSESSMENT_REQUIRED', statusCode: 422 },
    });
  });
  it('returns HTTP 422 with a domain code for REST', async () => {
    tx.careRecipientAssessment.findUnique.mockResolvedValue(null);
    try {
      await assertBookingAssessment(tx, id, 'rest');
      throw new Error('Expected failure');
    } catch (error) {
      expect(error.getStatus()).toBe(422);
      expect(error.getResponse()).toMatchObject({
        code: 'ASSESSMENT_REQUIRED',
        statusCode: 422,
      });
    }
  });
  it('rejects a profile hidden between permission check and booking', async () => {
    tx.$queryRaw.mockResolvedValue([]);
    await expect(
      assertBookingAssessment(tx, id, 'graphql'),
    ).rejects.toMatchObject({ extensions: { code: 'ASSESSMENT_REQUIRED' } });
    expect(tx.careRecipientAssessment.findUnique).not.toHaveBeenCalled();
  });
});
