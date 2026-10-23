import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { GraphQLError } from 'graphql';
import { assertAssessmentReadAccess } from '../assessment/assessment-read-access';
import { PrismaService } from '../common/prisma.service';
import { storedCareGroupToApi } from '../common/care-group';
import { ConsentService } from '../consent/consent.service';
import {
  JOB_TYPES,
  JobTypeValue,
} from '../identity/kyc/job-type/job-type-rules';
import { SERVICE_TYPE_LABELS } from './service-package.labels';
import { RecommendedServicePackages } from './service-package.types';

@Injectable()
export class ServicePackageService {
  private readonly logger = new Logger(ServicePackageService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly consent: ConsentService,
  ) {}

  async recommended(
    actorId: string,
    careRecipientId: string,
    selectedServiceType?: string | null,
  ): Promise<RecommendedServicePackages> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await assertAssessmentReadAccess(
            tx,
            this.consent,
            actorId,
            careRecipientId,
          );
          if (
            selectedServiceType != null &&
            !(JOB_TYPES as readonly string[]).includes(selectedServiceType)
          ) {
            throw new GraphQLError('ประเภทบริการไม่ถูกต้อง', {
              extensions: { code: 'BAD_USER_INPUT', statusCode: 422 },
            });
          }
          // S08 keeps one upserted assessment per recipient; this is its latest S09 group.
          const assessment = await tx.careRecipientAssessment.findUnique({
            where: { careRecipientId },
            select: { careGroup: true },
          });
          if (!assessment) return { careGroup: null, packages: [] };
          if (
            !['social', 'homebound', 'bedridden'].includes(
              assessment.careGroup ?? '',
            )
          ) {
            // Do not put recipient IDs, health values, or raw database errors in logs.
            this.logger.warn({ event: 'service_packages.unknown_care_group' });
            return { careGroup: null, packages: [] };
          }
          const careGroup = storedCareGroupToApi(assessment.careGroup);
          const rows = await tx.careGroupServicePackage.findMany({
            where: {
              careGroup: assessment.careGroup!,
              isActive: true,
              package: { isActive: true },
            },
            orderBy: [
              { sortOrder: 'asc' },
              { package: { sortOrder: 'asc' } },
              { package: { code: 'asc' } },
            ],
            include: {
              package: {
                include: {
                  items: {
                    orderBy: [{ sortOrder: 'asc' }, { serviceType: 'asc' }],
                  },
                },
              },
            },
          });
          return {
            careGroup,
            packages: rows
              .sort(
                (a, b) =>
                  a.sortOrder - b.sortOrder ||
                  a.package.sortOrder - b.package.sortOrder ||
                  ascii(a.package.code, b.package.code),
              )
              .map(({ package: value }) => ({
                id: value.id,
                code: value.code,
                nameTh: value.nameTh,
                nameEn: value.nameEn,
                descriptionTh: value.descriptionTh,
                descriptionEn: value.descriptionEn,
                containsSelectedServiceType:
                  selectedServiceType == null
                    ? null
                    : value.items.some(
                        (item) => item.serviceType === selectedServiceType,
                      ),
                items: value.items
                  .sort(
                    (a, b) =>
                      a.sortOrder - b.sortOrder ||
                      ascii(a.serviceType, b.serviceType),
                  )
                  .map((item) => {
                    if (
                      !Object.prototype.hasOwnProperty.call(
                        SERVICE_TYPE_LABELS,
                        item.serviceType,
                      )
                    )
                      throw new InternalServerErrorException();
                    const labels =
                      SERVICE_TYPE_LABELS[item.serviceType as JobTypeValue];
                    if (!labels) throw new InternalServerErrorException();
                    return { serviceType: item.serviceType, ...labels };
                  }),
              })),
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
    } catch (error) {
      if (error instanceof GraphQLError) throw error;
      throw new InternalServerErrorException(
        'ไม่สามารถอ่านชุดบริการที่แนะนำได้ในขณะนี้',
      );
    }
  }
}

function ascii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
