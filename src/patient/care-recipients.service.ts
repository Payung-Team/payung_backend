import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { CreateCareRecipientDto, UpdateCareRecipientDto } from './dto/care-recipient.dto';

export interface CareRecipientResponse {
  id: string;
  name: string;
  nickname?: string;
  patientId: string;
}

@Injectable()
export class CareRecipientsService {
  private readonly logger = new Logger(CareRecipientsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** GET /api/v1/patient/care-recipients — list ของ patient */
  async list(patientId: string): Promise<CareRecipientResponse[]> {
    const recipients = await this.prisma.careRecipient.findMany({
      where:   { patientId },
      orderBy: { name: 'asc' },
      select:  { id: true, name: true, nickname: true, patientId: true },
    });
    return recipients.map((r) => ({
      id:       r.id,
      name:     r.name,
      nickname: r.nickname ?? undefined,
      patientId: r.patientId,
    }));
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
      },
      select: { id: true, name: true, nickname: true, patientId: true },
    });

    this.logger.log({ event: 'care_recipient.created', id: recipient.id, patientId });
    return {
      id:       recipient.id,
      name:     recipient.name,
      nickname: recipient.nickname ?? undefined,
      patientId: recipient.patientId,
    };
  }

  /** PUT /api/v1/patient/care-recipients/:id — แก้ไข profile */
  async update(
    patientId: string,
    id: string,
    dto: UpdateCareRecipientDto,
  ): Promise<CareRecipientResponse> {
    const existing = await this.prisma.careRecipient.findUnique({
      where:  { id },
      select: { patientId: true },
    });

    if (!existing) throw new NotFoundException('Care recipient not found');
    if (existing.patientId !== patientId)
      throw new ForbiddenException('Access denied');

    const updated = await this.prisma.careRecipient.update({
      where: { id },
      data: {
        ...(dto.name     !== undefined && { name:     dto.name }),
        ...(dto.nickname !== undefined && { nickname: dto.nickname }),
      },
      select: { id: true, name: true, nickname: true, patientId: true },
    });

    this.logger.log({ event: 'care_recipient.updated', id, patientId });
    return {
      id:       updated.id,
      name:     updated.name,
      nickname: updated.nickname ?? undefined,
      patientId: updated.patientId,
    };
  }
}
