/**
 * ProfessionChangeService — คำขอเปลี่ยนวิชาชีพหลัง KYC อนุมัติ (PYG-575 · S01-AC6 · contract PYG-573 §4, §6)
 *
 * กติกาหลัก (R5): ผู้ดูแลที่ KYC อนุมัติแล้วเปลี่ยนวิชาชีพเองไม่ได้ — ยื่นคำขอแล้วรอแอดมินตรวจ
 *   ระหว่างรอ caregivers.profession ยังเป็นค่าเดิม (Elder เห็นค่าเดิม ผู้ดูแลรับงานด้วยค่าเดิมได้)
 *
 * ── ที่เก็บข้อมูล: caregiver_edit_logs (ไม่มีตารางของตัวเอง · มติ 2026-10-17 ไม่ต้อง migrate) ──
 *   ทุกเหตุการณ์ = แถวใหม่ (append-only) — action ดู PROFESSION_CHANGE_ACTION
 *   field_changes ทุกแถว = [{ field: 'profession', oldValue, newValue, requestId, reason? }]
 *     - field/oldValue/newValue รูปเดียวกับ computeFieldChanges → adminKycDetail.editHistory แสดงได้ทันที
 *     - requestId = id ของแถว request — ใช้จับคู่ "แถวตัดสิน" กับคำขอ (ทุกแถวของคำขอเดียวกันมีค่าเดียวกัน)
 *     - reason = เหตุผลที่แอดมินปฏิเสธ (เฉพาะแถว reject)
 *   สถานะ = แถวตัดสิน (cancel / approve / reject) ที่ requestId ตรงกัน · ไม่มี = pending
 *
 * ── กันการซ้อนกัน (ไม่มี unique index ใน DB ช่วย) ──
 *   ทุก method ที่เขียน ล็อกแถว caregivers ของผู้ดูแลคนนั้นด้วย SELECT … FOR UPDATE ก่อนตรวจและเขียน
 *   → ยื่นคำขอซ้อนจากสองแท็บ / แอดมินสองคนกดพร้อมกัน ถูกต่อคิว ไม่ได้ pending สองใบหรือตัดสินซ้ำ
 *   created_at ใช้ clock_timestamp() (เวลาหลังได้ล็อก) ไม่ใช่ NOW() (เวลาเริ่มทรานแซคชัน)
 *   เพื่อให้ลำดับเวลาของแถวตรงกับลำดับที่ได้ล็อกเสมอ
 *
 * ── ใบประกอบฯ (PYG-663 · แทนมติชั่วคราว PYG-573 §1/E5) ──
 *   วิชาชีพใหม่ที่ต้องมีใบ (nurse / physiotherapist) ต้องแนบใบที่อัปโหลดไว้แล้ว (licenseDocumentId)
 *   กติกาใบเดียวกับ KYC (assertUsableLicenseDoc) · id ใบเก็บใน field_changes ของแถว request (ไม่ต้อง migrate)
 *   ยื่นคำขอ = ผูกใบกับผู้ดูแล (caregiver_id) → ใบเข้าคิว/หน้าตรวจใบของแอดมิน + งานหมดอายุรายวันเห็น
 *   แอดมินอนุมัติคำขอ = อนุมัติใบในทรานแซคชันเดียวกัน · ปฏิเสธคำขอ = ปฏิเสธใบที่ยังรอตรวจด้วยเหตุผลเดียวกัน
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { isUUID } from 'class-validator';
import { PrismaService } from '../../common/prisma.service';
import { ClockService } from '../../common/clock.service';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import {
  CaregiverProfession,
  DECISION_ACTION_TO_STATUS,
  isCaregiverProfession,
  PROFESSION_CHANGE_ACTION,
  ProfessionChangeStatus,
} from './profession.constants';
import {
  parseProfessionInput,
  PROFESSION_ERROR,
  ProfessionError,
} from './profession.errors';
import {
  AdminProfessionChangeRequest,
  AdminProfessionChangeRequestPage,
  ProfessionChangeRequest,
} from './entities/profession-change-request.entity';
import {
  AdminProfessionChangeRequestsInput,
  ProfessionChangeInput,
  RejectProfessionChangeInput,
} from './dto/profession-change.input';
import {
  LICENSE_DOC_TYPE,
  LICENSE_REQUIRED_PROFESSIONS,
  LICENSE_REVIEW_ACTION,
  LICENSE_STATUS,
} from './license/license.constants';
import { LICENSE_ERROR, LicenseError } from './license/license.errors';
import { assertUsableLicenseDoc } from './license/license-validation';
import { bangkokDateString } from './license/license-date';
import { KycDocument } from './entities/kyc-document.entity';

/** client ที่ใช้ query ได้ทั้งนอกและในทรานแซคชัน */
type Db = PrismaService | Prisma.TransactionClient;

