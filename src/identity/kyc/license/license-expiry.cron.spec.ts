/**
 * LicenseExpiryCron — ควบคุมเวลาได้ (PYG-587: AC7, E8)
 *
 * ใช้ in-memory fake ของ kyc_documents ที่ประเมิน where เหมือน DB (expires_at <= now, สถานะ) เพื่อพิสูจน์
 * พฤติกรรม "วันก่อนหมดอายุ / วันหมดอายุ / รันซ้ำ / รันช้าข้ามวัน" จริง ไม่ใช่แค่ assert ว่าเรียก mock
 */
import { LicenseExpiryCron } from './license-expiry.cron';

type Row = {
  id: string;
  reviewStatus: string | null;
  expiresAt: Date;
  documentType: string;
  profession: string;
  caregiverId: string | null;
  userId: string;
};

/** สิ้นวันเวลาไทยของวันที่ที่ระบุ (ค่าที่ DB เก็บจริง) */
const bkkEnd = (ymd: string) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() + 17 * 3600 * 1000 - 1);

function makeRow(over: Partial<Row> & { id: string }): Row {
  return {
    reviewStatus: 'approved',
    expiresAt: bkkEnd('2026-10-18'),
    documentType: 'professional_license',
    profession: 'nurse',
    caregiverId: 'cg-' + over.id,
    userId: 'user-' + over.id,
    ...over,
  };
}

