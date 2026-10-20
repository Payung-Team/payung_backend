import { Field, ObjectType } from '@nestjs/graphql';
import { CaregiverProfession } from '../../identity/kyc/profession.constants';

/** ทักษะกลาง 1 รายการ (care_skills) — PYG-652 */
@ObjectType({ description: 'Central caregiver skill (care_skills)' })
export class CareSkillItem {
  @Field(() => [CaregiverProfession], { description: 'Allowed professions; empty means unrestricted' })
  lockedProfessions?: CaregiverProfession[];

  @Field({ description: 'Skill code, e.g. "transfer_assist"' })
  code!: string;

  @Field({ description: 'Thai name' })
  nameTh!: string;

  @Field({ description: 'English name' })
  nameEn!: string;
}
