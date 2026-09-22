/**
 * ConsentService — ตรวจและบันทึกความยินยอม (PYG-538 · PYG-474)
 *
 * ★ ตารางเป็น append-only (trigger บล็อก UPDATE ไว้ตั้งแต่ PYG-473) — ทุกการกดคือแถวใหม่
 *   "สถานะปัจจุบัน" จึงหมายถึง "แถวล่าสุดของ consent_type นั้น" ไม่ใช่คอลัมน์ที่แก้ได้
 *   การถอนความยินยอมก็คือแถวใหม่ที่ granted = false
 *
 * ★ PYG-474: error ทุกตัวเป็น ConsentError (GraphQLError) แทน Bad/ForbiddenException
 *   เดิมที่ code หายระหว่างทางก่อนถึง FE — ดูเหตุผลเต็มใน consent.errors.ts
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import {
  CONSENT_TYPE,
  CONSENTS_BY_SOURCE,
  type ConsentSource,
  type ConsentType,
  POLICY_VERSION,
  REQUIRED_CONSENTS,
} from './consent.constants';
import { CONSENT_ERROR, ConsentError } from './consent.errors';
import type { ConsentAnswerInput } from './dto/consent-answer.input';

/**
 * แถวล่าสุดของความยินยอมหนึ่งข้อ — ผลของ findLatestByUser (PYG-474)
 * ใช้ตอน audit และหน้า "ความยินยอมของฉัน"
 */
