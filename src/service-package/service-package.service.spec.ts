import { Logger } from '@nestjs/common';
import { ServicePackageService } from './service-package.service';
import { SERVICE_TYPE_LABELS } from './service-package.labels';

const ID = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
function mapping(code: string, types: string[], sortOrder = 0) {
  return {
    sortOrder,
    package: {
      id: `${code}-id`,
      code,
      nameTh: `ไทย ${code}`,
      nameEn: code,
      descriptionTh: null,
      descriptionEn: null,
      sortOrder: 0,
      items: types.map((serviceType, index) => ({
        serviceType,
        sortOrder: index,
      })),
    },
  };
}

describe('S14 ServicePackageService', () => {
  let service: ServicePackageService;
  let tx: {
    careRecipient: { findUnique: jest.Mock };
    familyGroupMember: { findMany: jest.Mock };
    careRecipientAssessment: { findUnique: jest.Mock };
    careGroupServicePackage: { findMany: jest.Mock };
  };
  let consent: { findWithdrawnType: jest.Mock };
  let transaction: jest.Mock;
  let warn: jest.SpyInstance;
  beforeEach(() => {
    tx = {
      careRecipient: {
        findUnique: jest.fn().mockResolvedValue({
          patientId: 'owner',
          is_deleted: false,
          familyGroupId: 'group',
        }),
      },
      familyGroupMember: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ userId: 'owner' }, { userId: 'relative' }]),
      },
      careRecipientAssessment: {
        findUnique: jest.fn().mockResolvedValue({ careGroup: 'social' }),
      },
      careGroupServicePackage: { findMany: jest.fn().mockResolvedValue([]) },
    };
    consent = { findWithdrawnType: jest.fn().mockResolvedValue(null) };
    transaction = jest.fn((fn: (value: typeof tx) => Promise<unknown>) =>
      fn(tx),
    );
    service = new ServicePackageService(
      { $transaction: transaction } as never,
      consent as never,
    );
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it.each([
    ['social', 'SOCIAL'],
    ['homebound', 'HOMEBOUND'],
    ['bedridden', 'BEDRIDDEN'],
  ])(
    'maps latest stored %s group to %s and queries only active matching rows/packages',
    async (stored, api) => {
      tx.careRecipientAssessment.findUnique.mockResolvedValue({
        careGroup: stored,
      });
      const result = await service.recommended('owner', ID);
      expect(result).toEqual({ careGroup: api, packages: [] });
      expect(tx.careGroupServicePackage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            careGroup: stored,
            isActive: true,
            package: { isActive: true },
          },
        }),
      );
      expect(tx.careRecipientAssessment.findUnique).toHaveBeenCalledWith({
        where: { careRecipientId: ID },
        select: { careGroup: true },
      });
      expect(tx.familyGroupMember.findMany).not.toHaveBeenCalled();
    },
  );
  it('returns null/[] for no assessment without querying packages', async () => {
    tx.careRecipientAssessment.findUnique.mockResolvedValue(null);
    expect(await service.recommended('owner', ID, 'general_care')).toEqual({
      careGroup: null,
      packages: [],
    });
    expect(tx.careGroupServicePackage.findMany).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
  it.each(['unknown', '', null])(
    'unknown stored group %s returns null/[] and a log without health values or IDs',
    async (careGroup) => {
      tx.careRecipientAssessment.findUnique.mockResolvedValue({ careGroup });
      expect(await service.recommended('owner', ID)).toEqual({
        careGroup: null,
        packages: [],
      });
      expect(warn).toHaveBeenCalledWith({
        event: 'service_packages.unknown_care_group',
      });
      expect(tx.careGroupServicePackage.findMany).not.toHaveBeenCalled();
    },
  );
  it('E6 keeps both bedridden packages with false/true and uses one include for all items', async () => {
    tx.careRecipientAssessment.findUnique.mockResolvedValue({
      careGroup: 'bedridden',
    });
    tx.careGroupServicePackage.findMany.mockResolvedValue([
      mapping('rehab_care', ['physiotherapy', 'general_care'], 20),
      mapping('bedridden_full', ['bedridden_care', 'medication'], 10),
    ]);
    const result = await service.recommended('owner', ID, 'physiotherapy');
    expect(
      result.packages.map((p) => [p.code, p.containsSelectedServiceType]),
    ).toEqual([
      ['bedridden_full', false],
      ['rehab_care', true],
    ]);
    expect(result.packages[1].items[0]).toEqual({
      serviceType: 'physiotherapy',
      ...SERVICE_TYPE_LABELS.physiotherapy,
    });
    expect(tx.careGroupServicePackage.findMany).toHaveBeenCalledTimes(1);
    expect(tx.careGroupServicePackage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          package: {
            include: {
              items: {
                orderBy: [{ sortOrder: 'asc' }, { serviceType: 'asc' }],
              },
            },
          },
        },
      }),
    );
    const calls = tx.careGroupServicePackage.findMany.mock.calls as [
      { where: Record<string, unknown> },
    ][];
    const call = calls[0][0];
    expect(JSON.stringify(call.where)).not.toContain('serviceType');
  });
  it.each([undefined, null])(
    'omitted/null selected type %s gives null rather than false, including empty packages',
    async (selected) => {
      tx.careGroupServicePackage.findMany.mockResolvedValue([
        mapping('empty', []),
        mapping('daily', ['general_care']),
      ]);
      expect(
        (await service.recommended('owner', ID, selected)).packages.map(
          (p) => p.containsSelectedServiceType,
        ),
      ).toEqual([null, null]);
    },
  );
  it('known selected type absent from a package, including empty items, gives false without filtering', async () => {
    tx.careGroupServicePackage.findMany.mockResolvedValue([
      mapping('empty', []),
      mapping('daily', ['general_care']),
    ]);
    const result = await service.recommended('owner', ID, 'physiotherapy');
    expect(result.packages).toHaveLength(2);
    expect(
      result.packages.every((p) => p.containsSelectedServiceType === false),
    ).toBe(true);
  });
  it('uses profile IDs independently for multiple recipients and re-reads groups on every request', async () => {
    tx.careRecipientAssessment.findUnique
      .mockResolvedValueOnce({ careGroup: 'social' })
      .mockResolvedValueOnce({ careGroup: 'bedridden' })
      .mockResolvedValueOnce({ careGroup: 'homebound' });
    expect((await service.recommended('owner', ID)).careGroup).toBe('SOCIAL');
    expect((await service.recommended('owner', SECOND)).careGroup).toBe(
      'BEDRIDDEN',
    );
    expect((await service.recommended('owner', ID)).careGroup).toBe(
      'HOMEBOUND',
    );
    expect(
      tx.careRecipientAssessment.findUnique.mock.calls.map(
        (call: [{ where: { careRecipientId: string } }]) =>
          call[0].where.careRecipientId,
      ),
    ).toEqual([ID, SECOND, ID]);
    expect(transaction).toHaveBeenCalledTimes(3);
  });
  it.each([
    null,
    { patientId: 'owner', is_deleted: true, familyGroupId: 'group' },
    { patientId: 'other', is_deleted: false, familyGroupId: null },
  ])(
    'denies missing, hidden and unrelated recipients without reading their group',
    async (recipient) => {
      tx.careRecipient.findUnique.mockResolvedValue(recipient);
      await expect(
        service.recommended('outsider', ID, 'bad-type'),
      ).rejects.toMatchObject({
        extensions: { code: 'ASSESSMENT_ACCESS_DENIED', statusCode: 403 },
      });
      expect(tx.careRecipientAssessment.findUnique).not.toHaveBeenCalled();
      expect(tx.careGroupServicePackage.findMany).not.toHaveBeenCalled();
    },
  );
  it('rejects a malformed profile ID before database reads', async () => {
    await expect(
      service.recommended('owner', 'account-id'),
    ).rejects.toMatchObject({
      extensions: { code: 'ASSESSMENT_ACCESS_DENIED' },
    });
    expect(tx.careRecipient.findUnique).not.toHaveBeenCalled();
  });
  it('allows active relatives through the shared S08 access check and checks the data owner consent', async () => {
    expect((await service.recommended('relative', ID)).careGroup).toBe(
      'SOCIAL',
    );
    expect(tx.familyGroupMember.findMany).toHaveBeenCalledWith({
      where: {
        groupId: 'group',
        userId: { in: ['relative', 'owner'] },
        status: 'ACTIVE',
      },
      select: { userId: true },
    });
    // ต้องอ่านผ่าน tx — pool บน Worker มี 1 connection ที่ transaction ถืออยู่
    expect(consent.findWithdrawnType).toHaveBeenCalledWith(
      'owner',
      ['disclose_to_family_group'],
      tx,
    );
  });
  it('denies inactive/departed relatives and duplicate membership rows', async () => {
    for (const members of [
      [{ userId: 'owner' }],
      [{ userId: 'relative' }],
      [{ userId: 'owner' }, { userId: 'owner' }],
    ]) {
      tx.familyGroupMember.findMany.mockResolvedValue(members);
      await expect(service.recommended('relative', ID)).rejects.toMatchObject({
        extensions: { code: 'ASSESSMENT_ACCESS_DENIED' },
      });
    }
    expect(tx.careRecipientAssessment.findUnique).not.toHaveBeenCalled();
  });
  it('denies relatives after family disclosure is withdrawn', async () => {
    consent.findWithdrawnType.mockResolvedValue('disclose_to_family_group');
    await expect(service.recommended('relative', ID)).rejects.toMatchObject({
      extensions: { code: 'ASSESSMENT_ACCESS_DENIED' },
    });
    expect(tx.careRecipientAssessment.findUnique).not.toHaveBeenCalled();
  });
  it.each(['', ' ', 'elderly_care', 'PHYSIOTHERAPY', 'unknown'])(
    'invalid selected type %j is BAD_USER_INPUT/422',
    async (selected) => {
      await expect(
        service.recommended('owner', ID, selected),
      ).rejects.toMatchObject({
        extensions: { code: 'BAD_USER_INPUT', statusCode: 422 },
      });
      expect(tx.careGroupServicePackage.findMany).not.toHaveBeenCalled();
    },
  );
  it('uses package order then ASCII code for ties, and item order then service code', async () => {
    const z = mapping('z', ['medication', 'companion']);
    z.package.items.forEach((item) => {
      item.sortOrder = 0;
    });
    const a = mapping('a', ['general_care']);
    tx.careGroupServicePackage.findMany.mockResolvedValue([z, a]);
    const result = await service.recommended('owner', ID);
    expect(result.packages.map((p) => p.code)).toEqual(['a', 'z']);
    expect(result.packages[1].items.map((item) => item.serviceType)).toEqual([
      'companion',
      'medication',
    ]);
  });
  it('invalid service metadata does not silently drop an item or inherit object properties', async () => {
    tx.careGroupServicePackage.findMany.mockResolvedValue([
      mapping('bad', ['__proto__']),
    ]);
    await expect(service.recommended('owner', ID)).rejects.toThrow(
      'ไม่สามารถอ่านชุดบริการที่แนะนำได้ในขณะนี้',
    );
  });
  it('keeps descriptions nullable and does not return internal fields', async () => {
    tx.careGroupServicePackage.findMany.mockResolvedValue([
      mapping('daily', ['general_care']),
    ]);
    const result = await service.recommended('owner', ID);
    expect(Object.keys(result.packages[0]).sort()).toEqual(
      [
        'id',
        'code',
        'nameTh',
        'nameEn',
        'descriptionTh',
        'descriptionEn',
        'containsSelectedServiceType',
        'items',
      ].sort(),
    );
    expect(result.packages[0].descriptionTh).toBeNull();
  });
  it('sanitizes database failures instead of returning success-empty or leaking query values', async () => {
    tx.careGroupServicePackage.findMany.mockRejectedValue(
      new Error('secret health query'),
    );
    await expect(service.recommended('owner', ID)).rejects.toThrow(
      'ไม่สามารถอ่านชุดบริการที่แนะนำได้ในขณะนี้',
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
