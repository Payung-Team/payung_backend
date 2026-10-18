/**
 * JobTypeRemovalNotifier — แจ้งผู้ดูแลที่ประเภทงานถูกนำออก (PYG-592 AC6)
 * ใช้ fake notifications ที่เก็บของที่ส่งสำเร็จ แล้วให้ query "แจ้งไปแล้ว" อ่านกลับ เพื่อพิสูจน์ idempotency จริง
 */
import { JobTypeRemovalNotifier } from './job-type-removal-notifier';

interface Row { id: string; caregiver_id: string; user_id: string; job_type: string }

describe('JobTypeRemovalNotifier', () => {
  let tableExists: boolean;
  let removed: Row[];
  let stored: Array<{ userId: string; removedIds: string[]; type: string }>;
  let create: jest.Mock;
  let notifier: JobTypeRemovalNotifier;

  beforeEach(() => {
    tableExists = true;
    removed = [
      { id: 'r1', caregiver_id: 'cg-1', user_id: 'u1', job_type: 'physiotherapy' },
      { id: 'r2', caregiver_id: 'cg-2', user_id: 'u2', job_type: 'physiotherapy' },
      { id: 'r3', caregiver_id: 'cg-3', user_id: 'u3', job_type: 'physiotherapy' },
    ];
    stored = [];
    create = jest.fn(async (userId: string, type: string, _t: string, _b: string, data: any) => {
      stored.push({ userId, type, removedIds: data.removedIds });
      return {};
    });

    const prisma = {
      // 1) to_regclass  2) ids ที่แจ้งไปแล้ว
      $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
        const sql = strings.join('?');
        if (sql.includes('to_regclass')) return [{ t: tableExists ? 'caregiver_job_types_removed_pyg559' : null }];
        return stored.flatMap((s) => s.removedIds.map((id) => ({ id })));
      }),
      $queryRawUnsafe: jest.fn(async () => removed),
    };
    notifier = new JobTypeRemovalNotifier(prisma as never, { create } as never);
    jest.spyOn(notifier['logger'], 'error').mockImplementation();
    jest.spyOn(notifier['logger'], 'log').mockImplementation();
  });

  it('แจ้งครบทุกรายชื่อใน caregiver_job_types_removed_pyg559 (1 ฉบับต่อผู้ดูแล)', async () => {
    const r = await notifier.run();
    expect(r).toEqual({ notified: 3, failed: 0, skipped: 0 });
    expect(stored.map((s) => s.userId).sort()).toEqual(['u1', 'u2', 'u3']);
    expect(create).toHaveBeenCalledWith(
      'u1',
      'job_type_removed',
      expect.any(String),
      expect.stringContaining('กายภาพบำบัด'),
      expect.objectContaining({ removedIds: ['r1'], jobTypes: ['physiotherapy'], caregiverId: 'cg-1' }),
    );
  });

  it('รันซ้ำหลายครั้ง -> ไม่ส่งซ้ำ', async () => {
    await notifier.run();
    create.mockClear();
    const again = await notifier.run();
    expect(again).toEqual({ notified: 0, failed: 0, skipped: 3 });
    expect(create).not.toHaveBeenCalled();
  });

  it('ส่งไม่สำเร็จ: log + รอบถัดไปส่งซ้ำเฉพาะรายที่ยังไม่สำเร็จ', async () => {
    create.mockImplementationOnce(async () => { throw new Error('enum job_type_removed missing'); });
    const first = await notifier.run();
    expect(first).toEqual({ notified: 2, failed: 1, skipped: 0 });
    expect(notifier['logger'].error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'job_type_removal.notify_failed', userId: 'u1' }),
    );

    create.mockClear();
    const second = await notifier.run();
    expect(second).toEqual({ notified: 1, failed: 0, skipped: 2 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toBe('u1');
  });

  it('ผู้ดูแลที่มีหลายประเภทถูกนำออก -> รวมเป็นฉบับเดียว', async () => {
    removed = [
      { id: 'r1', caregiver_id: 'cg-1', user_id: 'u1', job_type: 'physiotherapy' },
      { id: 'r9', caregiver_id: 'cg-1', user_id: 'u1', job_type: 'medication' },
    ];
    await notifier.run();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][4].removedIds).toEqual(['r1', 'r9']);
  });

  it('แถวใหม่เข้ามาทีหลัง -> แจ้งเฉพาะแถวใหม่', async () => {
    await notifier.run();
    create.mockClear();
    removed.push({ id: 'r4', caregiver_id: 'cg-1', user_id: 'u1', job_type: 'medication' });
    const r = await notifier.run();
    expect(r.notified).toBe(1);
    expect(create.mock.calls[0][4].removedIds).toEqual(['r4']);
  });

  it('ตารางสำเนายังไม่ถูกสร้าง (migration ยังไม่รัน) -> ข้ามเงียบ ๆ ไม่ error', async () => {
    tableExists = false;
    const r = await notifier.run();
    expect(r).toEqual({ notified: 0, failed: 0, skipped: 0 });
    expect(create).not.toHaveBeenCalled();
    expect(notifier['logger'].error).not.toHaveBeenCalled();
  });

  it('อ่านตารางล้ม -> log แล้วจบ ไม่ throw', async () => {
    (notifier as any).prisma.$queryRaw = jest.fn().mockRejectedValue(new Error('db down'));
    await expect(notifier.run()).resolves.toEqual({ notified: 0, failed: 0, skipped: 0 });
    expect(notifier['logger'].error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'job_type_removal.load_failed' }),
    );
  });
});
