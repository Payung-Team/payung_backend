import { Injectable, InternalServerErrorException } from '@nestjs/common';
import type { CareRecipientAssessment as AssessmentRow } from '@prisma/client';
import { isUUID } from 'class-validator';
import { PrismaService } from '../common/prisma.service';
import { classifyCareGroup, storedCareGroupToApi } from '../common/care-group';
import { ConsentService } from '../consent/consent.service';
import { CONSENT_TYPE } from '../consent/consent.constants';
import { ADL_ITEMS, type AdlAnswers } from './assessment.constants';
import { AssessmentError, assessmentAccessDenied } from './assessment.errors';
import { validateAssessmentValues } from './assessment-scoring';
import { recalculateRecipientBookingRequirements } from '../booking/booking-requirements.persistence';
import { BookingLevelError } from '../booking/level/booking-level.errors';
import { SkillRuleInvalidError } from '../booking/required-skills/required-skills.errors';
import {
  CareRecipientAssessment,
  SubmitCareRecipientAssessmentInput,
} from './dto/assessment.types';

@Injectable()
export class AssessmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly consent: ConsentService,
  ) {}

  async submit(
    actorId: string,
    input: SubmitCareRecipientAssessmentInput,
  ): Promise<CareRecipientAssessment> {
    if (!isUUID(input.careRecipientId)) throw assessmentAccessDenied();
    return this.protectHealthData(() =>
      this.prisma.$transaction(async (tx) => {
        // Parent lock serializes first saves and soft deletion; no resurrection.
        await tx.$queryRaw`SELECT id FROM care_recipients WHERE id = ${input.careRecipientId}::uuid FOR UPDATE`;
        const recipient = await tx.careRecipient.findUnique({
          where: { id: input.careRecipientId },
          select: { patientId: true, is_deleted: true },
        });
        if (
          !recipient ||
          recipient.is_deleted ||
          recipient.patientId !== actorId
        )
          throw assessmentAccessDenied();
        const values = validateAssessmentValues(input);
        const now = new Date();
        const data = {
          ...values,
          careGroup: classifyCareGroup(values.adlTotalScore),
          assessedBy: actorId,
          assessedAt: now,
          updatedAt: now,
        };
        const row = await tx.careRecipientAssessment.upsert({
          where: { careRecipientId: input.careRecipientId },
          create: { careRecipientId: input.careRecipientId, ...data },
          update: data,
        });
        await recalculateRecipientBookingRequirements(tx, input.careRecipientId);
        return this.toResponse(row);
      }),
    );
  }

  async read(actorId: string, careRecipientId: string) {
    return this.protectHealthData(() =>
      this.readAuthorized(actorId, careRecipientId),
    );
  }

  private async readAuthorized(actorId: string, careRecipientId: string) {
    if (!isUUID(careRecipientId)) throw assessmentAccessDenied();
    const recipient = await this.prisma.careRecipient.findUnique({
      where: { id: careRecipientId },
      select: { patientId: true, is_deleted: true, familyGroupId: true },
    });
    if (!recipient || recipient.is_deleted) throw assessmentAccessDenied();
    if (recipient.patientId !== actorId) {
      if (!recipient.familyGroupId) throw assessmentAccessDenied();
      const members = await this.prisma.familyGroupMember.findMany({
        where: {
          groupId: recipient.familyGroupId,
          userId: { in: [actorId, recipient.patientId] },
          status: 'ACTIVE',
        },
        select: { userId: true },
      });
      if (new Set(members.map((member) => member.userId)).size !== 2)
        throw assessmentAccessDenied();
      if (
        await this.consent.findWithdrawnType(recipient.patientId, [
          CONSENT_TYPE.DISCLOSE_TO_FAMILY_GROUP,
        ])
      ) {
        throw assessmentAccessDenied();
      }
    }
    const row = await this.prisma.careRecipientAssessment.findUnique({
      where: { careRecipientId },
    });
    return row ? this.toResponse(row) : null;
  }

  private async protectHealthData<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AssessmentError || error instanceof SkillRuleInvalidError || error instanceof BookingLevelError) throw error;
      // Database exceptions can contain query values. Do not expose or log them.
      throw new InternalServerErrorException(
        'ไม่สามารถดำเนินการกับแบบประเมินได้ในขณะนี้',
      );
    }
  }

  private toResponse(row: AssessmentRow): CareRecipientAssessment {
    const answers = row.adlAnswers as AdlAnswers;
    return {
      careRecipientId: row.careRecipientId,
      answers: ADL_ITEMS.map(({ code }) => ({ code, value: answers[code] })),
      adlTotalScore: row.adlTotalScore,
      careGroup: storedCareGroupToApi(row.careGroup),
      unsureCount: row.unsureCount,
      flags: [...row.flags],
      noSpecialConditions: row.noSpecialConditions,
      hasUnsureFlag: row.hasUnsureFlag,
      dementiaSevere: row.dementiaSevere,
      assessedAt: row.assessedAt,
    };
  }
}
