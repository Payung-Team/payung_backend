import { Field, ObjectType } from '@nestjs/graphql';

/** ทักษะกลาง 1 รายการ (care_skills) — PYG-652 */
@ObjectType({ description: 'Central caregiver skill (care_skills)' })
export class CareSkillItem {
  @Field({ description: 'Skill code, e.g. "transfer_assist"' })
  code!: string;

  @Field({ description: 'Thai name' })
  nameTh!: string;

  @Field({ description: 'English name' })
  nameEn!: string;
}
