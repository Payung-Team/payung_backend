import { IsString, MinLength } from 'class-validator';

export class AddDisputeNoteDto {
  @IsString()
  @MinLength(1)
  body!: string;
}
