/**
 * Unit tests สำหรับ booking lifecycle per-event templates
 * - subject ถูก
 * - dynamic data render ถูก
 * - XSS escape ทำงาน (ชื่อ + decline reason)
 * - role-aware render สำหรับ confirmed/completed/payment_captured/dispute_resolved
 */
import {
  bookingCreatedTemplate,
  bookingAcceptedTemplate,
  bookingDeclinedTemplate,
  bookingConfirmedTemplate,
  bookingCompletedTemplate,
  bookingCancelledTemplate,
  paymentHeldTemplate,
  paymentCapturedTemplate,
  refundIssuedTemplate,
  disputeCreatedTemplate,
  disputeResolvedTemplate,
  type BookingEmailContext,
} from './index';

const baseCtx: BookingEmailContext = {
  recipientName: 'มาลี ใจดี',
  recipientRole: 'patient',
  caregiverName: 'สมชาย ใจเย็น',
  caregiverPhone: '0812345678',
  caregiverRatingText: '4.8 ★ (รีวิว 12 ครั้ง)',
  patientName: 'มาลี ใจดี',
  dateText: '15 กรกฎาคม 2569',
  timeText: '09:00 – 13:00 (4 ชม.)', // PYG-526: รูปแบบเดียวกับหน้าเว็บ (formatTimeRange)
  serviceText: 'ดูแลทั่วไป',
  locationAddress: '123 ถ.สุขุมวิท กรุงเทพฯ',
  // platform_fee = NULL ในทุก booking ปัจจุบัน → ไม่มี breakdown ค่าบริการ/ค่าธรรมเนียม
  serviceCostText: undefined,
  platformFeeText: undefined,
  totalText: '฿1,100', // ยอดที่เรียกเก็บจริง (= paymentAmountText) ไม่ใช่ estimated × 1.1
  paymentAmountText: '฿1,100',
  chargeId: 'chrg_test_abc123',
  bookingId: 'booking-uuid-1',
  frontendUrl: 'https://payung.app',
};

