import { Injectable } from '@nestjs/common';
import { Context, Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { PrismaService } from '../../common/prisma.service';
import { CareLevel } from '../../common/care-level/care-level';
import { BookingSummary } from '../dto/booking-summary.types';
import { CaregiverBookingSummary } from '../dto/caregiver-booking.types';
import { GroupBookingSummary } from '../../family-group/entities/group-booking.entity';
import {
  BookingLevelBreakdown,
  SavedBookingLevel,
} from './booking-level.types';
import { readSavedBookingLevels } from './booking-level.read';

type Pending = {
  id: string;
  resolve: (value: SavedBookingLevel) => void;
  reject: (error: unknown) => void;
};
@Injectable()
export class BookingLevelReader {
  private readonly batches = new WeakMap<object, Pending[]>();
  constructor(private readonly prisma: PrismaService) {}
  load(id: string, context: object): Promise<SavedBookingLevel> {
    return new Promise((resolve, reject) => {
      let batch = this.batches.get(context);
      if (!batch) {
        batch = [];
        this.batches.set(context, batch);
        queueMicrotask(() => {
          const items = batch!;
          this.batches.delete(context);
          readSavedBookingLevels(
            this.prisma,
            items.map((item) => item.id),
          ).then(
            (rows) => {
              for (const item of items) {
                const row = rows.get(item.id);
                if (row) item.resolve(row);
                else item.reject(new Error('Booking no longer exists'));
              }
            },
            (error: unknown) => items.forEach((item) => item.reject(error)),
          );
        });
      }
      batch.push({ id, resolve, reject });
    });
  }
}

// Authorization stays at the existing root operation; no new booking lookup API.
@Resolver(() => BookingSummary)
export class BookingLevelResolver {
  constructor(private readonly reader: BookingLevelReader) {}
  @ResolveField(() => CareLevel, { nullable: true })
  async requiredLevel(
    @Parent() booking: BookingSummary,
    @Context() context: object,
  ) {
    return (await this.reader.load(booking.id, context)).requiredLevel;
  }
  @ResolveField(() => BookingLevelBreakdown, { nullable: true })
  async levelBreakdown(
    @Parent() booking: BookingSummary,
    @Context() context: object,
  ) {
    return (await this.reader.load(booking.id, context)).levelBreakdown;
  }
}
@Resolver(() => CaregiverBookingSummary)
export class CaregiverBookingLevelResolver {
  constructor(private readonly reader: BookingLevelReader) {}
  @ResolveField(() => CareLevel, { nullable: true })
  async requiredLevel(
    @Parent() booking: CaregiverBookingSummary,
    @Context() context: object,
  ) {
    return (await this.reader.load(booking.id, context)).requiredLevel;
  }
  @ResolveField(() => BookingLevelBreakdown, { nullable: true })
  async levelBreakdown(
    @Parent() booking: CaregiverBookingSummary,
    @Context() context: object,
  ) {
    return (await this.reader.load(booking.id, context)).levelBreakdown;
  }
}
@Resolver(() => GroupBookingSummary)
export class GroupBookingLevelResolver {
  constructor(private readonly reader: BookingLevelReader) {}
  @ResolveField(() => CareLevel, { nullable: true })
  async requiredLevel(
    @Parent() booking: GroupBookingSummary,
    @Context() context: object,
  ) {
    return (await this.reader.load(booking.id, context)).requiredLevel;
  }
  @ResolveField(() => BookingLevelBreakdown, { nullable: true })
  async levelBreakdown(
    @Parent() booking: GroupBookingSummary,
    @Context() context: object,
  ) {
    return (await this.reader.load(booking.id, context)).levelBreakdown;
  }
}
