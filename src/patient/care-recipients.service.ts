import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
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
  /** PYG-460: ข้อมูลสุขภาพ — undefined เมื่อโปรไฟล์ยังไม่เคยกรอกช่องไหนเลย */
  details?: PatientProfileDto;
}

/** select ชุดเดียวใช้ทั้ง list/create/update — กัน response สามที่หลุดรูปทรงกัน */
const RECIPIENT_SELECT = {
  id:        true,
  name:      true,
  nickname:  true,
  patientId: true,
  ...PATIENT_PROFILE_SELECT,
} as const;

type RecipientRow = {
  id: string;
  name: string;
  nickname: string | null;
  patientId: string;
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
      details:   toPatientProfile(row),
    };
  }

  /**
   * เจ้าของโปรไฟล์ต้องเป็น patient คนนี้ และโปรไฟล์ต้องยังไม่ถูกลบ
   *
   * "ไม่พบ" กับ "ไม่ใช่ของคุณ" ตอบคนละ exception โดยตั้งใจ — ตรงกับพฤติกรรมเดิม
   * ของ update() ก่อน PYG-460 และ endpoint ชุดนี้ต้อง login อยู่แล้ว จึงไม่ได้
   * เปิดช่องให้ไล่เดา id จากภายนอก
   */
  private async assertOwned(patientId: string, id: string): Promise<void> {
    const existing = await this.prisma.careRecipient.findUnique({
      where:  { id },
      select: { patientId: true, is_deleted: true },
    });

    if (!existing || existing.is_deleted) throw new NotFoundException('Care recipient not found');
    if (existing.patientId !== patientId) throw new ForbiddenException('Access denied');
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
    await this.assertOwned(patientId, id);

    const updated = await this.prisma.careRecipient.update({
      where: { id },
      data: {
        ...(dto.name     !== undefined && { name:     dto.name }),
        ...(dto.nickname !== undefined && { nickname: dto.nickname }),
        // merge ทีละช่อง — mapper คืนเฉพาะคีย์ที่ส่งมาจริง
        ...(dto.details ? toCareRecipientColumns(dto.details) : {}),
      },
      select: RECIPIENT_SELECT,
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
    await this.assertOwned(patientId, id);

    await this.prisma.careRecipient.update({
      where: { id },
      data:  { is_deleted: true, deleted_at: new Date() },
    });

    this.logger.log({ event: 'care_recipient.deleted', id, patientId });
  }
}