/** แถวที่ findRequests คืน — 1 แถว = 1 คำขอ พร้อมแถวตัดสิน (ถ้ามี) */
type RequestRow = {
  id: string;
  caregiver_id: string;
  field_changes: unknown;
  requested_at: Date;
  decision_action: string | null;
  decision_changes: unknown;
  decided_at: Date | null;
  caregiver_number: string | null;
  caregiver_name: string | null;
  reviewer_name: string | null;
};

/** แถว caregivers ที่ล็อกไว้ — อ่านเฉพาะที่ใช้ตัดสิน */
type LockedCaregiver = { id: string; profession: string; kyc_status: string };

/** element ของ field_changes ที่ service นี้เขียน */
type ProfessionLogEntry = {
  field: 'profession';
  oldValue: string;
  newValue: string;
  requestId: string;
  reason?: string;
  /** PYG-663: ใบประกอบฯ ที่แนบ (เฉพาะแถว request ของวิชาชีพที่ต้องมีใบ) */
  licenseDocumentId?: string;
};

/** ตัวเลือกของ findRequests — ทุกตัว optional ประกอบเป็น WHERE */
type FindOptions = {
  caregiverId?: string;
  requestId?: string;
  status?: ProfessionChangeStatus;
  /** latest = ยื่นล่าสุดก่อน · queue = ยื่นเก่าสุดก่อน (คิว pending) · decided = ตัดสินล่าสุดก่อน */
  order?: 'latest' | 'queue' | 'decided';
  limit?: number;
  offset?: number;
};

/** action ของแถวตัดสินทั้ง 3 ชนิด — ใช้ใน SQL */
const DECISION_ACTIONS = [
  PROFESSION_CHANGE_ACTION.CANCEL,
  PROFESSION_CHANGE_ACTION.APPROVE,
  PROFESSION_CHANGE_ACTION.REJECT,
];

/** status → action ของแถวตัดสิน (กลับด้านของ DECISION_ACTION_TO_STATUS) */
const STATUS_TO_DECISION_ACTION: Partial<
  Record<ProfessionChangeStatus, string>
> = {
  [ProfessionChangeStatus.cancelled]: PROFESSION_CHANGE_ACTION.CANCEL,
  [ProfessionChangeStatus.approved]: PROFESSION_CHANGE_ACTION.APPROVE,
  [ProfessionChangeStatus.rejected]: PROFESSION_CHANGE_ACTION.REJECT,
};

@Injectable()
export class ProfessionChangeService {
  private readonly logger = new Logger(ProfessionChangeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockService,
  ) {}

  // ─── ฝั่งผู้ดูแล ────────────────────────────────────────────────────────

  /**
   * myRequest — คำขอล่าสุดของผู้ดูแลที่ล็อกอิน (ไม่ว่าสถานะใด) · null = ไม่เคยขอ / ยังไม่มีแถว caregivers
   */
  async myRequest(user: AuthUser): Promise<ProfessionChangeRequest | null> {
    const caregiver = await this.prisma.caregiver.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
    if (!caregiver) return null;

    const [row] = await this.findRequests(this.prisma, {
      caregiverId: caregiver.id,
      order: 'latest',
      limit: 1,
    });
    if (!row) return null;
    const [request] = await this.withLicenses(this.prisma, [
      this.toEntity(row),
    ]);
    return request;
  }

