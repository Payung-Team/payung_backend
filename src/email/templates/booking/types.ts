/**
 * Shared types สำหรับ booking lifecycle email templates
 *
 * BookingEmailContext = ข้อมูลทุกอย่างที่ template "อาจ" ใช้ — listener สร้างทีเดียวแล้วส่งให้
 * ทุก template (template ที่ไม่ใช้บาง field ก็ไม่ destructure ก็พอ)
 */
import type { EmailTemplate } from '../kyc.templates';

/** ผู้รับ — patient / caregiver / admin (admin ใช้กับ dispute_created) */
export type RecipientRole = 'patient' | 'caregiver' | 'admin';

/** context ของอีเมลที่ template ใช้ (พรีแคล format ภาษาไทย/ราคา/เวลาแล้ว) */
export interface BookingEmailContext {
  // ── ผู้รับ ──
  recipientName: string | null;
  recipientRole: RecipientRole;

  // ── คู่สนทนา (อีกฝั่ง) ──
  caregiverName: string;
  caregiverPhone: string | null;
  caregiverRatingText: string;
  patientName: string | null;

  // ── booking summary (พรีแคลแล้ว) ──
  dateText: string;
  timeText: string;
  serviceText: string;
  locationAddress: string;

  // ── ราคา (พรีแคลแล้ว) ──
  /** ค่าบริการ — undefined เมื่อ bookings.platform_fee = NULL (ทุกแถวตอนนี้) → template ซ่อนบรรทัด */
  serviceCostText?: string;
  /** ค่าธรรมเนียม — undefined เมื่อ platform_fee = NULL → template ซ่อนบรรทัด (ห้ามเดา/ห้าม ฿0.00) */
  platformFeeText?: string;
  /** ยอดรวม = ยอดที่เรียกเก็บจริง (payments.amount ?? estimated_cost) — ไม่ ×1.1 */
  totalText: string;

  // ── refund / payment ──
  /** payment hold/captured amount (อาจต่างจาก total เล็กน้อยใน edge case) */
  paymentAmountText: string;
  /** ใช้กับ refund_issued only */
  refundAmountText?: string;
  /** Omise charge id — แสดงใน "วิธีชำระเงิน" สำหรับ payment_held/captured/refund */
  chargeId: string | null;

  // ── ตัวเลือก ──
  /** เหตุผลปฏิเสธ (declined) หรือรายละเอียดปัญหา (dispute_created) */
  declineReason?: string;

  // ── routing ──
  bookingId: string;
  frontendUrl: string;
}

/** signature ของทุก template function */
export type BookingTemplateFn = (ctx: BookingEmailContext) => EmailTemplate;
