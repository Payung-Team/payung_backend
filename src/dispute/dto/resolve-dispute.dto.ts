import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MinLength,
} from 'class-validator';

/**
 * REST-only vocabulary for PATCH /api/v1/admin/disputes/:id/resolve.
 * Maps to the GraphQL DisputeDecision enum inside DisputeService — kept separate
 * so the GraphQL contract (refund_full | refund_partial | no_refund) never changes.
 */
export enum DisputeResolutionAction {
  full_refund = 'full_refund',
  partial_refund = 'partial_refund',
  reject = 'reject',
}

export class ResolveDisputeDto {
  @IsEnum(DisputeResolutionAction)
  resolution!: DisputeResolutionAction;

  /** required when resolution = partial_refund */
  @IsOptional()
  @IsNumber()
  @IsPositive()
  amount?: number;

  @IsString()
  @MinLength(1)
  reason!: string;
}
