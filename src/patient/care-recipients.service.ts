import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
// import เฉพาะไฟล์ค่าคงที่ (plain object ไม่มี DI) → ไม่ผูก PatientModule กับ FamilyGroupModule
import {
  ACTIVITY_ACTION,
  ACTIVITY_TARGET,
  ActivityAction,
} from '../family-group/family-group.constants';
import { CreateCareRecipientDto, UpdateCareRecipientDto } from './dto/care-recipient.dto';
import { PatientProfileDto } from './dto/patient-profile.dto';
import {
  PATIENT_PROFILE_SELECT,
  PatientProfileRow,
  toCareRecipientColumns,
  toPatientProfile,
} from './patient-profile.mapper';

export interface CareRecipientResponse {
  id: string;
  name: string;
  nickname?: string;
  patientId: string;
  /**
   * PYG-502 — โปรไฟล์ "ของตัวเอง" ที่สร้างตอน Onboarding (completeOnboarding, PYG-498)
   *
   * ★ FE ต้องใช้ค่านี้แยกใบของตัวเองออกจากคนอื่นที่เคยบันทึกไว้ (คุณยาย เพื่อนบ้าน ฯลฯ)
   *   เดาจากชื่อไม่ได้ — ชื่อซ้ำกับใครก็ได้ และผู้ใช้เปลี่ยนชื่อโปรไฟล์อื่นให้ตรงกับตัวเองได้
   *
   * ★ ผู้ใช้หนึ่งคนมีใบ is_self ได้ใบเดียว (completeOnboarding อัปเดตใบเดิมไม่สร้างซ้ำ)
   *   แต่ FE ไม่ควร assume — บัญชีเก่าก่อน PYG-498 ยังไม่มีสักใบ
   */
  isSelf: boolean;
  /** PYG-460: ข้อมูลสุขภาพ — undefined เมื่อโปรไฟล์ยังไม่เคยกรอกช่องไหนเลย */
  details?: PatientProfileDto;
}

/** select ชุดเดียวใช้ทั้ง list/create/update — กัน response สามที่หลุดรูปทรงกัน */
const RECIPIENT_SELECT = {
  id:        true,
  name:      true,
  nickname:  true,
  patientId: true,
  is_self:   true,
  ...PATIENT_PROFILE_SELECT,
} as const;

type RecipientRow = {
  id: string;
  name: string;
  nickname: string | null;
  patientId: string;
  is_self: boolean;
} & PatientProfileRow;

@Injectable()
export class CareRecipientsService {
  private readonly logger = new Logger(CareRecipientsService.name);

  constructor(private readonly prisma: PrismaService) {}

  private toResponse(row: RecipientRow): CareRecipientResponse {
    return {
      id:        row.id,
      name:      row.name,
      nickname:  row.nickname ?? undefined,
      patientId: row.patientId,
      isSelf:    row.is_self,
      details:   toPatientProfile(row),
    };
  }

  /**
   * เจ้าของโปรไฟล์ต้องเป็น patient คนนี้ และโปรไฟล์ต้องยังไม่ถูกลบ
   *
   * "ไม่พบ" กับ "ไม่ใช่ของคุณ" ตอบคนละ exception โดยตั้งใจ — ตรงกับพฤติกรรมเดิม
   * ของ update() ก่อน PYG-460 และ endpoint ชุดนี้ต้อง login อยู่แล้ว จึงไม่ได้
   * เปิดช่องให้ไล่เดา id จากภายนอก
   *
   * @returns familyGroupId ของใบนั้น — null = โปรไฟล์ส่วนตัว (ดู writeGroupActivity)
   */
  private async assertOwned(
    patientId: string,
    id: string,
  ): Promise<{ familyGroupId: string | null }> {
    const existing = await this.prisma.careRecipient.findUnique({
      where:  { id },
      select: { patientId: true, is_deleted: true, familyGroupId: true },
    });

    if (!existing || existing.is_deleted) throw new NotFoundException('Care recipient not found');
    if (existing.patientId !== patientId) throw new ForbiddenException('Access denied');
    return { familyGroupId: existing.familyGroupId };
  }

