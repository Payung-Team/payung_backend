import { Injectable } from '@nestjs/common';
import { Context, Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { PrismaService } from '../../common/prisma.service';
import { BookingSummary } from '../dto/booking-summary.types';
import { CaregiverBookingSummary } from '../dto/caregiver-booking.types';
import { GroupBookingSummary } from '../../family-group/entities/group-booking.entity';
import { BookingRequiredSkill } from './required-skills.types';
import { readSavedRequiredSkills } from './required-skills.read';

type Pending = {
  id: string;
  resolve: (value: BookingRequiredSkill[] | null) => void;
  reject: (error: unknown) => void;
};

/** One SQL read per resolver wave, shared by the three authorized booking views. */
@Injectable()
export class RequiredSkillsReader {
  private readonly batches = new WeakMap<object, Pending[]>();
  constructor(private readonly prisma: PrismaService) {}
  load(id: string, context: object): Promise<BookingRequiredSkill[] | null> {
    return new Promise((resolve, reject) => {
      let batch = this.batches.get(context);
      if (!batch) {
        batch = [];
        this.batches.set(context, batch);
        queueMicrotask(() => {
          const pending = batch!;
          this.batches.delete(context);
          readSavedRequiredSkills(
            this.prisma,
            pending.map((item) => item.id),
          ).then(
            (rows) => {
              for (const item of pending) {
                if (!rows.has(item.id))
                  item.reject(new Error('Booking no longer exists'));
                else item.resolve(rows.get(item.id)!);
              }
            },
            (error: unknown) => pending.forEach((item) => item.reject(error)),
          );
        });
      }
      batch.push({ id, resolve, reject });
    });
  }
}

// Root operations retain their existing guards and relationship checks.
@Resolver(() => BookingSummary)
export class BookingRequiredSkillsResolver {
  constructor(private readonly reader: RequiredSkillsReader) {}
  @ResolveField(() => [BookingRequiredSkill], { nullable: true })
  requiredSkills(
    @Parent() booking: BookingSummary,
    @Context() context: object,
  ) {
    return this.reader.load(booking.id, context);
  }
}

@Resolver(() => CaregiverBookingSummary)
export class CaregiverRequiredSkillsResolver {
  constructor(private readonly reader: RequiredSkillsReader) {}
  @ResolveField(() => [BookingRequiredSkill], { nullable: true })
  requiredSkills(
    @Parent() booking: CaregiverBookingSummary,
    @Context() context: object,
  ) {
    return this.reader.load(booking.id, context);
  }
}

@Resolver(() => GroupBookingSummary)
export class GroupRequiredSkillsResolver {
  constructor(private readonly reader: RequiredSkillsReader) {}
  @ResolveField(() => [BookingRequiredSkill], { nullable: true })
  requiredSkills(
    @Parent() booking: GroupBookingSummary,
    @Context() context: object,
  ) {
    return this.reader.load(booking.id, context);
  }
}
