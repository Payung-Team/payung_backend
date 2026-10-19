/**
 * TransportMode (PYG-661): map input ทั้ง 3 ทาง + input ขัดกัน + ป้ายฝั่ง Elder ตาม transport_mode (E2)
 */
import { Test } from '@nestjs/testing';
import { TransportMode, resolveTransport, toTransportMode } from './transport-mode';
import { DrivingLicenseService } from './driving-license.service';
import { PrismaService } from '../../../common/prisma.service';
import { ClockService } from '../../../common/clock.service';

describe('resolveTransport — map input', () => {
  describe('ทางที่ 1: ส่ง transportMode', () => {
    it('SELF_DRIVE → ต้องมีใบขับขี่ + เขียน self_drive', () => {
      expect(resolveTransport({ transportMode: TransportMode.SELF_DRIVE })).toEqual({
        selfDrive: true,
        write: TransportMode.SELF_DRIVE,
      });
    });
    it.each([[TransportMode.HIRED_RIDE], [TransportMode.NONE]])('%s → ไม่บังคับใบขับขี่ + เขียนค่านั้น', (mode) => {
      expect(resolveTransport({ transportMode: mode })).toEqual({ selfDrive: false, write: mode });
    });
  });

  describe('ทางที่ 2: ไม่ส่ง transportMode ใช้ selfDriveTransport เดิม', () => {
    it('true → ต้องมีใบ + เขียน self_drive', () => {
      expect(resolveTransport({ selfDriveTransport: true })).toEqual({
        selfDrive: true,
        write: TransportMode.SELF_DRIVE,
      });
    });
    it('false → ไม่บังคับใบ และ "ไม่เขียนค่า" (แยก hired_ride กับ none ไม่ได้ · E10)', () => {
      expect(resolveTransport({ selfDriveTransport: false })).toEqual({ selfDrive: false, write: undefined });
    });
  });

  describe('ทางที่ 3: ไม่ส่งสักตัว (client เก่า · E10)', () => {
    it('ไม่ตรวจ ไม่เขียน ไม่ตีความเป็น none', () => {
      expect(resolveTransport({})).toEqual({ selfDrive: undefined, write: undefined });
      expect(resolveTransport({ transportMode: null, selfDriveTransport: null })).toEqual({
        selfDrive: undefined,
        write: undefined,
      });
    });
  });

  describe('input ขัดกัน → TRANSPORT_MODE_CONFLICT (422)', () => {
    it.each([
      [TransportMode.SELF_DRIVE, false],
      [TransportMode.HIRED_RIDE, true],
      [TransportMode.NONE, true],
    ])('transportMode=%s กับ selfDriveTransport=%s', (mode, legacy) => {
      expect(() => resolveTransport({ transportMode: mode, selfDriveTransport: legacy })).toThrow(
        expect.objectContaining({
          extensions: expect.objectContaining({ code: 'TRANSPORT_MODE_CONFLICT', statusCode: 422 }),
        }),
      );
    });

    it.each([
      [TransportMode.SELF_DRIVE, true],
      [TransportMode.HIRED_RIDE, false],
      [TransportMode.NONE, false],
    ])('ส่งคู่กันแต่ตรงกัน (%s / %s) ไม่ขัด', (mode, legacy) => {
      expect(resolveTransport({ transportMode: mode, selfDriveTransport: legacy }).write).toBe(mode);
    });
  });
});

describe('toTransportMode', () => {
  it('แปลงค่าใน DB เป็น enum · NULL/ค่าแปลก → null (ไม่เดาเป็น NONE)', () => {
    expect(toTransportMode('self_drive')).toBe(TransportMode.SELF_DRIVE);
    expect(toTransportMode('hired_ride')).toBe(TransportMode.HIRED_RIDE);
    expect(toTransportMode('none')).toBe(TransportMode.NONE);
    expect(toTransportMode(null)).toBeNull();
    expect(toTransportMode(undefined)).toBeNull();
    expect(toTransportMode('flying')).toBeNull();
  });
});

describe('DrivingLicenseService.isVerified — ป้ายฝั่ง Elder ตาม transport_mode (E2)', () => {
  const endOfDay = (ymd: string) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() + 17 * 3600 * 1000 - 1);
  const NOW = new Date('2026-10-18T03:00:00Z');
  let service: DrivingLicenseService;
  let findMany: jest.Mock;

  const approved = () => [
    { id: 'd1', reviewStatus: 'approved', expiresAt: endOfDay('2026-12-31'), uploadedAt: new Date('2026-09-01') },
  ];

  beforeEach(async () => {
    findMany = jest.fn().mockResolvedValue(approved());
    const mod = await Test.createTestingModule({
      providers: [
        DrivingLicenseService,
        { provide: PrismaService, useValue: { kycDocument: { findMany } } },
        { provide: ClockService, useValue: { now: () => NOW } },
      ],
    }).compile();
    service = mod.get(DrivingLicenseService);
  });

  const owner = (transportMode: string | null) => ({ caregiverId: 'cg-1', userId: 'u1', transportMode });

  it.each([
    ['self_drive', true],
    [null, true], // NULL ถือตามใบที่มี (ยังไม่เคยตอบ)
    ['hired_ride', false],
    ['none', false],
  ])('ใบผ่าน + transport_mode = %s → ป้าย = %s', async (mode, expected) => {
    expect(await service.isVerified(owner(mode))).toBe(expected);
  });

  it.each([['self_drive'], [null]])('transport_mode = %s แต่ใบไม่ผ่าน/หมดอายุ → ไม่มีป้าย', async (mode) => {
    findMany.mockResolvedValue([{ ...approved()[0], expiresAt: endOfDay('2026-10-17') }]);
    expect(await service.isVerified(owner(mode))).toBe(false);
    findMany.mockResolvedValue([{ ...approved()[0], reviewStatus: 'pending' }]);
    expect(await service.isVerified(owner(mode))).toBe(false);
    findMany.mockResolvedValue([]);
    expect(await service.isVerified(owner(mode))).toBe(false);
  });

  it('เมื่อ transport_mode ไม่ใช่ self_drive ไม่ต้อง query ใบ (ตัดสินได้ทันที)', async () => {
    await service.isVerified(owner('none'));
    expect(findMany).not.toHaveBeenCalled();
  });

  it.each([['self_drive'], ['hired_ride'], ['none'], [null]])(
    'assertVerified (AC5) ไม่อ่าน transport_mode — ใบผ่านก็ผ่านเสมอ (mode = %s)',
    async (mode) => {
      // assertVerified รับแค่ { caregiverId, userId } จึงไม่มีทางอ่าน transport_mode
      await expect(service.assertVerified({ caregiverId: 'cg-1', userId: 'u1', ...(mode ? { mode } : {}) } as never)).resolves.toBeUndefined();
    },
  );

  it('assertVerified: ใบไม่ผ่าน → DRIVING_LICENSE_NOT_VERIFIED ไม่ว่า transport_mode เป็นอะไร', async () => {
    findMany.mockResolvedValue([]);
    await expect(service.assertVerified({ caregiverId: 'cg-1', userId: 'u1' })).rejects.toMatchObject({
      extensions: { code: 'DRIVING_LICENSE_NOT_VERIFIED' },
    });
  });
});
