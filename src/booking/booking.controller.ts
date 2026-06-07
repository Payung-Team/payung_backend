import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { BookingService } from './booking.service';
import { CreateBookingDto } from './dto/create-booking.dto';
import { SearchMatchesDto } from './dto/search-matches.dto';
import { SupabaseHttpAuthGuard } from '../common/guards/supabase-http-auth.guard';
import { HttpRolesGuard } from '../common/guards/http-roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentHttpUser, AuthUser } from '../common/decorators/current-user.decorator';
import { ROLE_ID } from '../common/constants/roles.constant';

/**
 * Booking REST Controller — spec rev 2
 *
 * POST   /api/v1/bookings                    ① สร้าง booking (unmatched)
 * PATCH  /api/v1/bookings/:id/cancel         ② Patient ยกเลิก
 * POST   /api/v1/bookings/search-matches     ③ Basic caregiver matching (Phase 3 placeholder)
 * PATCH  /api/v1/bookings/:id/recover        ④ Phase 5B recovery
 */
@Controller('api/v1/bookings')
@UseGuards(SupabaseHttpAuthGuard, HttpRolesGuard)
@Roles(ROLE_ID.PATIENT)
export class BookingController {
  constructor(private readonly bookingService: BookingService) {}

  // ── ① POST /api/v1/bookings ─────────────────────────────────────────────────
  @Post()
  @HttpCode(HttpStatus.CREATED)
  createBooking(
    @Body() dto: CreateBookingDto,
    @CurrentHttpUser() user: AuthUser,
  ) {
    return this.bookingService.createBooking(user.id, dto);
  }

  // ── ③ POST /api/v1/bookings/search-matches ─────────────────────────────────
  // ⚠️ MUST be declared BEFORE :id routes to prevent Express matching
  // "search-matches" as a UUID param.
  @Post('search-matches')
  @HttpCode(HttpStatus.OK)
  searchMatches(@Body() dto: SearchMatchesDto) {
    return this.bookingService.searchMatchesBasic(dto);
  }

  // ── ② PATCH /api/v1/bookings/:id/cancel ────────────────────────────────────
  @Patch(':id/cancel')
  cancelBooking(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentHttpUser() user: AuthUser,
  ) {
    return this.bookingService.cancelBooking(id, user.id);
  }

  // ── ④ PATCH /api/v1/bookings/:id/recover ───────────────────────────────────
  @Patch(':id/recover')
  recoverBooking(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentHttpUser() user: AuthUser,
  ) {
    return this.bookingService.recoverBooking(id, user.id);
  }
}

/**
 * BookingTaskSuggestionsController
 *
 * GET /api/v1/booking-task-suggestions?service_type=X
 *
 * No auth required — public reference data.
 */
@Controller('api/v1/booking-task-suggestions')
export class BookingTaskSuggestionsController {
  constructor(private readonly bookingService: BookingService) {}

  @Get()
  getTaskSuggestions(@Query('service_type') serviceType: string) {
    return this.bookingService.getTaskSuggestions(serviceType ?? '');
  }
}
