import { Resolver, Query, Args } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { SearchService } from './search.service';
import { SearchCaregiverInput } from './dto/search-caregiver.input';
import { SearchCaregiverPayload } from './dto/search-caregiver.payload';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ROLE_ID } from '../common/constants/roles.constant';

@Resolver()
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles(ROLE_ID.PATIENT, ROLE_ID.CAREGIVER, ROLE_ID.ADMIN, ROLE_ID.SUPER_ADMIN)
export class SearchResolver {
  constructor(private readonly searchService: SearchService) {}

  /**
   * searchCaregivers — ค้นหา caregiver พร้อม filter + pagination
   *
   * @example
   * query {
   *   searchCaregivers(input: {
   *     province: "เชียงใหม่"
   *     jobType: "general_care,overnight"
   *     minPrice: 200
   *     maxPrice: 500
   *     minRating: 4
   *     sortBy: rating_desc
   *     page: 1
   *     limit: 10
   *   }) {
   *     data { id fullName hourlyRate avgRating reviewCount skills province district }
   *     pagination { page limit total totalPages }
   *   }
   * }
   */
  @Query(() => SearchCaregiverPayload, {
    description:
      'Search caregivers with filters (province, district, job type, price range, min rating). ' +
      'Only returns verified + searchable caregivers who have at least one active availability slot.',
  })
  async searchCaregivers(
    @Args('input', { nullable: true, defaultValue: {} }) input: SearchCaregiverInput,
  ): Promise<SearchCaregiverPayload> {
    return this.searchService.searchCaregivers(input);
  }
}
