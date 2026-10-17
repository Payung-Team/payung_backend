import { AssessmentService } from './assessment.service';
import { ADL_ITEMS } from './assessment.constants';
import { PrismaService } from '../common/prisma.service';
import { ConsentService } from '../consent/consent.service';

const ID = '22222222-2222-4222-8222-222222222222';
const OWNER = 'owner';
const makeInput = () => ({
  careRecipientId: ID,
  answers: ADL_ITEMS.map(({ code }) => ({ code, value: 0 as number | null })),
  flags: [] as string[],
  noSpecialConditions: true,
});

describe('AssessmentService', () => {
  let service: AssessmentService;
  let prisma: any;
  let consent: any;
  beforeEach(() => {
    prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: ID }]),
      careRecipient: {
        findUnique: jest.fn().mockResolvedValue({
          patientId: OWNER,
          is_deleted: false,
          familyGroupId: null,
        }),
      },
      careRecipientAssessment: {
        upsert: jest.fn().mockImplementation(({ create }) => ({
          id: 'private-id',
          createdAt: new Date(),
          ...create,
        })),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      familyGroupMember: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ userId: OWNER }, { userId: 'relative' }]),
      },
    };
    prisma.$transaction = jest.fn((fn) => fn(prisma));
    consent = { findWithdrawnType: jest.fn().mockResolvedValue(null) };
    service = new AssessmentService(
      prisma as PrismaService,
      consent as ConsentService,
    );
  });
  it('upserts all derived fields atomically, uses server identity/time and returns only contract fields', async () => {
    const result = await service.submit(OWNER, makeInput());
    expect(result.adlTotalScore).toBe(0);
    expect(result.answers).toHaveLength(10);
    expect(result.assessedAt).toBeInstanceOf(Date);
    const call = prisma.careRecipientAssessment.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ careRecipientId: ID });
    expect(call.update).toMatchObject({
      assessedBy: OWNER,
      adlTotalScore: 0,
      unsureCount: 0,
      hasUnsureFlag: false,
      dementiaSevere: null,
    });
    expect(call.update.assessedAt).toEqual(call.update.updatedAt);
    expect(result).not.toHaveProperty('assessedBy');
    expect(result).not.toHaveProperty('id');
    expect(result).not.toHaveProperty('careGroup');
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.careRecipientAssessment.upsert.mock.invocationCallOrder[0],
    );
  });
  it('validates in the service before writing', async () => {
    await expect(
      service.submit(OWNER, { ...makeInput(), answers: [] }),
    ).rejects.toMatchObject({
      extensions: { code: 'ASSESSMENT_INCOMPLETE', statusCode: 422 },
    });
    expect(prisma.careRecipientAssessment.upsert).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { patientId: 'outsider', is_deleted: false },
    { patientId: OWNER, is_deleted: true },
  ])(
    'hides existence and status from unauthorized callers',
    async (recipient) => {
      prisma.careRecipient.findUnique.mockResolvedValue(recipient);
      await expect(service.read('relative', ID)).rejects.toMatchObject({
        extensions: { code: 'ASSESSMENT_ACCESS_DENIED', statusCode: 403 },
      });
      await expect(
        service.submit(OWNER, { ...makeInput(), answers: [] }),
      ).rejects.toMatchObject({
        extensions: { code: 'ASSESSMENT_ACCESS_DENIED', statusCode: 403 },
      });
      expect(prisma.careRecipientAssessment.findUnique).not.toHaveBeenCalled();
      expect(prisma.careRecipientAssessment.upsert).not.toHaveBeenCalled();
    },
  );
  it('rejects malformed IDs with the same access error before querying', async () => {
    await expect(service.read(OWNER, 'bad-id')).rejects.toMatchObject({
      extensions: { code: 'ASSESSMENT_ACCESS_DENIED' },
    });
    expect(prisma.careRecipient.findUnique).not.toHaveBeenCalled();
  });
  it('returns null only for an authorized profile without assessment', async () => {
    await expect(service.read(OWNER, ID)).resolves.toBeNull();
  });
  it('allows an ACTIVE family member to read a shared profile after consent checks', async () => {
    prisma.careRecipient.findUnique.mockResolvedValue({
      patientId: OWNER,
      familyGroupId: 'group',
      is_deleted: false,
    });
    await expect(service.read('relative', ID)).resolves.toBeNull();
    expect(consent.findWithdrawnType).toHaveBeenCalledWith(OWNER, [
      'disclose_to_family_group',
    ]);
    await expect(service.submit('relative', makeInput())).rejects.toMatchObject(
      { extensions: { code: 'ASSESSMENT_ACCESS_DENIED' } },
    );
  });
  it.each(['removed', 'withdrawn'])(
    'denies shared health access when %s',
    async (scenario) => {
      prisma.careRecipient.findUnique.mockResolvedValue({
        patientId: OWNER,
        familyGroupId: 'group',
        is_deleted: false,
      });
      if (scenario === 'removed')
        prisma.familyGroupMember.findMany.mockResolvedValue([
          { userId: OWNER },
        ]);
      else
        consent.findWithdrawnType.mockResolvedValue('disclose_to_family_group');
      await expect(service.read('relative', ID)).rejects.toMatchObject({
        extensions: { code: 'ASSESSMENT_ACCESS_DENIED' },
      });
      expect(prisma.careRecipientAssessment.findUnique).not.toHaveBeenCalled();
    },
  );
  it('does not report success on persistence failure', async () => {
    prisma.careRecipientAssessment.upsert.mockRejectedValue(
      new Error('database failure'),
    );
    await expect(service.submit(OWNER, makeInput())).rejects.toThrow(
      'ไม่สามารถดำเนินการกับแบบประเมินได้ในขณะนี้',
    );
  });
});
