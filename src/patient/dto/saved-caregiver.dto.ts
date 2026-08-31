import { IsNotEmpty, IsUUID } from 'class-validator';

export class SaveCaregiverDto {
  /** ID ของ caregiver ที่ต้องการ save */
  @IsUUID()
  @IsNotEmpty()
  caregiverId!: string;
}
