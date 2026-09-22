/**
 * ConsentService — ตรวจและบันทึกความยินยอม (PYG-538)
 *
 * ★ ตารางเป็น append-only (trigger บล็อก UPDATE ไว้ตั้งแต่ PYG-473) — ทุกการกดคือแถวใหม่
 *   "สถานะปัจจุบัน" จึงหมายถึง "แถวล่าสุดของ consent_type นั้น" ไม่ใช่คอลัมน์ที่แก้ได้
 *   การถอนความยินยอมก็คือแถวใหม่ที่ granted = false
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import {
  CONSENT_TYPE,
  type ConsentSource,
  type ConsentType,
  POLICY_VERSION,
} from './consent.constants';
import type { ConsentAnswerInput } from './dto/consent-answer.input';

/** หลักฐานประกอบคำขอ — เก็บเท่าที่จำเป็นต่อการพิสูจน์ว่าความยินยอมเกิดขึ้นจริง */
export interface ConsentEvidence {
  source: ConsentSource;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** client ที่ใช้เขียนได้ทั้ง prisma ปกติและ tx ของผู้เรียก */
type PrismaWriter = Pick<PrismaService, 'user_consents'> | Prisma.TransactionClient;

@Injectable()
export class ConsentService {
  private readonly logger = new Logger(ConsentService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * ตรวจว่าคำตอบที่ส่งมาใช้ได้ไหม — เรียก **ก่อน** เปิด transaction เสมอ
   *
   * โยน error แทนการคืน boolean เพราะผู้เรียกทุกรายต้องหยุดทำงานต่อทันที
   * และ FE ต้องได้ข้อความที่แยกออกว่าติดเพราะอะไร
   *
   * @param required ความยินยอมที่ต้องมีและต้อง granted = true ณ จุดนี้
   */
  assertAnswers(answers: ConsentAnswerInput[], required: readonly ConsentType[]): void {
    for (const answer of answers) {
      // ★ เวอร์ชันไม่ตรง = ผู้ใช้อ่านข้อความคนละฉบับกับที่บังคับใช้อยู่
      //   ถ้าปล่อยผ่านแล้วบันทึกเวอร์ชันปัจจุบันลงไป เท่ากับสร้างหลักฐานเท็จ
      if (answer.policyVersion !== POLICY_VERSION) {
        throw new BadRequestException({
          code: 'CONSENT_POLICY_VERSION_MISMATCH',
          message:
            'นโยบายความเป็นส่วนตัวมีฉบับใหม่แล้ว กรุณารีเฟรชหน้าเว็บแล้วอ่านอีกครั้ง',
          currentVersion: POLICY_VERSION,
        });
      }
    }

    const grantedTypes = new Set(
      answers.filter((a) => a.granted).map((a) => a.type),
    );

    for (const type of required) {
      if (!grantedTypes.has(type)) {
        throw new ForbiddenException({
          code: 'CONSENT_REQUIRED',
          message: 'ต้องให้ความยินยอมก่อนจึงจะบันทึกข้อมูลนี้ได้',
          consentType: type,
        });
      }
    }
  }

  /**
   * เขียนคำตอบทั้งชุดลง user_consents
   *
   * ★ รับ `tx` เข้ามาเพื่อให้เขียนอยู่ในทรานแซคชันเดียวกับข้อมูลที่ความยินยอมนั้นอนุญาต
   *   ถ้าแยกกัน แล้วฝั่งใดฝั่งหนึ่งล้ม จะได้ข้อมูลสุขภาพที่ไม่มีหลักฐานความยินยอม
   *   (หรือหลักฐานที่ไม่มีข้อมูล) ซึ่งแก้ย้อนหลังไม่ได้เพราะตารางเป็น append-only
   *
   * ★ เขียนทุกข้อที่ส่งมา รวมทั้งข้อที่ granted = false — การปฏิเสธก็เป็นข้อเท็จจริง
   *   ที่ต้องพิสูจน์ได้ว่าเราถามแล้วและเขาตอบว่าไม่
   */
  async recordMany(
    tx: PrismaWriter,
    userId: string,
    answers: ConsentAnswerInput[],
    evidence: ConsentEvidence,
  ): Promise<void> {
    if (answers.length === 0) return;

    await tx.user_consents.createMany({
      data: answers.map((answer) => ({
        user_id: userId,
        consent_type: answer.type,
        policy_version: answer.policyVersion,
        granted: answer.granted,
        source: evidence.source,
        ip_address: evidence.ipAddress ?? null,
        user_agent: evidence.userAgent ?? null,
      })),
    });

    this.logger.log({
      event: 'consent.recorded',
      userId,
      source: evidence.source,
      policyVersion: POLICY_VERSION,
      types: answers.map((a) => `${a.type}:${a.granted ? 'granted' : 'denied'}`),
    });
  }

  /**
   * ตอนนี้ยังยินยอมข้อนี้อยู่ไหม (เวอร์ชันปัจจุบันเท่านั้น)
   *
   * ★ ดูแถวล่าสุดของ consent_type นั้น แล้วเช็คสองอย่าง:
   *     granted = true  → ยังไม่ถอน
   *     policy_version ตรงกับปัจจุบัน → ยังไม่ต้อง re-consent
   *   ถ้าเช็คแค่ granted จะพลาดกรณีที่นโยบายเปลี่ยนสาระแล้วแต่ยังไม่ได้ขอใหม่
   */
  async hasGrantedCurrent(userId: string, type: ConsentType): Promise<boolean> {
    const latest = await this.prisma.user_consents.findFirst({
      where: { user_id: userId, consent_type: type },
      orderBy: { granted_at: 'desc' },
      select: { granted: true, policy_version: true },
    });

    return latest?.granted === true && latest.policy_version === POLICY_VERSION;
  }

  /** ยินยอมให้เก็บข้อมูลสุขภาพอยู่หรือไม่ — ใช้บ่อยพอจะมีชื่อของตัวเอง */
  hasHealthDataConsent(userId: string): Promise<boolean> {
    return this.hasGrantedCurrent(userId, CONSENT_TYPE.SENSITIVE_HEALTH_DATA);
  }
}
