import { Field, ObjectType } from '@nestjs/graphql';

/**
 * ข้อมูลโรคติดเชื้อในคำขอรับงาน (PYG-619 · contract PYG-617)
 *
 * ⚠ ข้อมูลสุขภาพ: ใช้เฉพาะ CaregiverBookingSummary.infectionDisclosure เท่านั้น
 *   ห้ามนำ type นี้ไปใช้ใน type สาธารณะ หน้า List/Profile แอดมิน หรือ notification
 */
@ObjectType({ description: 'Infectious-disease info the relative reported (health data; request recipient only)' })
export class InfectionDisclosure {
  @Field(() => Boolean, {
    nullable: true,
    description: 'null = relative has not specified (NOT the same as "no"); true = reported by relative; false = relative reported none',
  })
  hasInfectiousDisease!: boolean | null;

  @Field(() => Date, {
    nullable: true,
    description: 'When this caregiver acknowledged the latest value; null if not yet (or acknowledged before the relative changed it)',
  })
  acknowledgedAt!: Date | null;
}
