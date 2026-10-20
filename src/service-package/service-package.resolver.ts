import { UseGuards } from '@nestjs/common';
import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import {
  AuthUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { ServicePackageService } from './service-package.service';
import { RecommendedServicePackages } from './service-package.types';

@Resolver()
@UseGuards(SupabaseAuthGuard)
export class RecommendedServicePackagesResolver {
  constructor(private readonly packages: ServicePackageService) {}

  @Query(() => RecommendedServicePackages)
  recommendedServicePackages(
    @CurrentUser() actor: AuthUser,
    @Args('careRecipientId', { type: () => ID }) careRecipientId: string,
    @Args('selectedServiceType', { type: () => String, nullable: true })
    selectedServiceType?: string | null,
  ) {
    return this.packages.recommended(
      actor.id,
      careRecipientId,
      selectedServiceType,
    );
  }
}
