/**
 * ProfessionChangeService — unit tests (PYG-575 · S01-AC6 · contract PYG-573 §4)
 *
 * ครอบคลุม:
 *  - request: verified เท่านั้น (E2 → สถานะอื่นใช้ฟอร์ม KYC) · ค่าผิด/ว่าง · ซ้ำค่าเดิม · pending ทีละ 1
 *    · วิชาชีพจริงไม่เปลี่ยนจนกว่าแอดมินอนุมัติ (Elder เห็นค่าเดิมระหว่างรอ)
 *  - cancel: เฉพาะของตัวเอง · เฉพาะ pending
 *  - approve: เปลี่ยน caregivers.profession + log "ในทรานแซคชันเดียวกัน"
 *  - reject: เหตุผลบังคับ · วิชาชีพคงเดิม
 *  - log ทุกแถวอยู่ใน caregiver_edit_logs รูป [{ field, oldValue, newValue, requestId, reason? }]
 *
 * วิธีเทส: ตาราง caregivers / caregiver_edit_logs เป็น array ในหน่วยความจำ
 *  - $executeRaw (INSERT) และ lockCaregiver (SELECT … FOR UPDATE) ทำงานกับ array ตรง ๆ
 *  - findRequests / countRequests (SQL ที่มี LATERAL + jsonb) ถูกแทนด้วย fakeFind ที่ทำความหมายเดียวกันใน TS
 *    ตัว SQL จริงทดสอบกับ Postgres ใน test/pyg575-profession-change.e2e-spec.ts
 */
import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ProfessionChangeService } from './profession-change.service';
import { PrismaService } from '../../common/prisma.service';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import {
  PROFESSION_CHANGE_ACTION,
  ProfessionChangeStatus,
} from './profession.constants';
import { ProfessionError } from './profession.errors';

// ─── ข้อมูลตั้งต้น ────────────────────────────────────────────────────────

const CAREGIVER_USER = {
  id: 'user-cg-1',
  email: 'cg@x.com',
  role: 2,
} as AuthUser;
const OTHER_USER = { id: 'user-cg-2', email: 'cg2@x.com', role: 2 } as AuthUser;
const ADMIN = { id: 'user-admin-1', email: 'admin@x.com', role: 3 } as AuthUser;

type CaregiverRow = {
  id: string;
  user_id: string;
  profession: string;
  kyc_status: string;
  caregiver_number: string;
  full_name: string;
};
type LogRow = {
  id: string;
  caregiver_id: string;
  edited_by: string;
  action: string;
  field_changes: Array<Record<string, unknown>>;
  created_at: Date;
};

const DECISIONS: string[] = [
  PROFESSION_CHANGE_ACTION.CANCEL,
  PROFESSION_CHANGE_ACTION.APPROVE,
  PROFESSION_CHANGE_ACTION.REJECT,
];
const STATUS_OF: Record<string, ProfessionChangeStatus> = {
  [PROFESSION_CHANGE_ACTION.CANCEL]: ProfessionChangeStatus.cancelled,
  [PROFESSION_CHANGE_ACTION.APPROVE]: ProfessionChangeStatus.approved,
  [PROFESSION_CHANGE_ACTION.REJECT]: ProfessionChangeStatus.rejected,
};

/** รูปของ mock — แยก tx ออกจาก prisma เพื่อเทสว่าการเขียนเกิด "ในทรานแซคชัน" */
type TxMock = {
  caregiver: { update: jest.Mock };
  $queryRaw: jest.Mock;
  $executeRaw: jest.Mock;
};
type PrismaMock = {
  caregiver: { findUnique: jest.Mock; update: jest.Mock };
  $queryRaw: jest.Mock;
  $executeRaw: jest.Mock;
  $transaction: jest.Mock;
};

