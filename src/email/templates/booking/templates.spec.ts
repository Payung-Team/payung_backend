/**
 * Unit tests สำหรับ Wave 1 booking lifecycle templates (PYG-293)
 * - subject ถูก
 * - dynamic data render ถูก
 * - XSS escape ทำงาน (ชื่อ + decline reason)
 * - role-aware render สำหรับ confirmed/completed/payment_captured
 */
import {
  bookingCreatedTemplate,
  bookingAcceptedTemplate,
  bookingDeclinedTemplate,
  bookingConfirmedTemplate,
  bookingCompletedTemplate,
  paymentHeldTemplate,
  paymentCapturedTemplate,
  refundIssuedTemplate,
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
  timeText: '09:00 - 13:00 น. (4 ชม.)',
  serviceText: 'ดูแลทั่วไป',
  locationAddress: '123 ถ.สุขุมวิท กรุงเทพฯ',
  serviceCostText: '฿1,000',
  platformFeeText: '฿100',
  totalText: '฿1,100',
  paymentAmountText: '฿1,100',
  chargeId: 'chrg_test_abc123',
  bookingId: 'booking-uuid-1',
  frontendUrl: 'https://payung.app',
};

describe('Wave 1 booking templates', () => {
  describe('booking.created', () => {
    const tpl = bookingCreatedTemplate({ ...baseCtx, recipientRole: 'caregiver' });
    it('subject = "[Payung] คุณมีคำขอจองใหม่"', () => {
      expect(tpl.subject).toBe('[Payung] คุณมีคำขอจองใหม่');
    });
    it('CTA → /bookings/{id}', () => {
      expect(tpl.html).toContain('https://payung.app/bookings/booking-uuid-1');
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
      expect(tpl.subject).toBe('[Payung] ผู้ดูแลรับคำขอแล้ว');
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
      expect(tpl.subject).toBe('[Payung] ผู้ดูแลปฏิเสธคำขอ');
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
      const tpl = bookingConfirmedTemplate({ ...baseCtx, recipientRole: 'patient' });
      expect(tpl.subject).toBe('[Payung] การจองยืนยันแล้ว');
      expect(tpl.html).toContain('ติดต่อผู้ดูแล');
      expect(tpl.html).toContain('0812345678');
    });

    it('caregiver ไม่เห็นเบอร์ตัวเอง', () => {
      const tpl = bookingConfirmedTemplate({ ...baseCtx, recipientRole: 'caregiver' });
      expect(tpl.html).not.toContain('ติดต่อผู้ดูแล');
      expect(tpl.html).toContain('เตรียมตัวให้บริการ');
    });
  });

  describe('booking.completed (role-aware)', () => {
    it('patient → CTA = review link', () => {
      const tpl = bookingCompletedTemplate({ ...baseCtx, recipientRole: 'patient' });
      expect(tpl.subject).toBe('[Payung] บริการเสร็จสิ้น');
      expect(tpl.html).toContain('/bookings/booking-uuid-1/review');
      expect(tpl.html).toContain('ให้คะแนนผู้ดูแล');
    });

    it('caregiver → CTA = ดูสรุปงาน (no review link)', () => {
      const tpl = bookingCompletedTemplate({ ...baseCtx, recipientRole: 'caregiver' });
      expect(tpl.html).not.toContain('/review');
      expect(tpl.html).toContain('ดูสรุปงาน');
    });
  });

  describe('payment.held', () => {
    const tpl = paymentHeldTemplate(baseCtx);
    it('subject', () => {
      expect(tpl.subject).toBe('[Payung] ชำระเงินเรียบร้อย');
    });
    it('แสดง price breakdown 3 บรรทัด', () => {
      expect(tpl.html).toContain('ค่าบริการ');
      expect(tpl.html).toContain('ค่าดำเนินการ (10%)');
      expect(tpl.html).toContain('ยอดรวม');
      expect(tpl.html).toContain('฿1,000');
      expect(tpl.html).toContain('฿100');
      expect(tpl.html).toContain('฿1,100');
    });
    it('payment_method = บัตรเครดิต + chargeId (ไม่มี Visa/last4)', () => {
      expect(tpl.html).toContain('บัตรเครดิต (ref: chrg_test_abc123)');
      expect(tpl.html).not.toMatch(/Visa|•••|last4/i);
    });
  });

  describe('payment.captured (role-aware)', () => {
    it('patient เห็น "วิธีชำระเงิน"', () => {
      const tpl = paymentCapturedTemplate({ ...baseCtx, recipientRole: 'patient' });
      expect(tpl.subject).toBe('[Payung] เรียกเก็บเงินแล้ว');
      expect(tpl.html).toContain('วิธีชำระเงิน');
      expect(tpl.html).toContain('ดูใบเสร็จ');
    });

    it('caregiver ไม่เห็นวิธีชำระเงิน, เห็น "ค่าตอบแทน"', () => {
      const tpl = paymentCapturedTemplate({ ...baseCtx, recipientRole: 'caregiver' });
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
      expect(tpl.subject).toBe('[Payung] คืนเงินเรียบร้อย ฿500');
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
        paymentHeldTemplate(baseCtx),
        paymentCapturedTemplate(baseCtx),
        refundIssuedTemplate(baseCtx),
      ];
      for (const tpl of all) {
        expect(tpl.html).toContain('Payung');
        expect(tpl.html).toContain('settings/email'); // unsubscribe link
        expect(tpl.text).toContain('support@payung.app');
      }
    });
  });
});