describe('Booking per-event templates', () => {
  describe('booking.created', () => {
    const tpl = bookingCreatedTemplate({
      ...baseCtx,
      recipientRole: 'caregiver',
    });
    it('subject = "คุณมีคำขอจองใหม่ — Payung"', () => {
      expect(tpl.subject).toBe('คุณมีคำขอจองใหม่ — Payung');
    });
    // PYG-703: ผู้รับคือผู้ดูแล → หน้างานของผู้ดูแล (เดิม /bookings/{id} = หน้าของผู้รับบริการ)
    it('CTA → /caregiver/bookings/{id}', () => {
      expect(tpl.html).toContain(
        'https://payung.app/caregiver/bookings/booking-uuid-1',
      );
      expect(tpl.html).toContain('ดูคำขอจอง');
    });
    it('render booking details', () => {
      expect(tpl.html).toContain('15 กรกฎาคม 2569');
      expect(tpl.html).toContain('ดูแลทั่วไป');
    });
  });

  describe('booking.accepted', () => {
    const tpl = bookingAcceptedTemplate(baseCtx);
    it('subject', () => {
      expect(tpl.subject).toBe('ผู้ดูแลรับคำขอแล้ว — Payung');
    });
    it('CTA = "ชำระเงินเพื่อยืนยัน"', () => {
      expect(tpl.html).toContain('ชำระเงินเพื่อยืนยัน');
    });
    it('แสดงคะแนนผู้ดูแล', () => {
      expect(tpl.html).toContain('4.8 ★');
    });
  });

  describe('booking.declined (XSS guard)', () => {
    it('escape decline reason ที่มี HTML', () => {
      const tpl = bookingDeclinedTemplate({
        ...baseCtx,
        declineReason: '<img src=x onerror=alert(1)>',
      });
      expect(tpl.subject).toBe('ผู้ดูแลปฏิเสธคำขอ — Payung');
      expect(tpl.html).not.toContain('<img src=x');
      expect(tpl.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });

    it('ไม่แสดง reason block ถ้าไม่มี reason', () => {
      const tpl = bookingDeclinedTemplate(baseCtx);
      expect(tpl.html).not.toContain('เหตุผล:');
    });
  });

  describe('booking.confirmed (role-aware)', () => {
    it('patient เห็นเบอร์ติดต่อ caregiver', () => {
      const tpl = bookingConfirmedTemplate({
        ...baseCtx,
        recipientRole: 'patient',
      });
      expect(tpl.subject).toBe('การจองยืนยันแล้ว — Payung');
      // PYG-732: เบอร์อยู่ในแถว "ผู้ดูแล" ของตาราง (design: ชื่อ · เบอร์)
      expect(tpl.html).toContain('0812345678');
    });

    it('caregiver ไม่เห็นเบอร์ตัวเอง', () => {
      const tpl = bookingConfirmedTemplate({
        ...baseCtx,
        recipientRole: 'caregiver',
      });
      expect(tpl.html).not.toContain('ติดต่อผู้ดูแล');
      expect(tpl.html).toContain('เตรียมตัวให้บริการ');
    });
  });

  describe('booking.completed (role-aware)', () => {
    // PYG-703: เดิม /bookings/{id}/review ไม่มี route ใน FE — ฟอร์มให้คะแนนอยู่ในหน้ารายละเอียดการจอง
    it('patient → CTA ให้คะแนน → หน้ารายละเอียดการจอง', () => {
      const tpl = bookingCompletedTemplate({
        ...baseCtx,
        recipientRole: 'patient',
      });
      expect(tpl.subject).toBe('บริการเสร็จสิ้น — Payung');
      expect(tpl.html).toContain(
        'href="https://payung.app/bookings/booking-uuid-1"',
      );
      expect(tpl.html).not.toContain('/review');
      expect(tpl.html).toContain('ให้คะแนนผู้ดูแล');
    });

    it('caregiver → CTA = ดูสรุปงาน (no review link)', () => {
      const tpl = bookingCompletedTemplate({
        ...baseCtx,
        recipientRole: 'caregiver',
      });
      expect(tpl.html).not.toContain('/review');
      expect(tpl.html).toContain(
        'https://payung.app/caregiver/bookings/booking-uuid-1',
      );
      expect(tpl.html).toContain('ดูสรุปงาน');
    });
  });

  describe('payment.held', () => {
    const tpl = paymentHeldTemplate(baseCtx); // platform_fee NULL → ไม่มี breakdown
    it('subject', () => {
      expect(tpl.subject).toBe('ชำระเงินเรียบร้อย — Payung');
    });
    // 🔴 regression (booking-email-total-amount): platform_fee NULL → ซ่อนบรรทัดค่าธรรมเนียม
    it('platform_fee NULL → ไม่มีบรรทัดค่าบริการ/ค่าธรรมเนียม (ไม่ ฿0.00) แต่มียอดรวมจริง', () => {
      expect(tpl.html).not.toContain('ค่าบริการ');
      expect(tpl.html).not.toContain('ค่าดำเนินการ');
      expect(tpl.html).not.toContain('฿0.00');
      expect(tpl.text).not.toContain('ค่าดำเนินการ');
      expect(tpl.html).toContain('ยอดรวม');
      expect(tpl.html).toContain('฿1,100'); // ยอดที่เรียกเก็บจริง
    });
    it('มี platform_fee จริง (future) → แสดง breakdown แยกบรรทัด ไม่มี label "10%"', () => {
      const withFee = paymentHeldTemplate({
        ...baseCtx,
        serviceCostText: '฿2,000',
        platformFeeText: '฿200',
        totalText: '฿2,000',
      });
      expect(withFee.html).toContain('ค่าบริการ');
      expect(withFee.html).toContain('ค่าดำเนินการ');
      expect(withFee.html).toContain('฿2,000');
      expect(withFee.html).toContain('฿200');
      expect(withFee.html).not.toContain('(10%)');
    });
    it('payment_method = บัตรเครดิต + chargeId (ไม่มี Visa/last4)', () => {
      expect(tpl.html).toContain('บัตรเครดิต (ref: chrg_test_abc123)');
      expect(tpl.html).not.toMatch(/Visa|•••|last4/i);
    });
  });

  describe('payment.captured (role-aware)', () => {
    it('patient เห็น "วิธีชำระเงิน"', () => {
      const tpl = paymentCapturedTemplate({
        ...baseCtx,
        recipientRole: 'patient',
      });
      expect(tpl.subject).toBe('เรียกเก็บเงินแล้ว — Payung');
      expect(tpl.html).toContain('ชำระด้วยบัตรเครดิต');
      expect(tpl.html).toContain('ดูใบเสร็จ');
    });

    it('caregiver ไม่เห็นวิธีชำระเงิน, เห็น "ค่าตอบแทน"', () => {
      const tpl = paymentCapturedTemplate({
        ...baseCtx,
        recipientRole: 'caregiver',
      });
      expect(tpl.html).not.toContain('วิธีชำระเงิน');
      expect(tpl.html).toContain('ค่าตอบแทน');
      expect(tpl.html).toContain('ดูรายละเอียดงาน');
    });
  });

  describe('refund.issued', () => {
    it('subject มี amount', () => {
      const tpl = refundIssuedTemplate({
        ...baseCtx,
        refundAmountText: '฿500',
      });
      expect(tpl.subject).toBe('คืนเงินเรียบร้อย ฿500 — Payung');
      expect(tpl.html).toContain('฿500');
    });

    it('fallback เป็น paymentAmountText ถ้าไม่มี refundAmountText', () => {
      const tpl = refundIssuedTemplate(baseCtx); // paymentAmountText = ฿1,100
      expect(tpl.subject).toContain('฿1,100');
    });

    it('แสดง chargeId อ้างอิงบัตรเดิม', () => {
      const tpl = refundIssuedTemplate(baseCtx);
      expect(tpl.html).toContain('บัตรเครดิต (ref: chrg_test_abc123)');
    });
  });

  describe('booking.cancelled', () => {
    const tpl = bookingCancelledTemplate({
      ...baseCtx,
      recipientRole: 'caregiver',
    });
    it('subject', () => {
      expect(tpl.subject).toBe('การจองถูกยกเลิก — Payung');
    });
    it('แสดงชื่อผู้ใช้บริการที่ยกเลิก', () => {
      expect(tpl.html).toContain('มาลี ใจดี');
      expect(tpl.html).toContain('ยกเลิก');
    });
    it('CTA → /caregiver/bookings/{id} (ผู้รับคือผู้ดูแล)', () => {
      expect(tpl.html).toContain(
        'https://payung.app/caregiver/bookings/booking-uuid-1',
      );
    });
  });

  describe('dispute.created (admin)', () => {
    it('subject + CTA admin queue', () => {
      const tpl = disputeCreatedTemplate({
        ...baseCtx,
        recipientRole: 'admin',
        recipientName: 'แอดมิน',
        declineReason: 'บริการไม่ตรงตามที่ตกลงและผู้ดูแลมาสาย',
      });
      expect(tpl.subject).toBe('แจ้งปัญหาใหม่ — Payung');
      expect(tpl.html).toContain('/admin/disputes');
      expect(tpl.html).toContain('ดูคิวปัญหา');
      expect(tpl.html).toContain('รายละเอียดที่ผู้แจ้งเขียน');
    });

    it('escape dispute reason ที่มี HTML', () => {
      const tpl = disputeCreatedTemplate({
        ...baseCtx,
        recipientRole: 'admin',
        declineReason: '<script>alert(1)</script>',
      });
      expect(tpl.html).not.toContain('<script>alert(1)</script>');
      expect(tpl.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });
  });

  describe('dispute.resolved', () => {
    it('patient CTA → /bookings/{id}', () => {
      const tpl = disputeResolvedTemplate({
        ...baseCtx,
        recipientRole: 'patient',
      });
      expect(tpl.subject).toBe('ผลตรวจสอบปัญหา — Payung');
      expect(tpl.html).toContain('ดูผลการตรวจสอบ');
      expect(tpl.html).toContain('https://payung.app/bookings/booking-uuid-1');
    });

    it('caregiver ก็ได้ subject เดียวกัน', () => {
      const tpl = disputeResolvedTemplate({
        ...baseCtx,
        recipientRole: 'caregiver',
      });
      expect(tpl.subject).toBe('ผลตรวจสอบปัญหา — Payung');
      expect(tpl.html).toContain('ดูผลการตรวจสอบ');
    });
  });

  describe('common — XSS escape on recipientName', () => {
    it('escape ชื่อผู้รับ', () => {
      const tpl = bookingAcceptedTemplate({
        ...baseCtx,
        recipientName: '<b>evil</b>',
      });
      expect(tpl.html).not.toContain('<b>evil</b>');
      expect(tpl.html).toContain('&lt;b&gt;evil&lt;/b&gt;');
    });
  });

  describe('common — wrapHtml structure', () => {
    it('ทุก template มี Payung header + footer unsubscribe', () => {
      const all = [
        bookingCreatedTemplate(baseCtx),
        bookingAcceptedTemplate(baseCtx),
        bookingDeclinedTemplate(baseCtx),
        bookingConfirmedTemplate(baseCtx),
        bookingCompletedTemplate(baseCtx),
        bookingCancelledTemplate(baseCtx),
        paymentHeldTemplate(baseCtx),
        paymentCapturedTemplate(baseCtx),
        refundIssuedTemplate(baseCtx),
        disputeResolvedTemplate(baseCtx),
      ];
      for (const tpl of all) {
        expect(tpl.html).toContain('Payung');
        // PYG-703: ลิงก์ตั้งค่าการรับอีเมลไปหน้าการแจ้งเตือน (เดิม /settings/email ไม่มีใน FE)
        expect(tpl.html).toContain('https://payung.app/notifications');
        expect(tpl.html).not.toContain('settings/email');
        expect(tpl.text).toContain('payung.care@gmail.com');
      }
    });

    // PYG-732: อีเมลถึงแอดมินมีป้าย "Admin" และไม่มีลิงก์ตั้งค่าการรับอีเมล (แอดมินปิดรับไม่ได้)
    it('อีเมลถึงแอดมิน: ป้าย Admin · ไม่มีลิงก์ตั้งค่าการรับอีเมล', () => {
      const tpl = disputeCreatedTemplate({
        ...baseCtx,
        recipientRole: 'admin',
      });
      expect(tpl.html).toContain('>Admin</td>');
      expect(tpl.html).not.toContain('/notifications');
    });

    it('ทุก template มีป้ายสถานะมุมขวาบน', () => {
      for (const tpl of [
        bookingCreatedTemplate(baseCtx),
        bookingConfirmedTemplate(baseCtx),
        paymentCapturedTemplate(baseCtx),
      ]) {
        expect(tpl.html).toMatch(
          /border-radius:999px; white-space:nowrap;">[^<]+<\/span>/,
        );
      }
    });
  });
});