describe('ProfessionChangeService (PYG-575)', () => {
  let service: ProfessionChangeService;
  let caregivers: CaregiverRow[];
  let logs: LogRow[];
  let clock: number;
  let prisma: PrismaMock;
  let tx: TxMock;

  /** ผู้ดูแลที่ล็อกอิน — ค่าเริ่ม: verified + general_caregiver (เหมือนผู้ดูแลเดิมหลัง migration) */
  function seedCaregiver(overrides: Partial<CaregiverRow> = {}): CaregiverRow {
    const row: CaregiverRow = {
      id: `cg-${caregivers.length + 1}`,
      user_id: CAREGIVER_USER.id,
      profession: 'general_caregiver',
      kyc_status: 'verified',
      caregiver_number: `CG-261017-000${caregivers.length + 1}`,
      full_name: 'สมใจ ใจดี',
      ...overrides,
    };
    caregivers.push(row);
    return row;
  }

  /** INSERT จริงของ service: $executeRaw`…VALUES (${id}::uuid, ${caregiverId}, ${editedBy}, ${action}, ${json}::jsonb, …)` */
  function fakeExecuteRaw(
    _strings: TemplateStringsArray,
    ...values: unknown[]
  ) {
    const [id, caregiverId, editedBy, action, json] = values as string[];
    logs.push({
      id,
      caregiver_id: caregiverId,
      edited_by: editedBy,
      action,
      field_changes: JSON.parse(json) as LogRow['field_changes'],
      created_at: new Date(Date.UTC(2026, 9, 17, 0, 0, clock++)), // เวลาเดินหน้าทุกแถว
    });
    return Promise.resolve(1);
  }

  /** lockCaregiver: SELECT id, profession, kyc_status FROM caregivers WHERE <user_id|id = ?> FOR UPDATE */
  function fakeQueryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    const sql = strings.join('?');
    if (!sql.includes('FOR UPDATE'))
      throw new Error(`unexpected $queryRaw in unit test: ${sql}`);
    const where = values[0] as { strings: string[]; values: unknown[] };
    const byUser = where.strings.join('?').includes('user_id');
    const key = where.values[0];
    const rows = caregivers
      .filter((c) => (byUser ? c.user_id === key : c.id === key))
      .map(({ id, profession, kyc_status }) => ({
        id,
        profession,
        kyc_status,
      }));
    return Promise.resolve(rows);
  }

  /** ความหมายเดียวกับ findRequests (SQL) — ทำบน array */
  function fakeFind(
    _db: unknown,
    opts: {
      caregiverId?: string;
      requestId?: string;
      status?: ProfessionChangeStatus;
      order?: string;
      limit?: number;
      offset?: number;
    },
  ) {
    let rows = logs
      .filter((r) => r.action === PROFESSION_CHANGE_ACTION.REQUEST)
      .filter((r) => !opts.caregiverId || r.caregiver_id === opts.caregiverId)
      .filter((r) => !opts.requestId || r.id === opts.requestId)
      .map((r) => {
        const d = logs
          .filter(
            (x) =>
              x.caregiver_id === r.caregiver_id &&
              DECISIONS.includes(x.action) &&
              x.field_changes.some((e) => e.requestId === r.id),
          )
          .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())[0];
        const cg = caregivers.find((c) => c.id === r.caregiver_id)!;
        const reviewed =
          d &&
          (d.action === PROFESSION_CHANGE_ACTION.APPROVE ||
            d.action === PROFESSION_CHANGE_ACTION.REJECT);
        return {
          id: r.id,
          caregiver_id: r.caregiver_id,
          field_changes: r.field_changes,
          requested_at: r.created_at,
          decision_action: d?.action ?? null,
          decision_changes: d?.field_changes ?? null,
          decided_at: d?.created_at ?? null,
          caregiver_number: cg.caregiver_number,
          caregiver_name: cg.full_name,
          reviewer_name: reviewed ? `แอดมิน ${d.edited_by}` : null,
        };
      });

    if (opts.status === ProfessionChangeStatus.pending)
      rows = rows.filter((r) => r.decision_action === null);
    else if (opts.status)
      rows = rows.filter(
        (r) =>
          r.decision_action && STATUS_OF[r.decision_action] === opts.status,
      );

    const t = (d: Date | null) => d?.getTime() ?? 0;
    if (opts.order === 'queue')
      rows.sort((a, b) => t(a.requested_at) - t(b.requested_at));
    else if (opts.order === 'decided')
      rows.sort((a, b) => t(b.decided_at) - t(a.decided_at));
    else rows.sort((a, b) => t(b.requested_at) - t(a.requested_at));

    const offset = opts.offset ?? 0;
    return Promise.resolve(rows.slice(offset, offset + (opts.limit ?? 50)));
  }

  function fakeCount(status: ProfessionChangeStatus) {
    return fakeFind(null, { status, limit: 1000 }).then((rows) => rows.length);
  }

  /** เรียกแล้วคืน error ที่โยนออกมา — เทสต้องการดู extensions.code */
  async function errorOf(promise: Promise<unknown>): Promise<ProfessionError> {
    try {
      await promise;
    } catch (err) {
      return err as ProfessionError;
    }
    throw new Error('ควร throw');
  }

  const requestLogs = () =>
    logs.filter((l) => l.action === PROFESSION_CHANGE_ACTION.REQUEST);

  beforeEach(async () => {
    caregivers = [];
    logs = [];
    clock = 0;

    // tx แยก object จาก prisma — เทสได้ว่าการเขียนเกิด "ในทรานแซคชัน" จริง
    tx = {
      caregiver: {
        update: jest.fn(
          ({
            where,
            data,
          }: {
            where: { id: string };
            data: { profession: string };
          }) => {
            const row = caregivers.find((c) => c.id === where.id)!;
            row.profession = data.profession;
            return Promise.resolve(row);
          },
        ),
      },
      $queryRaw: jest.fn(fakeQueryRaw),
      $executeRaw: jest.fn(fakeExecuteRaw),
    };
    prisma = {
      caregiver: {
        findUnique: jest.fn(({ where }: { where: { userId: string } }) =>
          Promise.resolve(
            caregivers.find((c) => c.user_id === where.userId) ?? null,
          ),
        ),
        update: jest.fn(),
      },
      $queryRaw: jest.fn(fakeQueryRaw),
      $executeRaw: jest.fn(),
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProfessionChangeService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(ProfessionChangeService);

    // method private ของ service ที่มี SQL จริง — แทนด้วยตัวทำความหมายเดียวกันบน array
    const internals = service as unknown as {
      findRequests: typeof fakeFind;
      countRequests: typeof fakeCount;
    };
    jest.spyOn(internals, 'findRequests').mockImplementation(fakeFind);
    jest.spyOn(internals, 'countRequests').mockImplementation(fakeCount);
  });

  // ─── requestChange ────────────────────────────────────────────────────

  describe('requestProfessionChange', () => {
    it('AC6: verified ขอเปลี่ยน → pending · วิชาชีพจริงยังเป็นค่าเดิม (Elder เห็นค่าเดิมระหว่างรอ)', async () => {
      const cg = seedCaregiver();

      const result = await service.requestChange(CAREGIVER_USER, {
        profession: 'nurse',
      });

      expect(result).toMatchObject({
        caregiverId: cg.id,
        fromProfession: 'general_caregiver',
        toProfession: 'nurse',
        status: 'pending',
        licenseNumber: null,
        licenseExpiresAt: null,
        licenseDocument: null,
        rejectionReason: null,
        reviewedAt: null,
      });
      expect(cg.profession).toBe('general_caregiver');
      expect(tx.caregiver.update).not.toHaveBeenCalled();
    });

    it('บันทึกลง caregiver_edit_logs รูปเดียวกับ computeFieldChanges + requestId = id ของแถวตัวเอง', async () => {
      const cg = seedCaregiver();

      const result = await service.requestChange(CAREGIVER_USER, {
        profession: 'physiotherapist',
      });

      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        id: result.id,
        caregiver_id: cg.id,
        edited_by: CAREGIVER_USER.id,
        action: 'profession_change_request',
        field_changes: [
          {
            field: 'profession',
            oldValue: '"general_caregiver"',
            newValue: '"physiotherapist"',
            requestId: result.id,
          },
        ],
      });
    });

    it('ล็อกแถวของ "ผู้ใช้ที่ล็อกอิน" ด้วย FOR UPDATE — ไม่มีช่องให้ส่ง caregiverId ของคนอื่น', async () => {
      seedCaregiver();

      await service.requestChange(CAREGIVER_USER, { profession: 'nurse' });

      const [strings, where] = tx.$queryRaw.mock.calls[0] as [
        TemplateStringsArray,
        { strings: string[]; values: unknown[] },
      ];
      expect(strings.join('?')).toContain('FOR UPDATE');
      expect(where.strings.join('?')).toContain('user_id');
      expect(where.values).toEqual([CAREGIVER_USER.id]);
    });

    it.each([
      ['', 'PROFESSION_REQUIRED'],
      ['  ', 'PROFESSION_REQUIRED'],
      ['doctor', 'PROFESSION_INVALID'],
      ['Nurse', 'PROFESSION_INVALID'],
    ])('ค่า "%s" → %s ก่อนเปิดทรานแซคชัน', async (value, code) => {
      seedCaregiver();

      const err = await errorOf(
        service.requestChange(CAREGIVER_USER, { profession: value }),
      );

      expect(err).toBeInstanceOf(ProfessionError);
      expect(err.extensions.code).toBe(code);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it.each(['pending', 'rejected', 'none'])(
      'E2: kycStatus = %s → PROFESSION_CHANGE_NOT_ALLOWED (ใช้ฟอร์ม KYC แทน) และไม่มี log',
      async (kycStatus) => {
        seedCaregiver({ kyc_status: kycStatus });

        const err = await errorOf(
          service.requestChange(CAREGIVER_USER, { profession: 'nurse' }),
        );

        expect(err.extensions).toEqual({
          code: 'PROFESSION_CHANGE_NOT_ALLOWED',
          kycStatus,
        });
        expect(logs).toHaveLength(0);
      },
    );

    it('ยังไม่มีแถว caregivers → PROFESSION_CHANGE_NOT_ALLOWED + kycStatus none', async () => {
      const err = await errorOf(
        service.requestChange(CAREGIVER_USER, { profession: 'nurse' }),
      );

      expect(err.extensions).toEqual({
        code: 'PROFESSION_CHANGE_NOT_ALLOWED',
        kycStatus: 'none',
      });
    });

    it('ขอเป็นค่าเดิม → PROFESSION_UNCHANGED', async () => {
      seedCaregiver({ profession: 'nurse' });

      const err = await errorOf(
        service.requestChange(CAREGIVER_USER, { profession: 'nurse' }),
      );

      expect(err.extensions).toEqual({
        code: 'PROFESSION_UNCHANGED',
        profession: 'nurse',
      });
      expect(logs).toHaveLength(0);
    });

    it('มีคำขอ pending อยู่แล้ว → PROFESSION_CHANGE_ALREADY_PENDING + requestId ของคำขอเดิม (pending ทีละ 1)', async () => {
      seedCaregiver();
      const first = await service.requestChange(CAREGIVER_USER, {
        profession: 'nurse',
      });

      const err = await errorOf(
        service.requestChange(CAREGIVER_USER, {
          profession: 'physiotherapist',
        }),
      );

      expect(err.extensions).toEqual({
        code: 'PROFESSION_CHANGE_ALREADY_PENDING',
        requestId: first.id,
      });
      expect(requestLogs()).toHaveLength(1);
    });

    it('คำขอเดิมจบแล้ว (ยกเลิก) → ขอใหม่ได้ และ myProfessionChangeRequest คืนใบล่าสุด', async () => {
      seedCaregiver();
      const first = await service.requestChange(CAREGIVER_USER, {
        profession: 'nurse',
      });
      await service.cancel(CAREGIVER_USER, first.id);

      const second = await service.requestChange(CAREGIVER_USER, {
        profession: 'physiotherapist',
      });
      const mine = await service.myRequest(CAREGIVER_USER);

      expect(second.id).not.toBe(first.id);
      expect(mine).toMatchObject({
        id: second.id,
        toProfession: 'physiotherapist',
        status: 'pending',
      });
    });
  });

  // ─── cancel ───────────────────────────────────────────────────────────

  describe('cancelProfessionChangeRequest', () => {
    it('ยกเลิกคำขอของตัวเอง → cancelled · reviewedAt = null (ไม่ใช่การตรวจของแอดมิน) · วิชาชีพคงเดิม', async () => {
      const cg = seedCaregiver();
      const req = await service.requestChange(CAREGIVER_USER, {
        profession: 'nurse',
      });

      const result = await service.cancel(CAREGIVER_USER, req.id);

      expect(result).toMatchObject({
        id: req.id,
        status: 'cancelled',
        reviewedAt: null,
      });
      expect(cg.profession).toBe('general_caregiver');
      expect(logs[1]).toMatchObject({
        action: 'profession_change_cancel',
        edited_by: CAREGIVER_USER.id,
        field_changes: [expect.objectContaining({ requestId: req.id })],
      });
    });

    it('id ของผู้ดูแลคนอื่น → PROFESSION_CHANGE_NOT_FOUND (ตอบเหมือนไม่มีอยู่ — ไม่บอกว่ามี)', async () => {
      seedCaregiver();
      seedCaregiver({ user_id: OTHER_USER.id });
      const othersRequest = await service.requestChange(OTHER_USER, {
        profession: 'nurse',
      });

      const err = await errorOf(
        service.cancel(CAREGIVER_USER, othersRequest.id),
      );

      expect(err.extensions).toEqual({ code: 'PROFESSION_CHANGE_NOT_FOUND' });
      expect(logs).toHaveLength(1); // ไม่มีแถว cancel
    });

    it('id ที่ไม่มีอยู่ / ผู้ใช้ไม่มีแถว caregivers → PROFESSION_CHANGE_NOT_FOUND', async () => {
      expect(
        (await errorOf(service.cancel(CAREGIVER_USER, 'no-such-id'))).extensions
          .code,
      ).toBe('PROFESSION_CHANGE_NOT_FOUND');
      seedCaregiver();
      expect(
        (await errorOf(service.cancel(CAREGIVER_USER, 'no-such-id'))).extensions
          .code,
      ).toBe('PROFESSION_CHANGE_NOT_FOUND');
    });

    it('ยกเลิกซ้ำ → PROFESSION_CHANGE_NOT_PENDING + status ปัจจุบัน', async () => {
      seedCaregiver();
      const req = await service.requestChange(CAREGIVER_USER, {
        profession: 'nurse',
      });
      await service.cancel(CAREGIVER_USER, req.id);

      const err = await errorOf(service.cancel(CAREGIVER_USER, req.id));

      expect(err.extensions).toEqual({
        code: 'PROFESSION_CHANGE_NOT_PENDING',
        status: 'cancelled',
      });
    });
  });

  // ─── approve ──────────────────────────────────────────────────────────

  describe('approveProfessionChangeRequest', () => {
    it('AC6: อนุมัติ → caregivers.profession เปลี่ยน + log approve ในทรานแซคชันเดียวกัน', async () => {
      const cg = seedCaregiver();
      const req = await service.requestChange(CAREGIVER_USER, {
        profession: 'nurse',
      });

      const result = await service.approve(ADMIN, req.id);

      expect(result).toMatchObject({
        id: req.id,
        status: 'approved',
        fromProfession: 'general_caregiver',
        toProfession: 'nurse',
      });
      expect(result.reviewedAt).toBeInstanceOf(Date);
      expect(cg.profession).toBe('nurse');
      // เขียนผ่าน tx ทั้งคู่ — ไม่มีการเขียนนอกทรานแซคชัน
      expect(tx.caregiver.update).toHaveBeenCalledWith({
        where: { id: cg.id },
        data: { profession: 'nurse' },
      });
      expect(prisma.caregiver.update).not.toHaveBeenCalled();
      expect(logs[1]).toMatchObject({
        action: 'profession_change_approve',
        edited_by: ADMIN.id,
        field_changes: [
          {
            field: 'profession',
            oldValue: '"general_caregiver"',
            newValue: '"nurse"',
            requestId: req.id,
          },
        ],
      });
    });

    it('ล็อกแถวผู้ดูแลเจ้าของคำขอ (by id) ก่อนอ่านสถานะซ้ำ', async () => {
      const cg = seedCaregiver();
      const req = await service.requestChange(CAREGIVER_USER, {
        profession: 'nurse',
      });
      tx.$queryRaw.mockClear();

      await service.approve(ADMIN, req.id);

      const where = (tx.$queryRaw.mock.calls[0] as unknown[])[1] as {
        strings: string[];
        values: unknown[];
      };
      expect(where.strings.join('?')).not.toContain('user_id');
      expect(where.values).toEqual([cg.id]);
    });

    it('ไม่พบ id → PROFESSION_CHANGE_NOT_FOUND', async () => {
      const err = await errorOf(service.approve(ADMIN, 'no-such-id'));

      expect(err.extensions).toEqual({ code: 'PROFESSION_CHANGE_NOT_FOUND' });
    });

    it.each([
      ['ผู้ดูแลยกเลิกไปแล้ว', 'cancelled'],
      ['อนุมัติไปแล้ว (กดซ้ำ / แอดมินสองคน)', 'approved'],
    ])(
      '%s → PROFESSION_CHANGE_NOT_PENDING และวิชาชีพไม่ถูกเขียนซ้ำ',
      async (_label, status) => {
        seedCaregiver();
        const req = await service.requestChange(CAREGIVER_USER, {
          profession: 'nurse',
        });
        if (status === 'cancelled')
          await service.cancel(CAREGIVER_USER, req.id);
        else await service.approve(ADMIN, req.id);
        tx.caregiver.update.mockClear();

        const err = await errorOf(service.approve(ADMIN, req.id));

        expect(err.extensions).toEqual({
          code: 'PROFESSION_CHANGE_NOT_PENDING',
          status,
        });
        expect(tx.caregiver.update).not.toHaveBeenCalled();
      },
    );
  });

  // ─── reject ───────────────────────────────────────────────────────────

  describe('rejectProfessionChangeRequest', () => {
    it('ปฏิเสธ → rejected + rejectionReason · วิชาชีพคงเดิม · log มี reason', async () => {
      const cg = seedCaregiver();
      const req = await service.requestChange(CAREGIVER_USER, {
        profession: 'nurse',
      });

      const result = await service.reject(ADMIN, {
        id: req.id,
        reason: '  ภาพใบประกอบฯ ไม่ชัด  ',
      });

      expect(result).toMatchObject({
        status: 'rejected',
        rejectionReason: 'ภาพใบประกอบฯ ไม่ชัด',
      });
      expect(result.reviewedAt).toBeInstanceOf(Date);
      expect(cg.profession).toBe('general_caregiver');
      expect(tx.caregiver.update).not.toHaveBeenCalled();
      expect(logs[1]).toMatchObject({
        action: 'profession_change_reject',
        edited_by: ADMIN.id,
        field_changes: [
          expect.objectContaining({
            requestId: req.id,
            reason: 'ภาพใบประกอบฯ ไม่ชัด',
          }),
        ],
      });
    });

    it('เหตุผลมีแต่ช่องว่าง → BadRequestException ก่อนแตะ DB', async () => {
      seedCaregiver();
      const req = await service.requestChange(CAREGIVER_USER, {
        profession: 'nurse',
      });
      prisma.$transaction.mockClear();

      await expect(
        service.reject(ADMIN, { id: req.id, reason: '   ' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('ปฏิเสธแล้วผู้ดูแลขอใหม่ได้', async () => {
      seedCaregiver();
      const req = await service.requestChange(CAREGIVER_USER, {
        profession: 'nurse',
      });
      await service.reject(ADMIN, { id: req.id, reason: 'ไม่ชัด' });

      const again = await service.requestChange(CAREGIVER_USER, {
        profession: 'nurse',
      });

      expect(again.status).toBe('pending');
    });
  });

  // ─── reads ────────────────────────────────────────────────────────────

  describe('myProfessionChangeRequest', () => {
    it('ไม่มีแถว caregivers / ไม่เคยขอ → null', async () => {
      expect(await service.myRequest(CAREGIVER_USER)).toBeNull();
      seedCaregiver();
      expect(await service.myRequest(CAREGIVER_USER)).toBeNull();
    });

    it('เห็นเฉพาะคำขอของตัวเอง', async () => {
      seedCaregiver();
      seedCaregiver({ user_id: OTHER_USER.id });
      await service.requestChange(OTHER_USER, { profession: 'nurse' });

      expect(await service.myRequest(CAREGIVER_USER)).toBeNull();
    });
  });

  describe('adminProfessionChangeRequests', () => {
    it('default = pending เรียงยื่นเก่าสุดก่อน + ข้อมูลผู้ดูแล', async () => {
      seedCaregiver();
      seedCaregiver({ user_id: OTHER_USER.id, full_name: 'สมหญิง' });
      const a = await service.requestChange(CAREGIVER_USER, {
        profession: 'nurse',
      });
      const b = await service.requestChange(OTHER_USER, {
        profession: 'physiotherapist',
      });

      const page = await service.adminList({});

      expect(page).toMatchObject({ total: 2, page: 1, totalPages: 1 });
      expect(page.items.map((i) => i.id)).toEqual([a.id, b.id]);
      expect(page.items[1]).toMatchObject({
        caregiverName: 'สมหญิง',
        caregiverNumber: 'CG-261017-0002',
        reviewerName: null,
      });
    });

    it('status = approved → เฉพาะที่อนุมัติ พร้อมชื่อผู้ตรวจ · คำขอที่ pending ไม่ปน', async () => {
      seedCaregiver();
      seedCaregiver({ user_id: OTHER_USER.id });
      const a = await service.requestChange(CAREGIVER_USER, {
        profession: 'nurse',
      });
      await service.requestChange(OTHER_USER, { profession: 'nurse' });
      await service.approve(ADMIN, a.id);

      const page = await service.adminList({
        status: ProfessionChangeStatus.approved,
      });

      expect(page.total).toBe(1);
      expect(page.items[0]).toMatchObject({
        id: a.id,
        status: 'approved',
        reviewerName: `แอดมิน ${ADMIN.id}`,
      });
    });

    it('ไม่มีรายการ → totalPages = 1 (แบบเดียวกับคิวอื่นของแอดมิน)', async () => {
      expect(await service.adminList({})).toEqual({
        items: [],
        total: 0,
        page: 1,
        totalPages: 1,
      });
    });
  });
});