  /**
   * requestChange — ยื่นคำขอเปลี่ยนวิชาชีพ (ยังไม่เปลี่ยนค่าจริง)
   *
   * ลำดับการตรวจ: ค่าที่ส่งมา → สถานะ KYC → มีคำขอค้าง → ค่าเดียวกับปัจจุบัน
   */
  async requestChange(
    user: AuthUser,
    input: ProfessionChangeInput,
  ): Promise<ProfessionChangeRequest> {
    // ตรวจค่าก่อนแตะ DB — ค่าผิดไม่ต้องเสียล็อก
    const toProfession = parseProfessionInput(input.profession);

    const request = await this.prisma.$transaction(async (tx) => {
      // ล็อกจาก user ที่ล็อกอิน — ไม่รับ caregiverId จาก client เลย (ขอแทนคนอื่นไม่ได้)
      const caregiver = await this.lockCaregiver(
        tx,
        Prisma.sql`user_id = ${user.id}`,
      );

      // E2: สถานะอื่นเปลี่ยนผ่านฟอร์ม KYC ได้เลย (ยังไม่เคยอนุมัติ / กำลังตรวจทั้งชุดอยู่)
      if (!caregiver || caregiver.kyc_status !== 'verified') {
        const kycStatus = caregiver?.kyc_status ?? 'none';
        throw new ProfessionError(
          kycStatus === 'pending'
            ? 'KYC ของคุณอยู่ระหว่างตรวจสอบ — รอผลก่อนจึงจะขอเปลี่ยนวิชาชีพได้'
            : 'ขอเปลี่ยนวิชาชีพได้หลังยืนยันตัวตนผ่านแล้ว — ระหว่างนี้แก้วิชาชีพได้ในฟอร์มยืนยันตัวตน',
          PROFESSION_ERROR.CHANGE_NOT_ALLOWED,
          { kycStatus },
        );
      }

      const [pending] = await this.findRequests(tx, {
        caregiverId: caregiver.id,
        status: ProfessionChangeStatus.pending,
        limit: 1,
      });
      if (pending) {
        throw new ProfessionError(
          'มีคำขอเปลี่ยนวิชาชีพที่รอตรวจอยู่แล้ว — ยกเลิกคำขอเดิมก่อนจึงจะขอใหม่ได้',
          PROFESSION_ERROR.CHANGE_ALREADY_PENDING,
          { requestId: pending.id },
        );
      }

      // caregiver.profession เป็น string จาก SQL — เทียบแบบ string กับค่าที่ตรวจแล้ว
      if (caregiver.profession === String(toProfession)) {
        throw new ProfessionError(
          'วิชาชีพใหม่ต้องไม่ซ้ำกับวิชาชีพปัจจุบัน',
          PROFESSION_ERROR.UNCHANGED,
          { profession: toProfession },
        );
      }

      // PYG-663: วิชาชีพที่ต้องมีใบ → ตรวจใบที่แนบ + ผูกกับผู้ดูแล (ตรวจหลังเงื่อนไขของคำขอ — ใบผิดไม่ควรบังคำตอบเรื่องคำขอซ้อน)
      const licenseDocumentId = LICENSE_REQUIRED_PROFESSIONS.has(toProfession)
        ? await this.attachLicense(
            tx,
            user.id,
            caregiver.id,
            input.licenseDocumentId,
          )
        : undefined;

      // id สร้างที่แอป (ไม่ใช่ gen_random_uuid) เพราะต้องใส่ค่าเดียวกันลง requestId ของแถวตัวเองด้วย
      const requestId = randomUUID();
      await this.insertLog(tx, {
        id: requestId,
        caregiverId: caregiver.id,
        editedBy: user.id,
        action: PROFESSION_CHANGE_ACTION.REQUEST,
        entry: {
          ...this.entry(caregiver.profession, toProfession, requestId),
          ...(licenseDocumentId && { licenseDocumentId }),
        },
      });

      return this.reload(tx, requestId);
    });

    this.logger.log({
      event: 'profession_change.requested',
      requestId: request.id,
      caregiverId: request.caregiverId,
      from: request.fromProfession,
      to: request.toProfession,
    });
    return request;
  }

  /**
   * cancel — ผู้ดูแลยกเลิกคำขอของตัวเอง (pending เท่านั้น)
   * id ที่ไม่ใช่ของผู้เรียก ตอบ NOT_FOUND เหมือน id ที่ไม่มีอยู่จริง — ไม่บอกว่าคำขอของคนอื่นมีอยู่
   */
  async cancel(
    user: AuthUser,
    requestId: string,
  ): Promise<ProfessionChangeRequest> {
    const request = await this.prisma.$transaction(async (tx) => {
      const caregiver = await this.lockCaregiver(
        tx,
        Prisma.sql`user_id = ${user.id}`,
      );
      if (!caregiver) throw this.notFound();

      // อ่าน "หลัง" ได้ล็อก — ถ้าแอดมินเพิ่งตัดสินไป จะเห็นสถานะใหม่แล้ว
      const current = await this.findOwnedPending(tx, requestId, caregiver.id);

      await this.insertLog(tx, {
        id: randomUUID(),
        caregiverId: caregiver.id,
        editedBy: user.id,
        action: PROFESSION_CHANGE_ACTION.CANCEL,
        entry: this.entry(
          current.fromProfession,
          current.toProfession,
          current.id,
        ),
      });

      return this.reload(tx, current.id);
    });

    this.logger.log({
      event: 'profession_change.cancelled',
      requestId,
      caregiverId: request.caregiverId,
    });
    return request;
  }

  // ─── ฝั่งแอดมิน ─────────────────────────────────────────────────────────

