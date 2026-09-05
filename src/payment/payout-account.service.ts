/**
 * PayoutAccountService — PYG-266: สร้าง/ยืนยัน Omise Recipient สำหรับบัญชีรับเงินของ caregiver
 *
 * แยกจาก KYC/Admin เป็น service ของตัวเอง (อยู่ใน PaymentModule เพราะเป็นเรื่อง
 * Omise integration โดยตรง — OmiseController ที่รับ recipient webhook ก็อยู่ module เดียวกัน):
 *
 * - createRecipientForCaregiver — เรียก fire-and-forget จาก AdminService.approveKyc
 *   และจาก KycService.updatePayoutAccount หลัง upsert สำเร็จ
 * - handleRecipientWebhook — เรียกจาก OmiseController ตอนรับ recipient.verified/failed
 *
 * ── state machine ของบัญชีรับเงิน (ห้ามให้ resolver ตั้ง status ตรง ๆ) ───────────
 *
 *   กรอกบัญชี          status='pending'  recipient_status='unverified'
 *        │
 *        ├─ createRecipient สำเร็จ ──→ status='pending'  recipient_status='pending'
 *        │                             (ส่งให้ Omise ตรวจแล้ว ยังไม่ใช่ตรวจผ่าน)
 *        │
 *        ├─ webhook verified ────────→ status='active'   recipient_status='verified'
 *        │                             + verified_at
 *        │
 *        └─ webhook failed ──────────→ status='pending'  recipient_status='failed'
 *                                      (คง pending ไว้ให้แก้บัญชีใหม่ได้)
 *
 * ⚠️ status='active' มีประตูเดียวคือ handleRecipientWebhook เท่านั้น
 *    เดิม createRecipientForCaregiver ตั้ง status='active' ทันทีที่สร้าง recipient สำเร็จ
 *    ทำให้เกิดแถวที่ active แต่ recipient ยังไม่ผ่านการตรวจ — ซึ่งแปลว่าเงินออกไปหา
 *    บัญชีที่ธนาคารยังไม่ยืนยันได้ (แถว scb/6789 ใน DB คือของจริงที่ค้างอยู่แบบนั้น)
 *
 * PayoutWorkerService เช็ค recipient_status='verified' อยู่แล้วก่อนโอน — TASK 5
 * จะเพิ่มเงื่อนไข status='active' เข้าไปคู่กันให้ครบตาม DoD
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { PayoutEncryptionService } from '../common/crypto/payout-encryption.service';
import { OmiseService } from './omise/omise.service';
import { PaymentError } from './errors/omise-error-mapper';

/**
 * error code ที่ FE ใช้แยกเคส "เลขบัญชีผิด ผู้ใช้ต้องแก้เอง" ออกจาก "ระบบขัดข้อง รอได้"
 * (TASK 4 — ตัวตัดสินสุดท้ายเรื่องความถูกต้องของเลขบัญชีคือ Omise ไม่ใช่กฎที่เราเดา)
 */
export const PAYOUT_ACCOUNT_NUMBER_INVALID = 'PAYOUT_ACCOUNT_NUMBER_INVALID';

@Injectable()
export class PayoutAccountService {
  private readonly logger = new Logger(PayoutAccountService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly omiseService: OmiseService,
    private readonly payoutEncryption: PayoutEncryptionService,
  ) {}

