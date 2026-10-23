import { Field, ID, ObjectType } from '@nestjs/graphql';
import { ElderCareGroup } from '../common/graphql/elder-care-group.enum';

@ObjectType()
export class ServicePackageItem {
  @Field() serviceType!: string;
  @Field() nameTh!: string;
  @Field() nameEn!: string;
}

@ObjectType()
export class ServicePackage {
  @Field(() => ID) id!: string;
  @Field() code!: string;
  @Field() nameTh!: string;
  @Field() nameEn!: string;
  @Field(() => String, { nullable: true }) descriptionTh!: string | null;
  @Field(() => String, { nullable: true }) descriptionEn!: string | null;
  @Field(() => Boolean, { nullable: true }) containsSelectedServiceType!:
    | boolean
    | null;
  @Field(() => [ServicePackageItem]) items!: ServicePackageItem[];
}

@ObjectType()
export class RecommendedServicePackages {
  @Field(() => ElderCareGroup, { nullable: true })
  careGroup!: ElderCareGroup | null;
  @Field(() => [ServicePackage]) packages!: ServicePackage[];
}
