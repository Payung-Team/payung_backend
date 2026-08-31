import {
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  IsNotEmpty,
} from 'class-validator';

export class CreateCareRecipientDto {
  /** ชื่อเต็มของผู้รับบริการ */
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  /** ชื่อเล่น (optional) */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  nickname?: string;
}

export class UpdateCareRecipientDto {
  /** ชื่อเต็มของผู้รับบริการ */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string;

  /** ชื่อเล่น */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  nickname?: string;
}