  /**
   * adminList — คิวตรวจของแอดมิน
   * pending เรียงยื่นเก่าสุดก่อน (คิว) · สถานะอื่นเรียงตัดสินล่าสุดก่อน (ดูประวัติ)
   */
  async adminList(
    input: AdminProfessionChangeRequestsInput = {},
  ): Promise<AdminProfessionChangeRequestPage> {
    const status = input.status ?? ProfessionChangeStatus.pending;
    const page = Math.max(1, input.page ?? 1);
    const limit = Math.min(50, Math.max(1, input.limit ?? 20));

    const [rows, total] = await Promise.all([
      this.findRequests(this.prisma, {
        status,
        order: status === ProfessionChangeStatus.pending ? 'queue' : 'decided',
        limit,
        offset: (page - 1) * limit,
      }),
      this.countRequests(status),
    ]);

    return {
      items: await this.withLicenses(
        this.prisma,
        rows.map((row) => this.toAdminEntity(row)),
      ),
      total,
      page,
      totalPages: total === 0 ? 1 : Math.ceil(total / limit),
    };
  }

  /**
   * approve — อนุมัติ: เปลี่ยน caregivers.profession + บันทึก log ในทรานแซคชันเดียวกัน
   * (ล้มกลางทาง = ไม่มีอะไรเปลี่ยนเลย ไม่มีกรณี "เปลี่ยนแล้วแต่ไม่มีประวัติ")
   */
  async approve(
    admin: AuthUser,
    requestId: string,
  ): Promise<ProfessionChangeRequest> {
    const request = await this.prisma.$transaction(async (tx) => {
      const { caregiver, current } = await this.lockPendingForReview(
        tx,
        requestId,
      );

      // PYG-663: วิชาชีพที่ต้องมีใบ → ใบต้องใช้ได้ และอนุมัติไปพร้อมกัน (ล้ม = วิชาชีพไม่เปลี่ยน)
      await this.approveLicense(tx, admin, caregiver.id, current);

      await tx.caregiver.update({
        where: { id: caregiver.id },
        data: { profession: current.toProfession },
      });

      await this.insertLog(tx, {
        id: randomUUID(),
        caregiverId: caregiver.id,
        editedBy: admin.id,
        action: PROFESSION_CHANGE_ACTION.APPROVE,
        // oldValue = ค่าจริงในแถว ณ ตอนอนุมัติ (ไม่ใช่ค่าที่จำไว้ตอนยื่น) — log บอกความจริงของการ UPDATE นี้
        entry: this.entry(
          caregiver.profession,
          current.toProfession,
          current.id,
        ),
      });

      return this.reload(tx, current.id);
    });

    this.logger.log({
      event: 'profession_change.approved',
      requestId,
      caregiverId: request.caregiverId,
      adminId: admin.id,
      to: request.toProfession,
    });
    return request;
  }

  /** reject — ปฏิเสธพร้อมเหตุผล · วิชาชีพคงเดิม */
  async reject(
    admin: AuthUser,
    input: RejectProfessionChangeInput,
  ): Promise<ProfessionChangeRequest> {
    // @IsNotEmpty ปล่อย "   " ผ่าน — เหตุผลที่มีแต่ช่องว่างไม่มีประโยชน์กับผู้ดูแล
    const reason = input.reason.trim();
    if (!reason) throw new BadRequestException('ต้องระบุเหตุผลที่ปฏิเสธ');

    const request = await this.prisma.$transaction(async (tx) => {
      const { caregiver, current } = await this.lockPendingForReview(
        tx,
        input.id,
      );

      // PYG-663: ใบที่ยังรอตรวจถูกปฏิเสธด้วยเหตุผลเดียวกัน (ผู้ดูแลเห็นเหตุผลที่หน้าสถานะ KYC ด้วย)
      await this.rejectLicense(tx, admin, caregiver.id, current, reason);

      await this.insertLog(tx, {
        id: randomUUID(),
        caregiverId: caregiver.id,
        editedBy: admin.id,
        action: PROFESSION_CHANGE_ACTION.REJECT,
        entry: {
          ...this.entry(
            current.fromProfession,
            current.toProfession,
            current.id,
          ),
          reason,
        },
      });

      return this.reload(tx, current.id);
    });

    this.logger.log({
      event: 'profession_change.rejected',
      requestId: input.id,
      caregiverId: request.caregiverId,
      adminId: admin.id,
    });
    return request;
  }

  // ─── Private: ล็อก + ตรวจ ───────────────────────────────────────────────

