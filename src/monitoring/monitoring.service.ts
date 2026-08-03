import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { SupabaseService } from '../common/supabase.service';
import { ClockService } from '../common/clock.service';
import { CheckInInput } from './dto/check-in.input';
import { JobEvent } from './entities/job-event.entity';
import {
  BOOKING_STATUS,
  BUSINESS_TIMEZONE,
  CLOCK_ANOMALY_TOLERANCE_MIN,
  EARLY_GRACE_MIN,
  GPS_ACCURACY_TRUST_M,
  JOB_EVENT_SOURCE,
  JOB_EVENT_TYPE,
  JOB_EVIDENCE_BUCKET,
  LATE_VERDICT_MIN,
  REVIEW_REASON,
  SIGNED_URL_TTL_SEC,
  VERDICT_RADIUS_M,
  WARN_RADIUS_M,
} from './monitoring.constants';

/** ผลลัพธ์ของการประเมิน 1 เหตุการณ์ ก่อนเขียนลงฐานข้อมูล */
interface EvaluationResult {
  distanceM: number | null;
  gpsAccuracyLow: boolean;
  jobCoordsMissing: boolean;
  withinWarnRadius: boolean | null;
  reviewReasons: string[];
}

/**
 * MonitoringService — ตรรกะทั้งหมดของ proof-of-work (PYG-352)
 *
 * หลักคิดที่สำคัญที่สุดของไฟล์นี้ มีอยู่ประโยคเดียว:
 *   ★ GPS ไม่เคยบล็อกการเช็คอิน มันทำได้แค่ "ติดธง" เท่านั้น
 * ถ้าวันหนึ่งมีใครมาเพิ่ม throw เพราะระยะทาง แปลว่าอ่านการ์ดผิด
 * ผู้ดูแลที่ยืนอยู่หน้าบ้านลูกค้าจริง ๆ แต่สัญญาณห่วย ต้องเริ่มงานได้เสมอ
 */