export interface LatestConsentRecord {
  type: string;
  granted: boolean;
  policyVersion: string;
  /** เวลาที่ผู้ใช้กดครั้งล่าสุด (server time — ค่า DEFAULT now() ของ DB) */
  answeredAt: Date;
  /** จุดในแอปที่กด เช่น 'register' / 'onboarding' — แถวเก่าอาจเป็น null */
  source: string | null;
}

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
        throw new ConsentError(
          'นโยบายความเป็นส่วนตัวมีฉบับใหม่แล้ว กรุณารีเฟรชหน้าเว็บแล้วอ่านอีกครั้ง',
          CONSENT_ERROR.POLICY_VERSION_MISMATCH,
          { currentVersion: POLICY_VERSION },
        );
      }
    }

    const grantedTypes = new Set(
      answers.filter((a) => a.granted).map((a) => a.type),
    );

    for (const type of required) {
      if (!grantedTypes.has(type)) {
        throw new ConsentError(
          'ต้องให้ความยินยอมก่อนจึงจะบันทึกข้อมูลนี้ได้',
          CONSENT_ERROR.REQUIRED,
          { consentType: type },
        );
      }
    }
  }

  /**
   * ตรวจคำตอบของ "หน้าจอหนึ่ง" แบบเข้ม — PYG-474 (ใช้ตอน register)
   *
   * เพิ่มจาก assertAnswers อีก 2 ด่าน แล้วค่อยส่งต่อให้ assertAnswers:
   *   1. ชนิดที่ไม่ได้ขอ ณ จุดนั้น → CONSENT_TYPE_INVALID
   *      ★ เช่นส่ง `sensitive_health_data` มากับ register ทั้งที่หน้าสมัครไม่ได้โชว์ข้อนี้
   *        ถ้าบันทึกให้ = มีหลักฐานว่าผู้ใช้ "ยินยอม" ข้อความที่เขาไม่เคยเห็น ซึ่งใช้ไม่ได้ตามกฎหมาย
   *        และสะกดผิดแม้ตัวเดียว ประวัติจะแตกเป็นสองชุดถาวร (ตาราง append-only แก้ย้อนหลังไม่ได้)
   *   2. ส่งข้อเดียวกันซ้ำ → CONSENT_DUPLICATE_ANSWER
   *      ★ [{marketing: true}, {marketing: false}] ตีความไม่ได้ว่ายินยอมหรือไม่
   *        ถ้าบันทึกทั้งสองแถว "แถวล่าสุด" จะขึ้นกับลำดับที่ DB คืนมา ซึ่งเดาไม่ได้
   *
   * ข้อบังคับ = ข้อที่ขอ ณ จุดนั้น ∩ REQUIRED_CONSENTS
   *   (register → terms_of_service + privacy_policy · marketing ไม่บังคับ)
   */
  assertAnswersForSource(
    answers: ConsentAnswerInput[],
    source: ConsentSource,
  ): void {
    const allowed: readonly string[] = CONSENTS_BY_SOURCE[source];
    const seen = new Set<string>();

    for (const answer of answers) {
      if (!allowed.includes(answer.type)) {
        throw new ConsentError(
          'ข้อมูลความยินยอมไม่ถูกต้อง กรุณารีเฟรชหน้าเว็บแล้วลองอีกครั้ง',
          CONSENT_ERROR.TYPE_INVALID,
          { consentType: answer.type },
        );
      }
      if (seen.has(answer.type)) {
        throw new ConsentError(
          'ส่งคำตอบความยินยอมข้อเดียวกันซ้ำ กรุณาลองอีกครั้ง',
          CONSENT_ERROR.DUPLICATE_ANSWER,
          { consentType: answer.type },
        );
      }
      seen.add(answer.type);
    }

    const required = CONSENTS_BY_SOURCE[source].filter((type) =>
      REQUIRED_CONSENTS.includes(type),
    );
    this.assertAnswers(answers, required);
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

  /**
   * ความยินยอมล่าสุดของผู้ใช้ — ข้อละหนึ่งแถว (PYG-474)
   *
   * ใช้ตอน audit ("คนนี้ยินยอมเวอร์ชันไหน เมื่อไหร่ จากจุดไหน") และหน้าความยินยอมของฉัน
   * คืนเฉพาะข้อที่ผู้ใช้เคยตอบ — ข้อที่ไม่เคยตอบจะไม่อยู่ในผลลัพธ์
   *
   * ★ ดึงทุกแถวของผู้ใช้คนนี้แล้วเลือกแถวแรกของแต่ละข้อในโค้ด แทน `distinct` ของ Prisma
   *   เพราะ Prisma ทำ distinct ในหน่วยความจำอยู่แล้ว (ไม่ใช่ DISTINCT ON ของ Postgres)
   *   เขียนเองจึงอ่านง่ายกว่าและผลเหมือนกัน · ผู้ใช้หนึ่งคนมีไม่กี่สิบแถว ไม่หนัก
   *   และได้ index idx_user_consents_latest (user_id, consent_type, granted_at DESC) ช่วย
   *
   * ★ เรียงตาม granted_at ล่าสุดก่อน — แถวในทรานแซคชันเดียวกันได้ now() เท่ากัน
   *   ข้อเดียวกันจึง "ต้องไม่" ถูกเขียนสองแถวในคำขอเดียว ไม่งั้นแถวล่าสุดจะเดาไม่ได้
   *   ทุกทางที่เขียนตอนนี้กันไว้แล้ว: register และ onboarding ผ่าน assertAnswersForSource
   *   (ปฏิเสธคำตอบซ้ำ) · ทางเขียนใหม่ที่ส่งหลายข้อพร้อมกันต้องเรียกตัวตรวจนี้ด้วยเสมอ
   */
  async findLatestByUser(userId: string): Promise<LatestConsentRecord[]> {
    const rows = await this.prisma.user_consents.findMany({
      where: { user_id: userId },
      orderBy: { granted_at: 'desc' },
      select: {
        consent_type: true,
        granted: true,
        policy_version: true,
        granted_at: true,
        source: true,
      },
    });

    // แถวแรกที่เจอของแต่ละข้อ = แถวล่าสุด (เพราะเรียงใหม่ → เก่ามาแล้ว)
    const latestByType = new Map<string, LatestConsentRecord>();
    for (const row of rows) {
      if (latestByType.has(row.consent_type)) continue;
      latestByType.set(row.consent_type, {
        type: row.consent_type,
        granted: row.granted,
        policyVersion: row.policy_version,
        answeredAt: row.granted_at,
        source: row.source,
      });
    }
    return [...latestByType.values()];
  }
}
