/**
 * ข้อมูลโรคติดเชื้อ (S10 · PYG-565 / BE PYG-619 · contract PYG-617)
 *
 * ★ ข้อมูลสุขภาพ — อยู่ได้ 2 ที่เท่านั้น: โปรไฟล์ผู้สูงอายุที่ญาติเจ้าของเห็น และคำขอรับงานที่ผู้ดูแลผู้รับคำขอเห็น
 *   ห้ามใส่ค่าใน application log, ข้อความ error, payload ของ notification/อีเมล, type สาธารณะ/หน้า List/Profile/แอดมิน
 *   (ไฟล์นี้จึงไม่มี logger และ error ทุกตัวมีข้อความตายตัวที่ไม่มีค่า)
 */
import { GraphQLError } from 'graphql';
import { UnprocessableEntityException } from '@nestjs/common';

export const INFECTION_ERROR = {
  /** รับงานโดยผู้ดูแลยังไม่รับทราบ (S10-AC3) */
  ACK_REQUIRED: 'INFECTION_ACK_REQUIRED',
  /** ญาติบันทึกโดยไม่รับทราบข้อความแจ้งการเปิดเผย (S10-AC5) */
  NOTICE_NOT_ACCEPTED: 'INFECTION_NOTICE_NOT_ACCEPTED',
} as const;

/** GraphQL (operation รับงาน): extensions.code + 422 · ข้อความบอกเหตุผลให้ client เก่า (E10) */
export class InfectionAckRequiredError extends GraphQLError {
  constructor() {
    super(
      'ต้องรับทราบข้อมูลสุขภาพของผู้รับการดูแลก่อนรับงานนี้ — กรุณาอัปเดตแอปแล้วกดรับทราบก่อนกดรับงาน',
      {
        extensions: {
          code: INFECTION_ERROR.ACK_REQUIRED,
          statusCode: 422,
          http: { status: 422 },
        },
      },
    );
  }
}

/** REST (โปรไฟล์ผู้สูงอายุของญาติ): body { statusCode: 422, code, message } */
export function infectionNoticeNotAccepted(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    statusCode: 422,
    code: INFECTION_ERROR.NOTICE_NOT_ACCEPTED,
    message: 'ต้องรับทราบข้อความแจ้งการเปิดเผยข้อมูลโรคติดเชื้อกับผู้ดูแลก่อนบันทึก',
  });
}

// ─── นโยบาย "งานไหนต้องรับทราบ" ──────────────────────────────────────────────

/**
 * ⚠ ยังไม่เคาะใน PYG-565 ("AC3: ผู้ดูแลต้องกดรับทราบทุกงาน หรือเฉพาะงานที่ญาติระบุว่า มี")
 *
 * ตารางนี้คือ "จุดเดียว" ที่ต้องแก้เมื่อเคาะ — ไม่มีที่อื่นในโค้ดที่ตัดสินเรื่องนี้
 *   - yes   = ญาติระบุว่า "มี": ทุกข้อเสนอตรงกันว่าต้องรับทราบ → true
 *   - no    = ญาติระบุว่า "ไม่มี": ⚠ รอเคาะ (ตอนนี้ false = ไม่บังคับ)
 *   - unset = ยังไม่ได้ระบุ (NULL / จองให้ตัวเองที่ไม่มีโปรไฟล์): ⚠ รอเคาะ (ตอนนี้ false = ไม่บังคับ)
 *             ไม่ว่าเคาะแบบไหน ห้ามแปล "ยังไม่ได้ระบุ" เป็น "ไม่มี" ตอนส่งให้ผู้ดูแล (E1) — ดู buildInfectionDisclosure
 */
export const INFECTION_ACK_REQUIRED_BY_STATE = {
  yes: true,
  no: false,
  unset: false,
} as const;

export function needsInfectionAck(value: boolean | null | undefined): boolean {
  if (value === true) return INFECTION_ACK_REQUIRED_BY_STATE.yes;
  if (value === false) return INFECTION_ACK_REQUIRED_BY_STATE.no;
  return INFECTION_ACK_REQUIRED_BY_STATE.unset;
}

// ─── ผู้ดูแลเห็นข้อมูลได้เมื่อไร ─────────────────────────────────────────────

/**
 * สถานะคำขอที่ผู้ดูแลผู้รับคำขอยังเห็นข้อมูลได้
 * E5: rejected / cancelled / expired / unmatched -> ไม่เห็น (null)
 * E6 (งานจบแล้ว 'completed'): ⚠ ยังไม่เคาะ — ตอนนี้ไม่ส่ง (ปลอดภัยไว้ก่อน) แก้ที่นี่ที่เดียว
 */
export const INFECTION_DISCLOSURE_VISIBLE_STATUSES: readonly string[] = [
  'pending',
  'accepted',
  'confirmed',
];

export interface InfectionDisclosureView {
  /** null = ญาติยังไม่ได้ระบุ (ไม่ใช่ "ไม่มี") */
  hasInfectiousDisease: boolean | null;
  /** เวลาที่ผู้ดูแลคนนี้รับทราบ "ค่าล่าสุด" · null = ยังไม่ได้รับทราบ หรือรับทราบไว้ก่อนญาติแก้ค่า */
  acknowledgedAt: Date | null;
}

export interface InfectionDisclosureInput {
  /** สถานะของ booking */
  status: string;
  /** ผู้ดูแลที่ผูกกับ booking ตอนนี้ และผู้ที่กำลังขอดู (ต้องเป็นคนเดียวกัน) */
  bookingCaregiverId: string | null;
  viewerCaregiverId: string;
  /** ค่าล่าสุดจาก care_recipients (NULL ถ้าไม่มีโปรไฟล์) */
  hasInfectiousDisease: boolean | null | undefined;
  infectiousDiseaseUpdatedAt: Date | null | undefined;
  /** bookings.infection_ack_at / infection_ack_by */
  infectionAckAt: Date | null | undefined;
  infectionAckBy: string | null | undefined;
}

/**
 * ประกอบ infectionDisclosure ของคำขอรับงาน — null = ห้ามส่งข้อมูลให้ผู้ดูแลคนนี้
 *
 * E2/E3: รับทราบนับก็ต่อเมื่อ (1) รับทราบโดยผู้ดูแลคนนี้ และ (2) เกิดไม่ก่อนญาติแก้ค่าล่าสุด
 *        (เทียบ infection_ack_at กับ infectious_disease_updated_at)
 */
export function buildInfectionDisclosure(i: InfectionDisclosureInput): InfectionDisclosureView | null {
  if (!i.bookingCaregiverId || i.bookingCaregiverId !== i.viewerCaregiverId) return null;
  if (!INFECTION_DISCLOSURE_VISIBLE_STATUSES.includes(i.status)) return null;

  const ackIsCurrent =
    !!i.infectionAckAt &&
    i.infectionAckBy === i.viewerCaregiverId &&
    (!i.infectiousDiseaseUpdatedAt ||
      i.infectionAckAt.getTime() >= i.infectiousDiseaseUpdatedAt.getTime());

  return {
    hasInfectiousDisease: i.hasInfectiousDisease ?? null,
    acknowledgedAt: ackIsCurrent ? (i.infectionAckAt as Date) : null,
  };
}