describe('LicenseExpiryCron (PYG-587)', () => {
  let now: Date;
  let rows: Row[];
  let notifCreate: jest.Mock;
  let cron: LicenseExpiryCron;

  const inList = (v: any, x: any) => (v?.in ? v.in.includes(x) : true);

  function matches(r: Row, where: any): boolean {
    if (where.id && r.id !== where.id) return false;
    if (where.documentType && r.documentType !== where.documentType) return false;
    if (where.reviewStatus && !inList(where.reviewStatus, r.reviewStatus)) return false;
    if (where.expiresAt?.lte && !(r.expiresAt.getTime() <= where.expiresAt.lte.getTime())) return false;
    const prof = where.caregiver?.is?.profession;
    if (prof && (!r.caregiverId || !inList(prof, r.profession))) return false;
    return true;
  }

  beforeEach(() => {
    now = new Date('2026-10-19T17:05:00Z'); // 00:05 ไทยของ 20 ต.ค. (หลังสิ้นวันที่ 19)
    rows = [];
    notifCreate = jest.fn().mockResolvedValue({});

    const prisma = {
      kycDocument: {
        findMany: jest.fn(({ where, take }: any) =>
          Promise.resolve(
            rows
              .filter((r) => matches(r, where))
              .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())
              .slice(0, take)
              .map((r) => ({ id: r.id, caregiver: r.caregiverId ? { id: r.caregiverId, userId: r.userId } : null })),
          ),
        ),
        updateMany: jest.fn(({ where, data }: any) => {
          const hit = rows.filter((r) => matches(r, where));
          hit.forEach((r) => Object.assign(r, data));
          return Promise.resolve({ count: hit.length });
        }),
      },
    };

    cron = new LicenseExpiryCron(
      prisma as any,
      { now: () => now } as any,
      { create: notifCreate } as any,
    );
    jest.spyOn(cron['logger'], 'error').mockImplementation();
    jest.spyOn(cron['logger'], 'log').mockImplementation();
  });

  const status = (id: string) => rows.find((r) => r.id === id)?.reviewStatus;

  it('วันก่อนหมดอายุ: ใบที่หมดอายุพรุ่งนี้ (สิ้นวัน 20) ยังไม่ถูกแตะ ไม่แจ้งเตือน', async () => {
    rows = [makeRow({ id: 'a', expiresAt: bkkEnd('2026-10-20') })];
    const r = await cron.run();
    expect(r.expired).toBe(0);
    expect(status('a')).toBe('approved');
    expect(notifCreate).not.toHaveBeenCalled();
  });

  it('วันหมดอายุ: ก่อนสิ้นวันยังไม่ expired · พ้นสิ้นวันแล้ว → expired + แจ้งเตือน 1 ครั้ง', async () => {
    rows = [makeRow({ id: 'a', expiresAt: bkkEnd('2026-10-19') })];

    now = new Date('2026-10-19T16:59:59.998Z'); // ก่อนสิ้นวัน 1 มิลลิวินาที
    await cron.run();
    expect(status('a')).toBe('approved');

    now = new Date('2026-10-19T17:00:00.000Z'); // 00:00 ไทยของวันถัดไป
    const r = await cron.run();
    expect(r.expired).toBe(1);
    expect(status('a')).toBe('expired');
    expect(notifCreate).toHaveBeenCalledTimes(1);
    expect(notifCreate).toHaveBeenCalledWith(
      'user-a',
      'license_expired',
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ documentId: 'a' }),
    );
  });

  it('E8: รันซ้ำ (หรือรันซ้อน) → ไม่แจ้งเตือนซ้ำ', async () => {
    rows = [makeRow({ id: 'a' })];
    await cron.run();
    const second = await cron.run();
    expect(second.expired).toBe(0);
    expect(notifCreate).toHaveBeenCalledTimes(1);
  });

  it('E8: รันช้า/ข้ามไปหลายวัน → เก็บตกทุกใบที่หมดอายุในวันที่ไม่ได้รัน', async () => {
    rows = [
      makeRow({ id: 'd1', expiresAt: bkkEnd('2026-10-15') }),
      makeRow({ id: 'd2', expiresAt: bkkEnd('2026-10-17'), reviewStatus: 'pending' }),
      makeRow({ id: 'd3', expiresAt: bkkEnd('2026-10-19') }),
      makeRow({ id: 'future', expiresAt: bkkEnd('2026-10-25') }),
    ];
    const r = await cron.run();
    expect(r.expired).toBe(3);
    expect(['d1', 'd2', 'd3'].map(status)).toEqual(['expired', 'expired', 'expired']);
    expect(status('future')).toBe('approved');
    expect(notifCreate).toHaveBeenCalledTimes(3);
  });

  it('แถวที่ไม่ควรแตะ: expired แล้ว / rejected / ไม่ใช่ใบประกอบฯ / general_caregiver / ยังไม่ผูกผู้ดูแล', async () => {
    rows = [
      makeRow({ id: 'already', reviewStatus: 'expired' }),
      makeRow({ id: 'rej', reviewStatus: 'rejected' }),
      makeRow({ id: 'other', documentType: 'certificate' }),
      makeRow({ id: 'general', profession: 'general_caregiver' }),
      makeRow({ id: 'unlinked', caregiverId: null }),
    ];
    const r = await cron.run();
    expect(r.expired).toBe(0);
    expect(rows.map((x) => x.reviewStatus)).toEqual(['expired', 'rejected', 'approved', 'approved', 'approved']);
    expect(notifCreate).not.toHaveBeenCalled();
  });

  it('claim ได้ 0 แถว (แอดมินตัดสิน/รอบอื่นชนะก่อน) → ไม่แจ้งเตือน', async () => {
    rows = [makeRow({ id: 'a' })];
    const prisma = (cron as any).prisma;
    prisma.kycDocument.updateMany.mockResolvedValueOnce({ count: 0 });
    const r = await cron.run();
    expect(r.expired).toBe(0);
    expect(notifCreate).not.toHaveBeenCalled();
  });

  it('แจ้งเตือนล้ม: สถานะยังเป็น expired (ไม่ย้อน) · log · ใบอื่นทำต่อ · ไม่ส่งซ้ำรอบหน้า', async () => {
    rows = [makeRow({ id: 'a' }), makeRow({ id: 'b' })];
    notifCreate.mockRejectedValueOnce(new Error('enum license_expired missing'));
    const r = await cron.run();

    expect(r).toEqual({ expired: 2, notifyFailed: 1 });
    expect(status('a')).toBe('expired');
    expect(status('b')).toBe('expired');
    expect(cron['logger'].error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'license_expiry.notify_failed', documentId: 'a' }),
    );

    notifCreate.mockClear();
    await cron.run();
    expect(notifCreate).not.toHaveBeenCalled();
  });

  it('แถวหนึ่ง error ตอนอัปเดต → log แล้วทำแถวอื่นต่อ ไม่วนซ้ำไม่รู้จบ', async () => {
    rows = [makeRow({ id: 'a' }), makeRow({ id: 'b', expiresAt: bkkEnd('2026-10-19') })];
    const prisma = (cron as any).prisma;
    const original = prisma.kycDocument.updateMany.getMockImplementation();
    prisma.kycDocument.updateMany.mockImplementation((args: any) =>
      args.where.id === 'a' ? Promise.reject(new Error('db down')) : original(args),
    );
    const r = await cron.run();
    expect(r.expired).toBe(1);
    expect(status('a')).toBe('approved');
    expect(status('b')).toBe('expired');
  });

  it('ประมวลผลเกิน 1 batch (มากกว่า 100 แถว) ครบ', async () => {
    rows = Array.from({ length: 250 }, (_, i) => makeRow({ id: `r${i}` }));
    const r = await cron.run();
    expect(r.expired).toBe(250);
    expect(notifCreate).toHaveBeenCalledTimes(250);
  });
});