  /**
   * createRecipientForCaregiver — สร้าง Omise Recipient จากบัญชีรับเงินที่ caregiver กรอกไว้
   *
   * Fire-and-forget: เรียกด้วย `void` เสมอ ไม่ throw ออกไปหา caller (approveKyc /
   * updatePayoutAccount ต้องไม่ล้มเพราะ Omise ล่ม) — error ทั้งหมด catch + log ในนี้
   */
  async createRecipientForCaregiver(
    caregiverId: string,
    fullName: string,
    email: string,
  ): Promise<void> {
    try {
      const account = await this.prisma.caregiverPayoutAccount.findUnique({
        where: { caregiverId },
      });

      if (!account) {
        this.logger.log(
          `[PayoutAccount] no payout account yet for caregiver ${caregiverId} — skipping recipient creation`,
        );
        return;
      }

      if (account.omiseRecipientId) {
        this.logger.log(
          `[PayoutAccount] caregiver ${caregiverId} already has omiseRecipientId — skipping`,
        );
        return;
      }

      const accountNumber = this.payoutEncryption.decrypt(account.accountNumberEnc);

      const recipient = await this.omiseService.createRecipient({
        name: fullName,
        email,
        bankCode: account.bankCode,
        accountNumber,
        accountName: account.accountName,
      });

      // ★ สร้าง recipient สำเร็จ = "ส่งให้ Omise ตรวจแล้ว" ยังไม่ใช่ "ตรวจผ่าน"
      //   status ต้องคง 'pending' ไว้ — คนที่มีสิทธิ์ตั้ง 'active' คือ webhook เท่านั้น
      //   (เดิมตั้ง status='active' ตรงนี้ ทำให้ได้แถวที่ active แต่ recipient ยัง unverified
      //    ซึ่งเป็นสภาพของแถว scb/6789 ใน DB ตอนนี้)
      await this.prisma.caregiverPayoutAccount.update({
        where: { caregiverId },
        data: {
          omiseRecipientId: recipient.id,
          recipientStatus: 'pending',
        },
      });

      this.logger.log(
        `[PayoutAccount] created Omise recipient ${recipient.id} for caregiver ${caregiverId}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const httpStatus =
        err instanceof PaymentError ? (err.details.httpStatus ?? 0) : 0;

      // ── แยก "ผู้ใช้ต้องแก้เอง" ออกจาก "ระบบขัดข้อง รอได้" ────────────────────
      // 4xx = Omise ปฏิเสธข้อมูลบัญชี (เลขผิด/ชื่อไม่ตรง/ธนาคารไม่รับ) → ไม่มีทาง
      //       สำเร็จเองถ้าลองใหม่ด้วยข้อมูลเดิม ต้องให้ caregiver แก้
      //       ปล่อยค้าง 'unverified' = เงียบหาย ไม่มีใครรู้ว่าต้องทำอะไรต่อ
      // 5xx / network = Omise ล่มชั่วคราว → คง 'unverified' ไว้ให้ลองใหม่รอบหน้า
      const isPermanent = httpStatus >= 400 && httpStatus < 500;
      if (isPermanent) {
        try {
          await this.prisma.caregiverPayoutAccount.update({
            where: { caregiverId },
            data: { recipientStatus: 'failed', status: 'pending' },
          });
        } catch (markErr) {
          const m = markErr instanceof Error ? markErr.message : String(markErr);
          this.logger.error(
            `[PayoutAccount] mark failed ไม่สำเร็จ caregiverId=${caregiverId}: ${m}`,
          );
        }
      }

      this.logger.error(
        `[PayoutAccount] createRecipientForCaregiver failed caregiverId=${caregiverId} ` +
          `httpStatus=${httpStatus || 'n/a'} ` +
          `code=${isPermanent ? PAYOUT_ACCOUNT_NUMBER_INVALID : 'transient'}: ${msg}`,
      );
      // ไม่ throw — ดู class doc ด้านบน
    }
  }

  /**
   * handleRecipientWebhook — อัปเดต recipientStatus จาก Omise webhook
   *
   * @param recipientId - Omise recipient id (จาก webhook body.data.id)
   * @param eventKey     - 'recipient.verified' | 'recipient.failed'
   */
  async handleRecipientWebhook(
    recipientId: string,
    eventKey: 'recipient.verified' | 'recipient.failed',
  ): Promise<void> {
    // omiseRecipientId ไม่ใช่ unique column (มีแค่ caregiverId ที่ unique) → ใช้ findFirst
    const account = await this.prisma.caregiverPayoutAccount.findFirst({
      where: { omiseRecipientId: recipientId },
    });

    if (!account) {
      this.logger.warn(
        `[PayoutAccount] webhook ${eventKey} for unknown recipientId=${recipientId} — skipping`,
      );
      return;
    }

    const targetFromEvent = eventKey === 'recipient.verified' ? 'verified' : 'failed';

    // Idempotency — เช็คทั้ง recipientStatus และ status ที่ต้องมาคู่กัน
    // ไม่เช็คแค่ recipientStatus อย่างเดียว เพราะถ้ารอบก่อนเขียน recipientStatus สำเร็จ
    // แต่ล้มก่อนตั้ง status แถวนั้นจะค้างไม่สอดคล้องถาวร (webhook ซ้ำจะ return ทิ้ง)
    const settledStatus = targetFromEvent === 'verified' ? 'active' : 'pending';
    if (account.recipientStatus === targetFromEvent && account.status === settledStatus) {
      this.logger.log(
        `[PayoutAccount] recipientId=${recipientId} already '${account.recipientStatus}'/` +
          `'${account.status}' — skipping`,
      );
      return;
    }

    // Defense in depth: re-fetch จาก Omise ก่อนเชื่อ webhook body ตรง ๆ
    // ถ้า re-fetch fail (network ฯลฯ) → fallback ไปเชื่อ eventKey แทนที่จะค้าง unverified ตลอดไป
    let target: 'verified' | 'failed' = targetFromEvent;
    try {
      const fresh = await this.omiseService.retrieveRecipient(recipientId);
      target = fresh.verified ? 'verified' : 'failed';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[PayoutAccount] retrieveRecipient failed recipientId=${recipientId}, falling back to eventKey: ${msg}`,
      );
    }

    // ★ ประตูเดียวที่ตั้ง status='active' ได้ — และตั้งได้ก็ต่อเมื่อ recipient verified แล้ว
    //   verified → active + verified_at ; failed → คง pending ไว้ให้ caregiver แก้บัญชีใหม่ได้
    //   เขียนสามช่องพร้อมกันใน update เดียว ไม่มีจังหวะที่แถวไม่สอดคล้อง
    await this.prisma.caregiverPayoutAccount.update({
      where: { id: account.id },
      data: {
        recipientStatus: target,
        status: target === 'verified' ? 'active' : 'pending',
        verifiedAt: target === 'verified' ? new Date() : account.verifiedAt,
      },
    });

    this.logger.log(
      `[PayoutAccount] recipientId=${recipientId} → recipientStatus='${target}' ` +
        `status='${target === 'verified' ? 'active' : 'pending'}'`,
    );
  }
}