@Injectable()
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabaseService: SupabaseService,
    private readonly clock: ClockService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════
  // เช็คอิน
  // ══════════════════════════════════════════════════════════════════════

  /**
   * ผู้ดูแลเช็คอินเพื่อเริ่มงาน
   *
   * @param userId  users.id ที่มาจาก JWT (ปลอมผ่าน input ไม่ได้)
   */
  async checkInBooking(userId: string, input: CheckInInput): Promise<JobEvent> {
    const caregiverId = await this.resolveCaregiverId(userId);

    const booking = await this.prisma.booking.findUnique({
      where: { id: input.bookingId },
      include: {
        payment: { select: { paymentStatus: true } },
        jobEvents: { where: { eventType: JOB_EVENT_TYPE.CHECK_IN } },
      },
    });

    // ─── ด่านที่ 1: มีงานนี้จริงไหม ───────────────────────────────────
    if (!booking) {
      throw new NotFoundException('ไม่พบงานนี้');
    }

    // ─── ด่านที่ 2: เป็นงานของคนนี้ไหม ────────────────────────────────
    if (booking.caregiverId !== caregiverId) {
      throw new ForbiddenException('งานนี้ไม่ใช่ของคุณ');
    }

    // ─── ด่านที่ 3: เช็คอินไปแล้วหรือยัง (idempotent) ─────────────────
    //
    // ⚠ ตรงนี้ "จงใจ" สลับลำดับจากที่การ์ดเขียนไว้ (การ์ดวางข้อนี้ไว้ท้ายสุด)
    //   เหตุผล: พอเช็คอินสำเร็จครั้งแรก status จะกลายเป็น 'in_progress' แล้ว
    //   ถ้าเอาด่านเช็ค status ขึ้นก่อน การกดซ้ำจะไปตกที่ 'งานนี้ยังไม่พร้อมเริ่ม'
    //   ซึ่งขัดกับ AC ข้อ 8 ("กดสองครั้งต้องไม่เป็นอะไร") และขัดกับ DoD
    //   ที่เขียนว่า "เรียกซ้ำได้ 1 แถว ไม่มี error" ตรง ๆ
    const existing = booking.jobEvents[0];
    if (existing) {
      this.logger.log({
        event: 'monitoring.check_in.duplicate',
        bookingId: booking.id,
        caregiverId,
      });
      return this.toEntity(existing, booking.locationLat === null, true);
    }

    // ─── ด่านที่ 4: สถานะงาน ──────────────────────────────────────────
    if (booking.status !== BOOKING_STATUS.CONFIRMED) {
      throw new BadRequestException('งานนี้ยังไม่พร้อมเริ่ม');
    }

    // ─── ด่านที่ 5: ลูกค้าจ่ายเงินเข้า escrow แล้วหรือยัง ──────────────
    if (booking.payment?.paymentStatus !== 'held') {
      throw new BadRequestException('ยังไม่ได้รับการชำระเงิน');
    }

    // ─── ด่านที่ 6: ถึงวันทำงานหรือยัง (นับตามเวลาไทย) ────────────────
    const now = this.clock.now();
    if (!this.isSameBangkokDay(booking.bookingDate, now)) {
      throw new BadRequestException('ยังไม่ถึงวันทำงาน');
    }

    // ─── ผ่านทุกด่านแล้ว: ประเมินธง (ไม่มีการ throw ใด ๆ หลังจากนี้) ──
    const deviceTs = input.deviceTs ? new Date(input.deviceTs) : null;

    const evaluation = this.evaluate({
      eventLat: input.lat ?? null,
      eventLng: input.lng ?? null,
      accuracyM: input.accuracyM ?? null,
      jobLat: this.toNumber(booking.locationLat),
      jobLng: this.toNumber(booking.locationLng),
      serverTs: now,
      deviceTs,
      scheduledStart: this.scheduledStartOf(
        booking.bookingDate,
        booking.startTime,
      ),
    });

    // เขียน 2 อย่างใน transaction เดียว: แถวหลักฐาน + สถานะงาน
    // ถ้าอย่างใดอย่างหนึ่งพัง ต้องไม่มีอะไรถูกเขียนเลย
    // (ไม่งั้นจะได้งานที่ in_progress แต่ไม่มีหลักฐาน หรือกลับกัน)
    const mergedReasons = Array.from(
      new Set([...booking.reviewReasons, ...evaluation.reviewReasons]),
    );

    try {
      const [created] = await this.prisma.$transaction([
        this.prisma.jobEvent.create({
          data: {
            bookingId: booking.id,
            caregiverId,
            eventType: JOB_EVENT_TYPE.CHECK_IN,
            source: JOB_EVENT_SOURCE.CAREGIVER,
            lat: input.lat ?? null,
            lng: input.lng ?? null,
            distanceM: evaluation.distanceM,
            accuracyM: input.accuracyM ?? null,
            serverTs: now, // เวลาของเซิร์ฟเวอร์เท่านั้น
            deviceTs, // ของเครื่อง client เก็บไว้เฉย ๆ
          },
        }),
        this.prisma.booking.update({
          where: { id: booking.id },
          data: {
            status: BOOKING_STATUS.IN_PROGRESS,
            reviewReasons: { set: mergedReasons },
          },
        }),
      ]);

      this.logger.log({
        event: 'monitoring.check_in',
        bookingId: booking.id,
        caregiverId,
        distanceM: evaluation.distanceM,
        accuracyM: input.accuracyM ?? null,
        gpsAccuracyLow: evaluation.gpsAccuracyLow,
        reviewReasons: evaluation.reviewReasons,
      });

      return this.toEntity(
        created,
        evaluation.jobCoordsMissing,
        false,
        evaluation,
      );
    } catch (error) {
      // P2002 = unique constraint ชน — แปลว่ามีคนกดพร้อมกันสองครั้ง
      // UNIQUE(booking_id, event_type) ทำงานถูกต้องแล้ว เราแค่คืนแถวที่ชนะไป
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const winner = await this.prisma.jobEvent.findFirst({
          where: { bookingId: booking.id, eventType: JOB_EVENT_TYPE.CHECK_IN },
        });
        if (winner) {
          return this.toEntity(winner, evaluation.jobCoordsMissing, true);
        }
      }
      throw error;
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // กฎการติดธง
  // ══════════════════════════════════════════════════════════════════════

  /**
   * ประเมินว่าเหตุการณ์นี้ควรติดธงอะไรบ้าง
   *
   * แยกออกมาเป็น method ล้วน ๆ (ไม่แตะฐานข้อมูล) ตั้งใจให้เทสง่าย
   * และให้ PYG-358 (check-out) เรียกใช้ซ้ำได้โดยไม่ต้องเขียนกฎใหม่
   */
  evaluate(params: {
    eventLat: number | null;
    eventLng: number | null;
    accuracyM: number | null;
    jobLat: number | null;
    jobLng: number | null;
    serverTs: Date;
    deviceTs: Date | null;
    scheduledStart: Date;
  }): EvaluationResult {
    const reasons: string[] = [];

    // ── 1. พิกัดจุดงานหายไหม ────────────────────────────────────────
    // booking เก่าทุกใบเป็นแบบนี้ เพราะพิกัดถูกทิ้งที่ API boundary มาตลอด
    // ★ ห้ามติดธง — เป็นความผิดพลาดของข้อมูลเรา ไม่ใช่ของผู้ดูแล
    const jobCoordsMissing = params.jobLat === null || params.jobLng === null;

    // ── 2. สัญญาณตำแหน่งเชื่อได้ไหม ─────────────────────────────────
    // เดสก์ท็อปไม่มีชิป GPS → accuracy อาจเป็นกิโลเมตร
    // ★ ห้ามติดธงเช่นกัน (AC ข้อ 6b)
    const gpsAccuracyLow =
      params.accuracyM !== null && params.accuracyM > GPS_ACCURACY_TRUST_M;

    // ── 3. คำนวณระยะ (ถ้าคำนวณได้) ──────────────────────────────────
    const canComputeDistance =
      !jobCoordsMissing && params.eventLat !== null && params.eventLng !== null;

    const distanceM = canComputeDistance
      ? Math.round(
          this.haversineMeters(
            params.eventLat as number,
            params.eventLng as number,
            params.jobLat as number,
            params.jobLng as number,
          ),
        )
      : null;

    // ── 4. รัศมีสองชั้น ──────────────────────────────────────────────
    //   ≤ 200 ม.     → ปกติ
    //   200–500 ม.   → UI เตือนเฉย ๆ **ไม่ติดธง** (GPS ดริฟต์เป็นเรื่องปกติ)
    //   > 500 ม.     → ติดธง out_of_radius
    const withinWarnRadius =
      distanceM !== null ? distanceM <= WARN_RADIUS_M : null;
    reasons.push(...this.radiusFlags(distanceM, gpsAccuracyLow));

    // ── 5. กรอบเวลาแบบไม่สมมาตร ─────────────────────────────────────
    // มาเช้าได้ถึง EARLY_GRACE_MIN นาที (มาเช้าไม่ใช่ความผิด)
    // แต่สายเกิน LATE_VERDICT_MIN นาที → ติดธง
    // ตัดสินจากเวลาเซิร์ฟเวอร์เท่านั้น
    const minutesFromStart =
      (params.serverTs.getTime() - params.scheduledStart.getTime()) / 60000;

    if (
      minutesFromStart > LATE_VERDICT_MIN ||
      minutesFromStart < -EARLY_GRACE_MIN
    ) {
      reasons.push(REVIEW_REASON.OUT_OF_WINDOW);
    }

    // ── 6. นาฬิกาเครื่องเพี้ยนไหม ────────────────────────────────────
    // ไม่ได้ทำให้เช็คอินล้มเหลว แค่บันทึกไว้ว่ามีคนอาจปรับเวลาเครื่อง
    if (params.deviceTs) {
      const driftMin =
        Math.abs(params.serverTs.getTime() - params.deviceTs.getTime()) / 60000;
      if (driftMin > CLOCK_ANOMALY_TOLERANCE_MIN) {
        reasons.push(REVIEW_REASON.CLOCK_ANOMALY);
      }
    }

    return {
      distanceM,
      gpsAccuracyLow,
      jobCoordsMissing,
      withinWarnRadius,
      reviewReasons: reasons,
    };
  }

  /**
   * กฎรัศมี — "สำเนาเดียว" ที่ทั้งเช็คอินและเช็คเอาท์ต้องเรียกใช้ (PYG-358 STEP 3.4)
   *
   * ⚠ ถ้าวันหนึ่งมีคนก๊อปตรรกะนี้ไปเขียนซ้ำในเส้นทางเช็คเอาท์ ระบบจะมีกฎรัศมีสองชุด
   *   แล้วสองชุดนั้นจะเริ่มไม่ตรงกันตอนใครสักคนแก้ threshold ข้างเดียว
   *
   * - distanceM = null  → คำนวณไม่ได้ ไม่ติดธง
   * - สัญญาณไม่แม่นพอ    → ไม่ติดธง (กฎ 6b)
   * - ไกลเกิน VERDICT_RADIUS_M → ติดธง out_of_radius
   */
  radiusFlags(distanceM: number | null, gpsAccuracyLow: boolean): string[] {
    if (distanceM === null) return [];
    if (gpsAccuracyLow) return [];
    return distanceM > VERDICT_RADIUS_M ? [REVIEW_REASON.OUT_OF_RADIUS] : [];
  }

  // ══════════════════════════════════════════════════════════════════════
  // helper
  // ══════════════════════════════════════════════════════════════════════

  /** แปลง users.id → caregivers.id (Booking.caregiverId ชี้ไปที่ caregivers.id ไม่ใช่ users.id) */
  private async resolveCaregiverId(userId: string): Promise<string> {
    const caregiver = await this.prisma.caregiver.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!caregiver) {
      throw new ForbiddenException('ไม่พบโปรไฟล์ผู้ดูแลของบัญชีนี้');
    }
    return caregiver.id;
  }

  /**
   * ระยะทางระหว่างสองพิกัดบนผิวโลก หน่วยเมตร (สูตร haversine)
   *
   * ความคลาดเคลื่อนของสูตรนี้ระดับ < 0.5% ซึ่งละเอียดเกินพอ
   * เพราะเราตัดสินกันที่หลักร้อยเมตร ไม่ใช่หลักเซนติเมตร
   */
  private haversineMeters(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
  ): number {
    const EARTH_RADIUS_M = 6_371_000;
    const toRad = (deg: number) => (deg * Math.PI) / 180;

    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);

    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

    return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * รวม bookingDate (คอลัมน์ DATE) กับ startTime (คอลัมน์ TIME) ให้เป็นเวลาจริง 1 จุด
   *
   * ทั้งสองคอลัมน์ถูกอ่านกลับมาเป็น Date ที่ฐาน UTC:
   *   bookingDate → 2026-06-13T00:00:00Z
   *   startTime   → 1970-01-01T09:00:00Z
   * ความหมายจริงคือ "9 โมงเช้าเวลาไทย" → ลบ 7 ชม. เพื่อได้ instant จริง
   * (ไทยเป็น UTC+7 คงที่ ไม่มี DST จึงบวกลบตรง ๆ ได้ ไม่ต้องใช้ library)
   */
  private scheduledStartOf(bookingDate: Date, startTime: Date | null): Date {
    const utcMidnight = Date.UTC(
      bookingDate.getUTCFullYear(),
      bookingDate.getUTCMonth(),
      bookingDate.getUTCDate(),
      startTime ? startTime.getUTCHours() : 0,
      startTime ? startTime.getUTCMinutes() : 0,
      startTime ? startTime.getUTCSeconds() : 0,
    );
    return new Date(utcMidnight - 7 * 60 * 60 * 1000);
  }

  /** bookingDate ตรงกับ "วันนี้" ตามเวลาไทยหรือไม่ */
  private isSameBangkokDay(bookingDate: Date, now: Date): boolean {
    // เลื่อน now ไป +7 ชม. แล้วอ่านเป็น UTC = ได้วันที่ตามปฏิทินไทย
    const bangkokNow = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    return (
      bookingDate.getUTCFullYear() === bangkokNow.getUTCFullYear() &&
      bookingDate.getUTCMonth() === bangkokNow.getUTCMonth() &&
      bookingDate.getUTCDate() === bangkokNow.getUTCDate()
    );
  }

  /** Prisma Decimal → number (null คงเป็น null) */
  private toNumber(value: Prisma.Decimal | null): number | null {
    if (value === null || value === undefined) return null;
    return Number(value);
  }

  /**
   * แปลงแถวในฐานข้อมูล → entity ที่ส่งออก GraphQL
   *
   * ถ้าไม่ได้ส่ง evaluation มา (เคสกดซ้ำ) จะคำนวณค่า derived ใหม่จากแถวเดิม
   * เพื่อให้ผลลัพธ์ของการกดครั้งแรกกับครั้งที่สองหน้าตาเหมือนกัน
   */
  private toEntity(
    row: {
      id: string;
      bookingId: string;
      eventType: string;
      source: string;
      lat: Prisma.Decimal | null;
      lng: Prisma.Decimal | null;
      distanceM: number | null;
      accuracyM: number | null;
      serverTs: Date;
      deviceTs: Date | null;
      note: string | null;
      photoUrl: string | null;
    },
    jobCoordsMissing: boolean,
    alreadyCheckedIn: boolean,
    evaluation?: EvaluationResult,
  ): JobEvent {
    const gpsAccuracyLow =
      evaluation?.gpsAccuracyLow ??
      (row.accuracyM !== null && row.accuracyM > GPS_ACCURACY_TRUST_M);

    const withinWarnRadius =
      evaluation?.withinWarnRadius ??
      (row.distanceM !== null ? row.distanceM <= WARN_RADIUS_M : null);

    return {
      id: row.id,
      bookingId: row.bookingId,
      eventType: row.eventType,
      source: row.source,
      lat: row.lat === null ? undefined : Number(row.lat),
      lng: row.lng === null ? undefined : Number(row.lng),
      distanceM: row.distanceM ?? undefined,
      accuracyM: row.accuracyM ?? undefined,
      serverTs: row.serverTs,
      deviceTs: row.deviceTs ?? undefined,
      note: row.note ?? undefined,
      photoUrl: row.photoUrl ?? undefined,
      gpsAccuracyLow,
      jobCoordsMissing,
      withinWarnRadius: withinWarnRadius ?? undefined,
      reviewReasons: evaluation?.reviewReasons ?? [],
      alreadyCheckedIn,
    };
  }

  /**
   * สร้าง signed URL ให้รูปหลักฐาน (bucket เป็น private)
   *
   * ⚠ ห้ามเก็บ public URL ลงฐานข้อมูลเด็ดขาด — โปรเจกต์นี้เคยพลาดมาแล้วกับเอกสาร KYC
   *   เก็บเป็น path เปล่า ๆ แล้วค่อย sign ตอนอ่านทุกครั้ง
   *
   * ยังไม่มีใครเรียกใน PYG-352 (เช็คอินไม่มีรูป) — PYG-358 (เช็คเอาท์) จะใช้
   */
  async signEvidenceUrl(path: string): Promise<string | null> {
    const supabase = this.supabaseService.getClient();
    const { data, error } = await supabase.storage
      .from(JOB_EVIDENCE_BUCKET)
      .createSignedUrl(path, SIGNED_URL_TTL_SEC);

    if (error || !data?.signedUrl) {
      this.logger.warn({ event: 'monitoring.sign_url_failed', path });
      return null;
    }
    return data.signedUrl;
  }

  /** ค่าคงที่ที่ FE ต้องใช้วาดวงกลมสองวงบนแผนที่ (ดีไซน์วาดไว้ก่อนเช็คอินด้วยซ้ำ) */
  getRadiusConfig(): {
    warnRadiusM: number;
    verdictRadiusM: number;
    timezone: string;
  } {
    return {
      warnRadiusM: WARN_RADIUS_M,
      verdictRadiusM: VERDICT_RADIUS_M,
      timezone: BUSINESS_TIMEZONE,
    };
  }
}
