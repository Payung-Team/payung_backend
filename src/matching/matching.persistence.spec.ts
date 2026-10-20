/**
 * loadMatchCandidates — หลักฐาน (ใบประกอบฯ) ของผู้ดูแลที่เปลี่ยนวิชาชีพผ่านคำขอ (PYG-667)
 *
 * ★ field_changes ใน fixture ใช้รูปแบบจริง: oldValue/newValue เป็น JSON string ('"nurse"')
 *   ตามที่ ProfessionChangeService / computeFieldChanges เขียน — เทสเดิมที่ใช้ค่าดิบ ('nurse') จึงไม่เจอบั๊ก
 */
import { loadMatchCandidates } from './matching.persistence';
import { PROFESSION_CHANGE_ACTION } from '../identity/kyc/profession.constants';

const CG = 'cg-1';
const USER = 'user-1';
const NOW = new Date('2026-10-20T00:00:00Z');
const NEXT_YEAR = new Date('2027-10-20T00:00:00Z');
const REQUESTED = new Date('2026-10-10T00:00:00Z');
const APPROVED = new Date('2026-10-11T00:00:00Z');

const stored = (v: string) => JSON.stringify(v);

function tx(opts: {
  profession: string;
  documents: Record<string, unknown>[];
  logs: Record<string, unknown>[];
}) {
  return {
    $queryRaw: jest.fn().mockResolvedValue([
      {
        id: CG,
        userId: USER,
        fullName: 'ผู้ดูแล',
        careLevel: 'advanced',
        profession: opts.profession,
        skills: ['injection'],
      },
    ]),
    kycDocument: { findMany: jest.fn().mockResolvedValue(opts.documents) },
    caregiver_edit_logs: { findMany: jest.fn().mockResolvedValue(opts.logs) },
  } as never;
}

const licence = (id: string, uploadedAt: Date) => ({
  id,
  caregiverId: CG,
  userId: USER,
  reviewStatus: 'approved',
  expiresAt: NEXT_YEAR,
  uploadedAt,
});

const requestLog = (licenseDocumentId: string, to: string) => ({
  caregiver_id: CG,
  action: PROFESSION_CHANGE_ACTION.REQUEST,
  created_at: REQUESTED,
  field_changes: [
    {
      field: 'profession',
      oldValue: stored('general_caregiver'),
      newValue: stored(to),
      licenseDocumentId,
      requestId: 'req-1',
    },
  ],
});

const approveLog = (to: string) => ({
  caregiver_id: CG,
  action: PROFESSION_CHANGE_ACTION.APPROVE,
  created_at: APPROVED,
  field_changes: [
    {
      field: 'profession',
      oldValue: stored('general_caregiver'),
      newValue: stored(to),
      requestId: 'req-1',
    },
  ],
});

describe('loadMatchCandidates · หลักฐานหลังเปลี่ยนวิชาชีพ (PYG-667)', () => {
  it('counts the license attached to an approved profession change as evidence', async () => {
    const [row] = await loadMatchCandidates(
      tx({
        profession: 'nurse',
        documents: [licence('doc-1', REQUESTED)],
        logs: [requestLog('doc-1', 'nurse'), approveLog('nurse')],
      }),
      NOW,
    );
    expect(row.evidence).toEqual({
      profession: 'nurse',
      status: 'approved',
      expiresAt: NEXT_YEAR,
    });
  });

  it('does not count a license attached to a request for another profession', async () => {
    const [row] = await loadMatchCandidates(
      tx({
        profession: 'nurse',
        // ใบนี้แนบกับคำขอเป็นนักกายภาพ ไม่ใช่ของวิชาชีพปัจจุบัน
        documents: [licence('doc-2', REQUESTED)],
        logs: [requestLog('doc-2', 'physiotherapist'), approveLog('nurse')],
      }),
      NOW,
    );
    expect(row.evidence).toBeNull();
  });

  it('does not count an unlinked license uploaded before the approved change', async () => {
    const [row] = await loadMatchCandidates(
      tx({
        profession: 'nurse',
        documents: [licence('old-doc', new Date('2026-01-01T00:00:00Z'))],
        logs: [approveLog('nurse')],
      }),
      NOW,
    );
    expect(row.evidence).toBeNull();
  });

  it('treats a malformed stored value as not matching any profession', async () => {
    const [row] = await loadMatchCandidates(
      tx({
        profession: 'nurse',
        documents: [licence('doc-3', REQUESTED)],
        logs: [
          {
            ...requestLog('doc-3', 'nurse'),
            field_changes: [
              {
                field: 'profession',
                newValue: 'not-json',
                licenseDocumentId: 'doc-3',
              },
            ],
          },
        ],
      }),
      NOW,
    );
    expect(row.evidence).toBeNull();
  });
});
