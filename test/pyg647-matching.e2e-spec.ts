/** Matching uses only a disposable local Docker Postgres, never deployment data. */
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaService } from '../src/common/prisma.service';
import { ClockService } from '../src/common/clock.service';
import { AuthUser } from '../src/common/decorators/current-user.decorator';
import { SearchService } from '../src/search/search.service';
import { MatchingService } from '../src/matching/matching.service';
import { BookingService } from '../src/booking/booking.service';
import { CareActivityService } from '../src/care-activity/care-activity.service';
import { ConsentService } from '../src/consent/consent.service';
import { AssessmentService } from '../src/assessment/assessment.service';
import { ADL_ITEMS } from '../src/assessment/assessment.constants';
import { recalculateBookingRequirements } from '../src/booking/booking-requirements.persistence';
import { seedBookingLevelRules } from './fixtures/booking-level-rules';
const urlValue = process.env.PYG609_DATABASE_URL;
if (urlValue) {
  const url = new URL(urlValue);
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname != '/pyg609_test' ||
    /supabase/i.test(urlValue)
  )
    throw new Error('S18 requires disposable localhost pyg609_test');
} else if (process.env.CI)
  throw new Error('PYG609_DATABASE_URL required for S18 in CI');
const describeDb = urlValue ? describe : describe.skip;
describeDb(
  'PYG-647 S18: Postgres authorization, selection and disclosure',
  () => {
    let db: PrismaService;
    let sql: Client;
    let matching: MatchingService;
    let bookings: BookingService;
    let assessments: AssessmentService;
    const users: string[] = [];
    const caregivers: string[] = [];
    const groups: string[] = [];
    const emitter = { emit: jest.fn() };
    const avatars = {
      resolveMany: jest.fn(
        async (rows: unknown[]) =>
          new Map(
            rows.map((row) => [row, 'https://example.test/approved-avatar']),
          ),
      ),
    };
    const oldContact = process.env.MATCHING_ADMIN_CONTACT_URL;
    beforeAll(async () => {
      db = new PrismaClient({
        adapter: new PrismaPg({ connectionString: urlValue }),
      }) as PrismaService;
      await db.$connect();
      await seedBookingLevelRules(db);
      sql = new Client({ connectionString: urlValue });
      await sql.connect();
      await sql.query(
        readFileSync(
          join(
            __dirname,
            '../prisma/migrations/20261009000000_pyg570_seed_required_skills/migration.sql',
          ),
          'utf8',
        ),
      );
      for (const serviceType of [
        'elderly_care',
        'general_care',
        'physiotherapy',
      ])
        await db.servicePriceCatalog.upsert({
          where: { serviceType },
          create: { serviceType, pricePerHour: 100 },
          update: { isActive: true },
        });
      matching = new MatchingService(
        db,
        new SearchService(db, avatars as never),
        { now: () => new Date('2026-10-20T08:00:00Z') } as ClockService,
        emitter as never,
      );
      bookings = new BookingService(
        db,
        emitter as never,
        {} as never,
        { createForBooking: jest.fn() } as never,
        new ConsentService(db),
        avatars as never,
        new CareActivityService(db, new ClockService()),
      );
      assessments = new AssessmentService(db, new ConsentService(db));
    });
    afterAll(async () => {
      if (oldContact === undefined)
        delete process.env.MATCHING_ADMIN_CONTACT_URL;
      else process.env.MATCHING_ADMIN_CONTACT_URL = oldContact;
      if (db) {
        await db.booking.deleteMany({ where: { patientId: { in: users } } });
        await db.caregiver_edit_logs.deleteMany({
          where: { caregiver_id: { in: caregivers } },
        });
        await db.kycDocument.deleteMany({ where: { userId: { in: users } } });
        await db.caregiver.deleteMany({ where: { id: { in: caregivers } } });
        await db.careRecipientAssessment.deleteMany({
          where: { assessedBy: { in: users } },
        });
        await db.careRecipient.deleteMany({
          where: { patientId: { in: users } },
        });
        await db.familyGroup.deleteMany({ where: { id: { in: groups } } });
        await db.user.deleteMany({ where: { id: { in: users } } });
        await db.$disconnect();
      }
      await sql?.end();
    });
    async function user(role = 1) {
      const id = randomUUID();
      const u = await db.user.create({
        data: {
          supabaseUid: id,
          email: `${id}@pyg647.test`,
          firstName: 'Test',
          lastName: 'S18',
          role,
        },
      });
      users.push(u.id);
      return { ...u, isSuspended: false } as AuthUser;
    }
    async function fixture(serviceType = 'elderly_care') {
      const owner = await user();
      const recipient = await db.careRecipient.create({
        data: { patientId: owner.id, name: 'S18', medical_conditions: [] },
      });
      const input = {
        careRecipientId: recipient.id,
        answers: ADL_ITEMS.map(({ code, maxScore }) => ({
          code,
          value: maxScore,
        })),
        flags: [] as string[],
        noSpecialConditions: true,
      };
      await assessments.submit(owner.id, input);
      const b = await db.booking.create({
        data: {
          patientId: owner.id,
          careRecipientId: recipient.id,
          status: 'unmatched',
          serviceType: serviceType as 'elderly_care' | 'physiotherapy',
          timeSlot: 'morning',
          bookingDate: new Date('2035-10-20'),
          startTime: new Date('1970-01-01T09:00:00Z'),
          durationHours: 4,
          locationAddress: 'Test',
        },
      });
      await db.$transaction((tx) => recalculateBookingRequirements(tx, b.id));
      return { owner, recipient, input, booking: b };
    }
    async function caregiver(
      overrides: {
        profession?: string;
        careLevel?: string | null;
        skills?: string[];
        kycStatus?: string;
        isSearchable?: boolean;
        available?: boolean;
      } = {},
    ) {
      const u = await user(2);
      const { available = true, ...fields } = overrides;
      const c = await db.caregiver.create({
        data: {
          userId: u.id,
          fullName: 'Matching test',
          skills: [],
          skillsLegacy: [],
          careLevel: 'advanced',
          profession: 'general_caregiver',
          isSearchable: true,
          kycStatus: 'verified',
          ...fields,
        },
      });
      caregivers.push(c.id);
      if (available)
        await db.caregiverAvailability.createMany({
          data: Array.from({ length: 7 }, (_, dayOfWeek) =>
            ['morning', 'afternoon', 'evening'].map((timeSlot) => ({
              caregiverId: c.id,
              dayOfWeek,
              timeSlot: timeSlot as 'morning',
            })),
          ).flat(),
        });
      await db.caregiverJobType.create({
        data: { caregiverId: c.id, jobType: 'general_care' },
      });
      return c;
    }
    async function evidence(
      c: Awaited<ReturnType<typeof caregiver>>,
      status = 'approved',
      expiresAt = new Date('2036-01-01T23:59:59.999+07:00'),
    ) {
      return db.kycDocument.create({
        data: {
          caregiverId: c.id,
          userId: c.userId,
          documentType: 'professional_license',
          fileUrl: 'private/never-public',
          fileName: 'private-license.pdf',
          fileSize: 10,
          mimeType: 'application/pdf',
          licenseNumber: 'PRIVATE-123',
          reviewStatus: status,
          expiresAt,
        },
      });
    }
    const restInput = (careRecipientId: string, caregiverId?: string) => ({
      careRecipientId,
      caregiverId,
      tasks: ['custom'],
      serviceLocations: ['บ้าน'],
      serviceType: 'elderly_care',
      bookingDate: '2035-10-21',
      startTime: '09:00',
      endTime: '13:00',
      durationHours: 4,
      locationAddress: 'Test',
    });
    it('E2 SQL NULL skills and uncalculated levels fail closed; [] is matchable', async () => {
      const f = await fixture();
      await db.$executeRaw`UPDATE bookings SET required_skills=NULL WHERE id=${f.booking.id}`;
      await expect(
        matching.eligibleCaregivers(f.booking.id, f.owner),
      ).rejects.toMatchObject({
        extensions: { code: 'BOOKING_NOT_MATCHABLE', statusCode: 422 },
      });
      await db.$transaction((tx) =>
        recalculateBookingRequirements(tx, f.booking.id),
      );
      expect(
        (await matching.eligibleCaregivers(f.booking.id, f.owner)).caregivers,
      ).toBeInstanceOf(Array);
      await db.booking.update({
        where: { id: f.booking.id },
        data: { levelCalculatedAt: null },
      });
      await expect(
        matching.eligibleCaregivers(f.booking.id, f.owner),
      ).rejects.toMatchObject({
        extensions: { code: 'BOOKING_NOT_MATCHABLE' },
      });
    });
    it('Elder gets only passing profiles; admin gets every reason, excludes base failures, and explicitly reports live data', async () => {
      const f = await fixture('physiotherapy');
      const admin = await user(3);
      const pass = await caregiver({
        profession: 'physiotherapist',
        skills: ['physiotherapy'],
      });
      await evidence(pass);
      const fail = await caregiver({
        profession: 'nurse',
        careLevel: 'basic',
        skills: [],
      });
      const hidden = await caregiver({ isSearchable: false });
      const unverified = await caregiver({ kycStatus: 'pending' });
      const unavailable = await caregiver({ available: false });
      const result = await matching.eligibleCaregivers(f.booking.id, f.owner);
      expect(result.caregivers.map((c) => c.id)).toContain(pass.id);
      expect(result.caregivers.map((c) => c.id)).not.toContain(fail.id);
      expect(result.caregivers.find((c) => c.id === pass.id)).toMatchObject({
        profession: 'physiotherapist',
        careLevel: 'advanced',
      });
      expect(Object.keys(result).sort()).toEqual([
        'adminContact',
        'caregivers',
        'emptyMessage',
      ]);
      const body = JSON.stringify(result);
      for (const secret of [
        fail.id,
        hidden.id,
        unverified.id,
        unavailable.id,
        'reasons',
        'private-license',
        'PRIVATE-123',
        'expiresAt',
        'filteredCount',
      ])
        expect(body).not.toContain(secret);
      const report = await matching.bookingMatchReport(f.booking.id, admin);
      expect(report).toMatchObject({
        persisted: false,
        evidenceReferenceDate: new Date('2035-10-20T00:00:00+07:00'),
      });
      expect(
        report.results.find((r) => r.caregiver.id === fail.id),
      ).toMatchObject({
        passed: false,
        checks: {
          level: false,
          skills: false,
          profession: false,
          evidence: false,
        },
        reasons: expect.arrayContaining([
          { reason: 'LEVEL_TOO_LOW' },
          { reason: 'SKILL_MISSING', skillCode: 'physiotherapy' },
          { reason: 'PROFESSION_MISMATCH', skillCode: 'physiotherapy' },
          { reason: 'EVIDENCE_NOT_APPROVED', skillCode: 'physiotherapy' },
        ]),
      });
      for (const c of [hidden, unverified, unavailable])
        expect(report.results.map((r) => r.caregiver.id)).not.toContain(c.id);
    });
    it('E13 checks authenticated ownership/membership and admin roles before reading matching data', async () => {
      const f = await fixture();
      const outsider = await user();
      await expect(
        matching.eligibleCaregivers(f.booking.id, outsider),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        matching.selectBookingCaregiver(f.booking.id, randomUUID(), outsider),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        matching.bookingMatchReport(f.booking.id, f.owner),
      ).rejects.toMatchObject({ status: 403 });
      const group = await db.familyGroup.create({
        data: { name: 'S18', createdBy: f.owner.id },
      });
      groups.push(group.id);
      await db.familyGroupMember.createMany({
        data: [
          { groupId: group.id, userId: f.owner.id, role: 'OWNER' },
          { groupId: group.id, userId: outsider.id },
        ],
      });
      await db.booking.update({
        where: { id: f.booking.id },
        data: { familyGroupId: group.id },
      });
      await expect(
        matching.eligibleCaregivers(f.booking.id, outsider),
      ).resolves.toBeDefined();
      // Existing group read rights do not grant another member authority to assign.
      await expect(
        matching.selectBookingCaregiver(f.booking.id, randomUUID(), outsider),
      ).rejects.toMatchObject({ status: 403 });
      await db.familyGroupMember.updateMany({
        where: { groupId: group.id, userId: outsider.id },
        data: { status: 'LEFT' },
      });
      await expect(
        matching.eligibleCaregivers(f.booking.id, outsider),
      ).rejects.toMatchObject({ status: 403 });
    });
    it('E8 accepts expiry on service day and rejects the prior day, even if currently valid', async () => {
      const f = await fixture('physiotherapy');
      const c = await caregiver({
        profession: 'physiotherapist',
        skills: ['physiotherapy'],
      });
      const doc = await evidence(
        c,
        'approved',
        new Date('2035-10-19T23:59:59.999+07:00'),
      );
      expect(
        (
          await matching.eligibleCaregivers(f.booking.id, f.owner)
        ).caregivers.map((c) => c.id),
      ).not.toContain(c.id);
      await db.kycDocument.update({
        where: { id: doc.id },
        data: { expiresAt: new Date('2035-10-20T23:59:59.999+07:00') },
      });
      expect(
        (
          await matching.eligibleCaregivers(f.booking.id, f.owner)
        ).caregivers.map((c) => c.id),
      ).toContain(c.id);
    });
    it('E10 ignores evidence from a pending different-profession request and keeps the approved profession', async () => {
      const f = await fixture('physiotherapy');
      const c = await caregiver({
        profession: 'nurse',
        skills: ['physiotherapy'],
      });
      const doc = await evidence(c);
      await db.caregiver_edit_logs.create({
        data: {
          caregiver_id: c.id,
          edited_by: c.userId,
          action: 'profession_change_request',
          field_changes: [
            {
              field: 'profession',
              // รูปแบบจริงที่ ProfessionChangeService เขียน: JSON string (PYG-667)
              oldValue: JSON.stringify('nurse'),
              newValue: JSON.stringify('physiotherapist'),
              licenseDocumentId: doc.id,
            },
          ],
        },
      });
      const report = await matching.bookingMatchReport(
        f.booking.id,
        await user(3),
      );
      expect(report.results.find((r) => r.caregiver.id === c.id)).toMatchObject(
        {
          passed: false,
          caregiver: { profession: 'nurse' },
          checks: { profession: false, evidence: false },
        },
      );
    });
    it.each(['level', 'skills', 'evidence', 'booking'])(
      'selection rechecks after listing when %s changes and never assigns on failure',
      async (change) => {
        const f = await fixture('physiotherapy');
        const c = await caregiver({
          profession: 'physiotherapist',
          skills: ['physiotherapy'],
        });
        const doc = await evidence(c);
        expect(
          (
            await matching.eligibleCaregivers(f.booking.id, f.owner)
          ).caregivers.map((c) => c.id),
        ).toContain(c.id);
        if (change === 'level')
          await db.caregiver.update({
            where: { id: c.id },
            data: { careLevel: 'basic' },
          });
        if (change === 'skills')
          await db.caregiver.update({
            where: { id: c.id },
            data: { skills: [] },
          });
        if (change === 'evidence')
          await db.kycDocument.update({
            where: { id: doc.id },
            data: { reviewStatus: 'rejected' },
          });
        if (change === 'booking')
          await assessments.submit(f.owner.id, {
            ...f.input,
            flags: ['injection'],
            noSpecialConditions: false,
          });
        emitter.emit.mockClear();
        await expect(
          matching.selectBookingCaregiver(f.booking.id, c.id, f.owner),
        ).rejects.toMatchObject({
          extensions: { code: 'CAREGIVER_NOT_ELIGIBLE', statusCode: 422 },
        });
        expect(
          await db.booking.findUnique({ where: { id: f.booking.id } }),
        ).toMatchObject({ caregiverId: null, status: 'unmatched' });
        expect(emitter.emit).not.toHaveBeenCalled();
      },
    );

    it('cannot borrow evidence from another user; a pending renewal does not revoke valid approval', async () => {
      const f = await fixture('physiotherapy');
      const c = await caregiver({
        profession: 'physiotherapist',
        skills: ['physiotherapy'],
      });
      const doc = await evidence(c);
      const other = await user(2);
      await db.kycDocument.update({
        where: { id: doc.id },
        data: { userId: other.id },
      });
      expect(
        (
          await matching.eligibleCaregivers(f.booking.id, f.owner)
        ).caregivers.map((c) => c.id),
      ).not.toContain(c.id);
      await db.kycDocument.update({
        where: { id: doc.id },
        data: { userId: c.userId },
      });
      await evidence(c, 'pending');
      expect(
        (
          await matching.eligibleCaregivers(f.booking.id, f.owner)
        ).caregivers.map((c) => c.id),
      ).toContain(c.id);
    });
    it('does not reuse unbound evidence from before an approved profession change', async () => {
      const f = await fixture('physiotherapy');
      const c = await caregiver({
        profession: 'physiotherapist',
        skills: ['physiotherapy'],
      });
      const old = await evidence(c);
      await db.kycDocument.update({
        where: { id: old.id },
        data: { uploadedAt: new Date('2020-01-01') },
      });
      await db.caregiver_edit_logs.create({
        data: {
          caregiver_id: c.id,
          edited_by: c.userId,
          action: 'profession_change_approve',
          field_changes: [
            {
              field: 'profession',
              // รูปแบบจริงที่ ProfessionChangeService เขียน: JSON string (PYG-667)
              oldValue: JSON.stringify('nurse'),
              newValue: JSON.stringify('physiotherapist'),
            },
          ],
        },
      });
      expect(
        (
          await matching.eligibleCaregivers(f.booking.id, f.owner)
        ).caregivers.map((c) => c.id),
      ).not.toContain(c.id);
      await evidence(c);
      expect(
        (
          await matching.eligibleCaregivers(f.booking.id, f.owner)
        ).caregivers.map((c) => c.id),
      ).toContain(c.id);
    });
    it('successful selection preserves requirements, uses pending status and rejects reassignment', async () => {
      const f = await fixture('physiotherapy');
      const c = await caregiver({
        profession: 'physiotherapist',
        skills: ['physiotherapy'],
      });
      await evidence(c);
      const before = await db.booking.findUniqueOrThrow({
        where: { id: f.booking.id },
      });
      const result = await matching.selectBookingCaregiver(
        f.booking.id,
        c.id,
        f.owner,
      );
      expect(result).toEqual({
        bookingId: f.booking.id,
        caregiverId: c.id,
        status: 'pending',
      });
      expect(
        await db.booking.findUnique({ where: { id: f.booking.id } }),
      ).toMatchObject({
        caregiverId: c.id,
        status: 'pending',
        requiredLevel: before.requiredLevel,
        requiredSkills: before.requiredSkills,
        levelCalculatedAt: before.levelCalculatedAt,
      });
      await expect(
        matching.selectBookingCaregiver(f.booking.id, c.id, f.owner),
      ).rejects.toMatchObject({
        extensions: { code: 'BOOKING_NOT_SELECTABLE' },
      });
    });
    it('selection retains existing exact-slot and accepted-booking conflict checks', async () => {
      const f = await fixture();
      const c = await caregiver();
      await db.caregiverAvailability.updateMany({
        where: { caregiverId: c.id, timeSlot: 'afternoon' },
        data: { isActive: false },
      });
      await expect(
        matching.selectBookingCaregiver(f.booking.id, c.id, f.owner),
      ).rejects.toMatchObject({
        extensions: { code: 'CAREGIVER_NOT_ELIGIBLE' },
      });
      await db.caregiverAvailability.updateMany({
        where: { caregiverId: c.id },
        data: { isActive: true },
      });
      await db.booking.create({
        data: {
          patientId: f.owner.id,
          caregiverId: c.id,
          serviceType: 'elderly_care',
          status: 'accepted',
          bookingDate: f.booking.bookingDate,
          timeSlot: 'morning',
          startTime: f.booking.startTime,
          durationHours: 4,
          locationAddress: 'Busy',
        },
      });
      await expect(
        matching.selectBookingCaregiver(f.booking.id, c.id, f.owner),
      ).rejects.toMatchObject({
        extensions: { code: 'CAREGIVER_NOT_ELIGIBLE' },
      });
    });
    it('legacy create-with-caregiver cannot bypass S18; rejected recovery also returns only eligible IDs', async () => {
      const f = await fixture();
      const c = await caregiver({ careLevel: 'basic' });
      await assessments.submit(f.owner.id, {
        ...f.input,
        flags: ['injection'],
        noSpecialConditions: false,
      });
      await expect(
        bookings.createBooking(f.owner.id, restInput(f.recipient.id, c.id)),
      ).rejects.toMatchObject({
        response: { statusCode: 422, code: 'CAREGIVER_NOT_ELIGIBLE' },
      });
      expect(await db.booking.count({ where: { patientId: f.owner.id } })).toBe(
        1,
      );
      await db.booking.update({
        where: { id: f.booking.id },
        data: { status: 'rejected' },
      });
      const recovered = await bookings.recoverBooking(f.booking.id, f.owner.id);
      expect(recovered.matches.map((c) => c.id)).not.toContain(c.id);
    });

    it('confirmation rejects a selected caregiver whose approved evidence has changed', async () => {
      const f = await fixture('physiotherapy');
      const c = await caregiver({
        profession: 'physiotherapist',
        skills: ['physiotherapy'],
      });
      const doc = await evidence(c);
      await matching.selectBookingCaregiver(f.booking.id, c.id, f.owner);
      await db.booking.update({
        where: { id: f.booking.id },
        data: { status: 'accepted' },
      });
      const before = await db.booking.findUniqueOrThrow({
        where: { id: f.booking.id },
      });
      await db.kycDocument.update({
        where: { id: doc.id },
        data: { reviewStatus: 'rejected' },
      });
      await expect(
        bookings.confirmBooking(f.booking.id, f.owner.id),
      ).rejects.toMatchObject({
        extensions: { code: 'CAREGIVER_NOT_ELIGIBLE' },
      });
      expect(
        await db.booking.findUnique({ where: { id: f.booking.id } }),
      ).toMatchObject({
        status: 'accepted',
        confirmedAt: null,
        levelCalculatedAt: before.levelCalculatedAt,
      });
      await db.kycDocument.update({
        where: { id: doc.id },
        data: { reviewStatus: 'approved' },
      });
      await expect(
        bookings.confirmBooking(f.booking.id, f.owner.id),
      ).resolves.toMatchObject({ status: 'confirmed' });
    });
    it('concurrent selections serialize; only one caregiver is attached', async () => {
      const f = await fixture();
      const a = await caregiver(),
        b = await caregiver();
      const results = await Promise.allSettled([
        matching.selectBookingCaregiver(f.booking.id, a.id, f.owner),
        matching.selectBookingCaregiver(f.booking.id, b.id, f.owner),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect([a.id, b.id]).toContain(
        (await db.booking.findUniqueOrThrow({ where: { id: f.booking.id } }))
          .caregiverId,
      );
    });

    it('filters before pagination and returns every eligible caregiver with stable unique pages', async () => {
      const f = await fixture();
      const added: string[] = [];
      for (let i = 0; i < 52; i++) added.push((await caregiver()).id);
      const result = await matching.eligibleCaregivers(f.booking.id, f.owner);
      const ids = result.caregivers.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of added) expect(ids).toContain(id);
    }, 20000);
    it('AC7 returns an ordinary empty list and the configured actual-contact slot, without fabricated fallback', async () => {
      const f = await fixture('physiotherapy');
      await assessments.submit(f.owner.id, {
        ...f.input,
        flags: ['injection'],
        noSpecialConditions: false,
      });
      process.env.MATCHING_ADMIN_CONTACT_URL =
        'https://example.test/payung-line';
      expect(await matching.eligibleCaregivers(f.booking.id, f.owner)).toEqual({
        caregivers: [],
        emptyMessage: expect.any(String),
        adminContact: {
          label: 'ติดต่อทีมงาน Payung',
          url: 'https://example.test/payung-line',
        },
      });
      delete process.env.MATCHING_ADMIN_CONTACT_URL;
      expect(
        (await matching.eligibleCaregivers(f.booking.id, f.owner)).adminContact,
      ).toBeNull();
    });
  },
);
