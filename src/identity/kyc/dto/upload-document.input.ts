import { InputType, Field, Int } from '@nestjs/graphql';
import { IsString, IsNotEmpty, IsInt, Min } from 'class-validator';

@InputType()
export class UploadDocumentInput {
  @Field()
  @IsString()
  @IsNotEmpty()
  docType: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  fileUrl: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  fileName: string;

  @Field(() => Int)
  @IsInt()
  @Min(1)
  fileSize: number;

  @Field()
  @IsString()
  @IsNotEmpty()
  mimeType: string;
}