  /**
   * lockCaregiver — SELECT … FOR UPDATE แถว caregivers หนึ่งแถว (ตามเงื่อนไขที่ส่งมา)
   * ล็อกอยู่จนจบทรานแซคชัน → ทุก method ที่เขียนของผู้ดูแลคนเดียวกันต่อคิวกันที่นี่
   */
  private async lockCaregiver(
    tx: Prisma.TransactionClient,
    where: Prisma.Sql,
  ): Promise<LockedCaregiver | null> {
    const rows = await tx.$queryRaw<LockedCaregiver[]>`
      SELECT id, profession, kyc_status FROM caregivers WHERE ${where} FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  /** หาคำขอของผู้ดูแลคนนี้ที่ยัง pending — ไม่ใช่ของเขา = NOT_FOUND · จบแล้ว = NOT_PENDING */
  private async findOwnedPending(
    tx: Prisma.TransactionClient,
    requestId: string,
    caregiverId: string,
  ): Promise<ProfessionChangeRequest> {
    const [row] = await this.findRequests(tx, {
      requestId,
      caregiverId,
      limit: 1,
    });
    if (!row) throw this.notFound();
    return this.assertPending(this.toEntity(row));
  }

  /**
   * lockPendingForReview — ใช้ร่วมกันของ approve / reject
   * 1) หาคำขอเพื่อรู้ว่าเป็นของผู้ดูแลคนไหน  2) ล็อกแถวผู้ดูแลคนนั้น
   * 3) อ่านคำขอซ้ำหลังได้ล็อก — ระหว่างรอล็อกอาจถูกยกเลิก/ตัดสินไปแล้ว
   */
  private async lockPendingForReview(
    tx: Prisma.TransactionClient,
    requestId: string,
  ): Promise<{ caregiver: LockedCaregiver; current: ProfessionChangeRequest }> {
    const [found] = await this.findRequests(tx, { requestId, limit: 1 });
    if (!found) throw this.notFound();

    const caregiver = await this.lockCaregiver(
      tx,
      Prisma.sql`id = ${found.caregiver_id}`,
    );
    if (!caregiver) throw this.notFound();

    const current = await this.findOwnedPending(tx, requestId, caregiver.id);
    return { caregiver, current };
  }

  private assertPending(
    request: ProfessionChangeRequest,
  ): ProfessionChangeRequest {
    if (request.status !== ProfessionChangeStatus.pending) {
      throw new ProfessionError(
        'คำขอนี้ไม่ได้อยู่ระหว่างรอตรวจแล้ว',
        PROFESSION_ERROR.CHANGE_NOT_PENDING,
        { status: request.status },
      );
    }
    return request;
  }

  private notFound(): ProfessionError {
    return new ProfessionError(
      'ไม่พบคำขอเปลี่ยนวิชาชีพ',
      PROFESSION_ERROR.CHANGE_NOT_FOUND,
    );
  }

  // ─── Private: ใบประกอบฯ ของคำขอ (PYG-663) ─────────────────────────────

  /**
   * attachLicense — ตรวจใบที่แนบมากับคำขอ แล้วผูกกับผู้ดูแล
   * ใบต้องเป็นของผู้ใช้ที่ล็อกอิน (user_id) — id ของคนอื่น/ไม่มีอยู่/ไม่ใช่ uuid ตอบเหมือน "ไม่ได้แนบ"
   * ผูก caregiver_id เพราะใบที่อัปโหลดหลัง KYC อนุมัติยังไม่ถูกผูก (ผูกตอน submit KYC เท่านั้น)
   * → AdminLicenseService / LicenseExpiryCron / adminKycDetail หาเจอ
   */
  private async attachLicense(
    tx: Prisma.TransactionClient,
    userId: string,
    caregiverId: string,
    rawDocumentId: string | null | undefined,
  ): Promise<string> {
    const documentId = rawDocumentId?.trim() ?? '';
    const doc = isUUID(documentId)
      ? await tx.kycDocument.findFirst({
          where: { id: documentId, userId, documentType: LICENSE_DOC_TYPE },
          select: {
            id: true,
            caregiverId: true,
            licenseNumber: true,
            expiresAt: true,
            reviewStatus: true,
          },
        })
      : null;

    assertUsableLicenseDoc(doc, this.clock.now());

    if (doc!.caregiverId !== caregiverId) {
      await tx.kycDocument.update({
        where: { id: doc!.id },
        data: { caregiverId },
      });
    }
    return doc!.id;
  }

  /**
   * approveLicense — ใช้ใน approve (ในทรานแซคชันเดียวกัน)
   * pending → approved + kyc_reviews license_approved · approved อยู่แล้ว (แอดมินตรวจใบแยกมาก่อน) → ผ่าน
   * ไม่มีใบ (คำขอเก่าก่อน PYG-663) / ถูกปฏิเสธ / หมดอายุ → อนุมัติไม่ได้ ต้องปฏิเสธคำขอ
   */
  private async approveLicense(
    tx: Prisma.TransactionClient,
    admin: AuthUser,
    caregiverId: string,
    request: ProfessionChangeRequest,
  ): Promise<void> {
    if (!LICENSE_REQUIRED_PROFESSIONS.has(request.toProfession)) return;

    const doc = request.licenseDocumentId
      ? await tx.kycDocument.findUnique({
          where: { id: request.licenseDocumentId },
          select: { id: true, reviewStatus: true, expiresAt: true },
        })
      : null;
    if (!doc) throw this.licenseUnusable('missing');

    const now = this.clock.now();
    if (!doc.expiresAt || doc.expiresAt.getTime() <= now.getTime()) {
      throw new LicenseError(LICENSE_ERROR.EXPIRED);
    }
    if (doc.reviewStatus === LICENSE_STATUS.APPROVED) return;
    if (doc.reviewStatus !== LICENSE_STATUS.PENDING) {
      throw this.licenseUnusable(doc.reviewStatus ?? 'unknown');
    }

    // เงื่อนไข pending ใน WHERE — แอดมินอีกคนตรวจใบเดียวกันจากหน้าใบประกอบฯ พร้อมกัน = 409
    const claimed = await tx.kycDocument.updateMany({
      where: { id: doc.id, reviewStatus: LICENSE_STATUS.PENDING },
      data: { reviewStatus: LICENSE_STATUS.APPROVED, reviewedAt: now },
    });
    if (claimed.count === 0) {
      throw new ConflictException(
        'ใบประกอบวิชาชีพนี้ถูกตัดสินไปแล้ว — กรุณารีเฟรช',
      );
    }
    await tx.kycReview.create({
      data: {
        caregiverId,
        reviewerId: admin.id,
        action: LICENSE_REVIEW_ACTION.APPROVED,
        documentId: doc.id,
        reviewedAt: now,
      },
    });
  }

  /** rejectLicense — ใบที่ยังรอตรวจถูกปฏิเสธพร้อมคำขอ · ใบที่ตัดสินแล้ว (หรือไม่มีใบ) ไม่แตะ */
  private async rejectLicense(
    tx: Prisma.TransactionClient,
    admin: AuthUser,
    caregiverId: string,
    request: ProfessionChangeRequest,
    reason: string,
  ): Promise<void> {
    if (!request.licenseDocumentId) return;

    const now = this.clock.now();
    const claimed = await tx.kycDocument.updateMany({
      where: {
        id: request.licenseDocumentId,
        reviewStatus: LICENSE_STATUS.PENDING,
      },
      data: { reviewStatus: LICENSE_STATUS.REJECTED, reviewedAt: now },
    });
    if (claimed.count === 0) return;

    await tx.kycReview.create({
      data: {
        caregiverId,
        reviewerId: admin.id,
        action: LICENSE_REVIEW_ACTION.REJECTED,
        reason,
        documentId: request.licenseDocumentId,
        reviewedAt: now,
      },
    });
  }

  private licenseUnusable(licenseStatus: string): ProfessionError {
    return new ProfessionError(
      'ใบประกอบวิชาชีพของคำขอนี้ใช้ไม่ได้แล้ว (ไม่มีใบ / ถูกปฏิเสธ / หมดอายุ) — ปฏิเสธคำขอนี้ แล้วให้ผู้ดูแลยื่นใหม่พร้อมใบใหม่',
      PROFESSION_ERROR.CHANGE_LICENSE_UNUSABLE,
      { licenseStatus },
    );
  }

  /**
   * withLicenses — เติมเลข / วันหมดอายุ / เอกสารของใบที่แนบ (โหลดทีเดียวทุกคำขอ)
   * ไม่ออก signedUrl ที่นี่: เจ้าของดูไฟล์ที่ kycStatus · แอดมินดูที่ adminKycDetail (มี audit log)
   */
  private async withLicenses<T extends ProfessionChangeRequest>(
    db: Db,
    requests: T[],
  ): Promise<T[]> {
    const ids = [
      ...new Set(
        requests
          .map((r) => r.licenseDocumentId)
          .filter((id): id is string => !!id),
      ),
    ];
    if (ids.length === 0) return requests;

    const docs = await db.kycDocument.findMany({ where: { id: { in: ids } } });
    const byId = new Map(docs.map((d) => [d.id, d]));

    return requests.map((r) => {
      const doc = r.licenseDocumentId
        ? byId.get(r.licenseDocumentId)
        : undefined;
      if (!doc) return r;
      const licenseDocument: KycDocument = {
        id: doc.id,
        caregiverId: doc.caregiverId ?? undefined,
        userId: doc.userId,
        docType: doc.documentType,
        fileUrl: '', // ไม่คืน storage path ดิบ (เหมือน CaregiverService.signDocuments)
        fileName: doc.fileName,
        fileSize: doc.fileSize,
        mimeType: doc.mimeType,
        uploadedAt: doc.uploadedAt,
        licenseNumber: doc.licenseNumber ?? undefined,
        expiresAt: doc.expiresAt ?? undefined,
        reviewStatus: doc.reviewStatus ?? undefined,
      };
      return {
        ...r,
        licenseNumber: doc.licenseNumber,
        licenseExpiresAt: doc.expiresAt
          ? bangkokDateString(doc.expiresAt)
          : null,
        licenseDocument,
      };
    });
  }

  // ─── Private: อ่าน/เขียน caregiver_edit_logs ────────────────────────────

  /** element ของ field_changes — oldValue/newValue เป็น JSON string แบบเดียวกับ computeFieldChanges */
  private entry(
    from: string,
    to: string,
    requestId: string,
  ): ProfessionLogEntry {
    return {
      field: 'profession',
      oldValue: JSON.stringify(from),
      newValue: JSON.stringify(to),
      requestId,
    };
  }

  /** INSERT แถวเดียว — $executeRaw เหมือน KycService (caregiver_edit_logs ไม่มี relation ให้ create ผ่าน model สะดวก) */
  private async insertLog(
    tx: Prisma.TransactionClient,
    log: {
      id: string;
      caregiverId: string;
      editedBy: string;
      action: string;
      entry: ProfessionLogEntry;
    },
  ): Promise<void> {
    const changesJson = JSON.stringify([log.entry]);
    await tx.$executeRaw`
      INSERT INTO caregiver_edit_logs (id, caregiver_id, edited_by, action, field_changes, created_at)
      VALUES (${log.id}::uuid, ${log.caregiverId}, ${log.editedBy}, ${log.action}, ${changesJson}::jsonb, clock_timestamp())
    `;
  }

  /** อ่านคำขอที่เพิ่งเขียนในทรานแซคชันเดียวกัน — ให้ทุก mutation คืนค่ารูปเดียวกับ query */
  private async reload(
    tx: Prisma.TransactionClient,
    requestId: string,
  ): Promise<ProfessionChangeRequest> {
    const [row] = await this.findRequests(tx, { requestId, limit: 1 });
    if (!row) throw this.notFound(); // ไม่ควรเกิด — เพิ่งเขียนในทรานแซคชันนี้
    const [request] = await this.withLicenses(tx, [this.toEntity(row)]);
    return request;
  }

  /**
   * WHERE ร่วมของ findRequests / countRequests
   * d = แถวตัดสินแรกที่ requestId ตรงกัน (LATERAL) — ไม่มี = pending
   */
  private filters(opts: FindOptions): Prisma.Sql {
    const conditions: Prisma.Sql[] = [
      Prisma.sql`r.action = ${PROFESSION_CHANGE_ACTION.REQUEST}`,
    ];

    if (opts.caregiverId)
      conditions.push(Prisma.sql`r.caregiver_id = ${opts.caregiverId}`);
    // เทียบแบบ text — id ที่ไม่ใช่ uuid (client ส่งมั่ว) จะได้ "ไม่พบ" แทน error ของ Postgres ตอน cast
    if (opts.requestId)
      conditions.push(Prisma.sql`r.id::text = ${opts.requestId}`);

    if (opts.status === ProfessionChangeStatus.pending) {
      conditions.push(Prisma.sql`d.action IS NULL`);
    } else if (opts.status) {
      conditions.push(
        Prisma.sql`d.action = ${STATUS_TO_DECISION_ACTION[opts.status]}`,
      );
    }

    return Prisma.join(conditions, ' AND ');
  }

  /**
   * FROM ร่วม: แถว request + แถวตัดสิน (ถ้ามี)
   * `@>` = jsonb containment — แถวตัดสินที่ field_changes มี element ซึ่ง requestId ตรงกับ id ของคำขอ
   */
  private readonly fromClause = Prisma.sql`
    FROM caregiver_edit_logs r
    LEFT JOIN LATERAL (
      SELECT dl.action, dl.field_changes, dl.created_at, dl.edited_by
      FROM caregiver_edit_logs dl
      WHERE dl.caregiver_id = r.caregiver_id
        AND dl.action IN (${Prisma.join(DECISION_ACTIONS)})
        AND dl.field_changes @> jsonb_build_array(jsonb_build_object('requestId', r.id::text))
      ORDER BY dl.created_at ASC
      LIMIT 1
    ) d ON TRUE
  `;

  private async findRequests(db: Db, opts: FindOptions): Promise<RequestRow[]> {
    const orderBy =
      opts.order === 'queue'
        ? Prisma.sql`r.created_at ASC, r.id ASC`
        : opts.order === 'decided'
          ? Prisma.sql`d.created_at DESC NULLS LAST, r.created_at DESC`
          : Prisma.sql`r.created_at DESC, r.id DESC`;
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    return db.$queryRaw<RequestRow[]>`
      SELECT
        r.id::text            AS id,
        r.caregiver_id,
        r.field_changes,
        r.created_at          AS requested_at,
        d.action              AS decision_action,
        d.field_changes       AS decision_changes,
        d.created_at          AS decided_at,
        c.caregiver_number,
        c.full_name           AS caregiver_name,
        reviewer.display_name AS reviewer_name
      ${this.fromClause}
      JOIN caregivers c ON c.id = r.caregiver_id
      -- ผู้ตัดสินเป็นแอดมินเฉพาะ approve / reject (cancel = ผู้ดูแลเอง ไม่ใช่ "ผู้ตรวจ")
      LEFT JOIN users reviewer
        ON reviewer.id = d.edited_by
       AND d.action IN (${PROFESSION_CHANGE_ACTION.APPROVE}, ${PROFESSION_CHANGE_ACTION.REJECT})
      WHERE ${this.filters(opts)}
      ORDER BY ${orderBy}
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  /** นับแยก (ไม่ใช้ COUNT(*) OVER()) — หน้าที่เกินหน้าสุดท้ายยังได้ total ที่ถูกต้อง */
  private async countRequests(status: ProfessionChangeStatus): Promise<number> {
    const [row] = await this.prisma.$queryRaw<Array<{ total: bigint }>>`
      SELECT COUNT(*) AS total
      ${this.fromClause}
      WHERE ${this.filters({ status })}
    `;
    return Number(row?.total ?? 0);
  }

  // ─── Private: แปลงแถว → entity ──────────────────────────────────────────

  private toEntity(row: RequestRow): ProfessionChangeRequest {
    const requested = this.readEntry(row.field_changes, row.id);
    const status = row.decision_action
      ? (DECISION_ACTION_TO_STATUS[row.decision_action] ??
        ProfessionChangeStatus.pending)
      : ProfessionChangeStatus.pending;
    // reviewedAt = เวลาที่ "แอดมิน" ตัดสิน — ผู้ดูแลยกเลิกเองไม่นับว่าถูกตรวจ
    const reviewed =
      status === ProfessionChangeStatus.approved ||
      status === ProfessionChangeStatus.rejected;
    const decision =
      status === ProfessionChangeStatus.rejected
        ? this.readEntry(row.decision_changes, row.id)
        : null;

    return {
      id: row.id,
      caregiverId: row.caregiver_id,
      fromProfession: requested.from,
      toProfession: requested.to,
      status,
      // PYG-663: เติมจากใบจริงใน withLicenses · ไม่มีใบ = null
      licenseNumber: null,
      licenseExpiresAt: null,
      licenseDocument: null,
      licenseDocumentId: requested.licenseDocumentId ?? null,
      rejectionReason: decision?.reason ?? null,
      requestedAt: row.requested_at,
      reviewedAt: reviewed ? row.decided_at : null,
    };
  }

  private toAdminEntity(row: RequestRow): AdminProfessionChangeRequest {
    return {
      ...this.toEntity(row),
      caregiverNumber: row.caregiver_number,
      caregiverName: row.caregiver_name ?? '',
      reviewerName: row.reviewer_name,
    };
  }

  /**
   * readEntry — แกะ element 'profession' จาก field_changes
   * ค่าใน DB ต้องเป็น 1 ใน 3 วิชาชีพเสมอ (เขียนโดย service นี้เท่านั้น) — ถ้าไม่ใช่ = ข้อมูลเสีย ให้ throw
   * ดีกว่าปล่อยให้ GraphQL พังตอน serialize enum โดยไม่รู้ว่าแถวไหน
   */
  private readEntry(
    fieldChanges: unknown,
    requestId: string,
  ): {
    from: CaregiverProfession;
    to: CaregiverProfession;
    reason?: string;
    licenseDocumentId?: string;
  } {
    const entries = Array.isArray(fieldChanges)
      ? (fieldChanges as Array<Partial<ProfessionLogEntry>>)
      : [];
    const entry = entries.find((e) => e?.field === 'profession');
    const from = this.parseStored(entry?.oldValue);
    const to = this.parseStored(entry?.newValue);

    if (!from || !to) {
      this.logger.error({
        event: 'profession_change.corrupt_log',
        requestId,
        fieldChanges,
      });
      throw new Error(`profession change log ของคำขอ ${requestId} อ่านไม่ได้`);
    }
    return {
      from,
      to,
      reason: typeof entry?.reason === 'string' ? entry.reason : undefined,
      licenseDocumentId:
        typeof entry?.licenseDocumentId === 'string'
          ? entry.licenseDocumentId
          : undefined,
    };
  }

  /** oldValue/newValue เก็บเป็น JSON string ('"nurse"') → 'nurse' */
  private parseStored(value: string | undefined): CaregiverProfession | null {
    if (typeof value !== 'string') return null;
    try {
      const parsed: unknown = JSON.parse(value);
      return isCaregiverProfession(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}
