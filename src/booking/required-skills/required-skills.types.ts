import { Field, ObjectType, registerEnumType } from '@nestjs/graphql';
import { CareSkillItem } from '../../care-skill/entities/care-skill.entity';

export enum RequiredSkillSource {
  ADL = 'ADL',
  FLAG = 'FLAG',
  SERVICE = 'SERVICE',
}
registerEnumType(RequiredSkillSource, { name: 'RequiredSkillSource' });

@ObjectType()
export class BookingRequiredSkill {
  @Field(() => CareSkillItem) skill!: CareSkillItem;
  @Field(() => [RequiredSkillSource]) sources!: RequiredSkillSource[];
}

export type SkillSource = 'adl' | 'flag' | 'service';
export interface RequiredSkillResult {
  code: string;
  sources: SkillSource[];
}
