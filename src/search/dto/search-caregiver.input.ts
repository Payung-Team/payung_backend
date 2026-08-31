import { InputType, Field, Int, Float, registerEnumType } from '@nestjs/graphql';
import { IsEnum, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export enum SortByEnum {
  RATING_DESC = 'rating_desc',
  PRICE_ASC   = 'price_asc',
  PRICE_DESC  = 'price_desc',
}

registerEnumType(SortByEnum, {
  name: 'SortByEnum',
  description: 'Caregiver search sort order',
});

@InputType()
export class SearchCaregiverInput {
  @Field({ nullable: true, description: 'Filter by service area province' })
  @IsOptional()
  @IsString()
  province?: string;

  @Field({ nullable: true, description: 'Filter by service area district' })
  @IsOptional()
  @IsString()
  district?: string;

  @Field({ nullable: true, description: 'Comma-separated job types e.g. "general_care,overnight"' })
  @IsOptional()
  @IsString()
  jobType?: string;

  @Field(() => Float, { nullable: true, description: 'Minimum hourly rate' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minPrice?: number;

  @Field(() => Float, { nullable: true, description: 'Maximum hourly rate' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  maxPrice?: number;

  @Field(() => Float, { nullable: true, description: 'Minimum average rating (0–5)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(5)
  minRating?: number;

  @Field(() => SortByEnum, { nullable: true, defaultValue: SortByEnum.RATING_DESC })
  @IsOptional()
  @IsEnum(SortByEnum)
  sortBy?: SortByEnum;

  @Field(() => Int, { nullable: true, defaultValue: 1, description: 'Page number (1-based)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @Field(() => Int, { nullable: true, defaultValue: 10, description: 'Results per page (max 50)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
