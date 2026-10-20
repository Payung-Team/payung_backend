/**
 * TransportMode — คำตอบ "ขับรถรับส่งผู้รับการดูแลเองหรือไม่" (PYG-661 / S06 · มติ 19 ต.ค. 2026 ใน PYG-561)
 *
 * GraphQL: SELF_DRIVE | HIRED_RIDE | NONE · DB (caregivers.transport_mode): self_drive | hired_ride | none
 *   NULL = ยังไม่เคยตอบ (ผู้ดูแลเดิมทั้งหมด · E11) — ห้ามตีความว่า 'none' (E10)
 * Nest map ชื่อ key (GraphQL) ↔ ค่า (ที่เก็บใน DB) ให้เอง
 */
import { registerEnumType } from '@nestjs/graphql';
import { DRIVING_LICENSE_ERROR, DrivingLicenseError } from './driving-license.errors';

export enum TransportMode {
  SELF_DRIVE = 'self_drive',
  HIRED_RIDE = 'hired_ride',
  NONE = 'none',
}

registerEnumType(TransportMode, {
  name: 'TransportMode',
  description:
    'How the caregiver transports the care recipient: SELF_DRIVE (needs a verified driving license), HIRED_RIDE, NONE. null = never answered.',
});

/** ค่าจาก DB → enum · ค่าที่ไม่รู้จัก/NULL → null (ไม่เดา) */
export function toTransportMode(value: string | null | undefined): TransportMode | null {
  return (Object.values(TransportMode) as string[]).includes(value ?? '') ? (value as TransportMode) : null;
}

export interface TransportInput {
  transportMode?: TransportMode | null;
  /** ฟิลด์เดิม (PYG-597) — client เก่ายังส่งอยู่ */
  selfDriveTransport?: boolean | null;
}

export interface ResolvedTransport {
  /** ใช้กับ DrivingLicenseService.assertForKyc — true = ต้องมีใบขับขี่ในรอบส่งนี้ */
  selfDrive: boolean | undefined;
  /** ค่าที่จะเขียนลง caregivers.transport_mode · undefined = ไม่แตะ (คงค่าเดิม/NULL) */
  write: TransportMode | undefined;
}

/**
 * รวม input 2 ทางให้เป็นค่าเดียว:
 *   - ส่ง transportMode → selfDrive = (SELF_DRIVE) และเขียนค่านั้นลงฐาน
 *   - ไม่ส่ง → ใช้ selfDriveTransport เดิม: true → self_drive · false → ไม่เขียน (แยก hired_ride กับ none ไม่ได้ · E10)
 *   - ส่งทั้งสองแต่ขัดกัน → TRANSPORT_MODE_CONFLICT (422)
 */
export function resolveTransport(input: TransportInput): ResolvedTransport {
  const mode = input.transportMode ?? undefined;
  const legacy = input.selfDriveTransport ?? undefined;

  if (mode !== undefined) {
    const selfDrive = mode === TransportMode.SELF_DRIVE;
    if (legacy !== undefined && legacy !== selfDrive) {
      throw new DrivingLicenseError(DRIVING_LICENSE_ERROR.TRANSPORT_MODE_CONFLICT);
    }
    return { selfDrive, write: mode };
  }

  if (legacy === true) return { selfDrive: true, write: TransportMode.SELF_DRIVE };
  return { selfDrive: legacy, write: undefined };
}