  /**
   * PYG-484 — แก้/ลบโปรไฟล์ที่อยู่ในกลุ่มผ่าน endpoint ชุดนี้ ต้องลงฟีดของกลุ่มด้วย
   *
   * ★ ทำไมไม่ปิด endpoint นี้สำหรับใบในกลุ่มไปเลย (ให้แก้ผ่าน updateGroupCareRecipient ทางเดียว):
   *   ออกจากกลุ่มแล้วโปรไฟล์ยังค้างอยู่ในกลุ่ม (PYG-477/481) และ mutation ของกลุ่มต้องเป็นสมาชิก ACTIVE
   *   → ถ้าปิดที่นี่ เจ้าของข้อมูลจะแก้/ลบข้อมูลของตัวเองไม่ได้อีกเลย
   * ★ metadata ว่างเหมือน RECIPIENT_* ฝั่ง family-group (เหตุผลเรื่องชื่อในฟีดดูที่นั่น)
   */
  private async writeGroupActivity(
    tx: Prisma.TransactionClient,
    groupId: string,
    actorId: string,
    recipientId: string,
    action: ActivityAction,
  ): Promise<void> {
    await tx.familyGroupActivity.create({
      data: {
        groupId,
        actorId,
        action,
        targetType: ACTIVITY_TARGET.RECIPIENT,
        targetId:   recipientId,
        metadata:   {},
      },
    });
  }

  /** GET /api/v1/patient/care-recipients — list ของ patient */
  async list(patientId: string): Promise<CareRecipientResponse[]> {
    const recipients = await this.prisma.careRecipient.findMany({
      // PYG-460: โปรไฟล์ที่ถูกลบไม่โผล่ในลิสต์ แต่แถวยังอยู่เพื่อไม่ให้ประวัติ
      // การจองที่ผูกกับมันขาดการเชื่อมโยง (ดูเหตุผลเต็มใน migration SQL)
      where:   { patientId, is_deleted: false },
      orderBy: { name: 'asc' },
      select:  RECIPIENT_SELECT,
    });
    return recipients.map((r) => this.toResponse(r as RecipientRow));
  }

  /** POST /api/v1/patient/care-recipients — สร้าง profile ใหม่ */
  async create(
    patientId: string,
    dto: CreateCareRecipientDto,
  ): Promise<CareRecipientResponse> {
    const recipient = await this.prisma.careRecipient.create({
      data: {
        patientId,
        name:     dto.name,
        nickname: dto.nickname ?? null,
        ...(dto.details ? toCareRecipientColumns(dto.details) : {}),
      },
      select: RECIPIENT_SELECT,
    });

    this.logger.log({ event: 'care_recipient.created', id: recipient.id, patientId });
    return this.toResponse(recipient as RecipientRow);
  }

  /** PUT /api/v1/patient/care-recipients/:id — แก้ไข profile */
  async update(
    patientId: string,
    id: string,
    dto: UpdateCareRecipientDto,
  ): Promise<CareRecipientResponse> {
    const { familyGroupId } = await this.assertOwned(patientId, id);

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.careRecipient.update({
        where: { id },
        data: {
          ...(dto.name     !== undefined && { name:     dto.name }),
          ...(dto.nickname !== undefined && { nickname: dto.nickname }),
          // merge ทีละช่อง — mapper คืนเฉพาะคีย์ที่ส่งมาจริง
          ...(dto.details ? toCareRecipientColumns(dto.details) : {}),
        },
        select: RECIPIENT_SELECT,
      });
      if (familyGroupId) {
        await this.writeGroupActivity(tx, familyGroupId, patientId, id, ACTIVITY_ACTION.RECIPIENT_UPDATED);
      }
      return row;
    });

    this.logger.log({ event: 'care_recipient.updated', id, patientId });
    return this.toResponse(updated as RecipientRow);
  }

  /**
   * DELETE /api/v1/patient/care-recipients/:id — soft delete
   *
   * PYG-460: FE มีปุ่มลบ + modal ยืนยันมาตั้งแต่แรก แต่ยังลบแค่ใน state
   * เพราะไม่เคยมี endpoint นี้ (มีคอมเมนต์ NOTE ค้างไว้ในไฟล์ฝั่ง FE)
   *
   * ★ ไม่ใช่ DELETE จริง: bookings.care_recipient_id เป็น ON DELETE SET NULL
   *   → ลบจริงทีเดียว ประวัติการจองทุกใบของคนไข้คนนั้นจะขาดการเชื่อมโยงถาวร
   *   ลบซ้ำใบเดิมได้ผลเหมือนเดิม (ไม่พบ) เพราะ assertOwned กรอง is_deleted ออกแล้ว
   */
  async remove(patientId: string, id: string): Promise<void> {
    const { familyGroupId } = await this.assertOwned(patientId, id);

    await this.prisma.$transaction(async (tx) => {
      await tx.careRecipient.update({
        where: { id },
        data:  { is_deleted: true, deleted_at: new Date() },
      });
      if (familyGroupId) {
        await this.writeGroupActivity(tx, familyGroupId, patientId, id, ACTIVITY_ACTION.RECIPIENT_REMOVED);
      }
    });

    this.logger.log({ event: 'care_recipient.deleted', id, patientId });
  }
}
