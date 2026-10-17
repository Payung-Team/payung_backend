import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import {
  AuthUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { AssessmentService } from './assessment.service';
import {
  CareRecipientAssessment,
  SubmitCareRecipientAssessmentInput,
} from './dto/assessment.types';

@Resolver()
@UseGuards(SupabaseAuthGuard)
export class AssessmentResolver {
  constructor(private readonly assessments: AssessmentService) {}
  @Mutation(() => CareRecipientAssessment)
  submitCareRecipientAssessment(
    @CurrentUser() actor: AuthUser,
    @Args('input') input: SubmitCareRecipientAssessmentInput,
  ) {
    return this.assessments.submit(actor.id, input);
  }
  @Query(() => CareRecipientAssessment, { nullable: true })
  careRecipientAssessment(
    @CurrentUser() actor: AuthUser,
    @Args('careRecipientId', { type: () => ID }) careRecipientId: string,
  ) {
    return this.assessments.read(actor.id, careRecipientId);
  }
}
