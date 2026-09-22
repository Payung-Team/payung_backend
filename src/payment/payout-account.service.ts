/**
 * PayoutAccountService — PYG-266: สร้าง/ยืนยัน Omise Recipient สำหรับบัญชีรับเงินของ caregiver
 *
 * แยกจาก KYC/Admin เป็น service ของตัวเอง (อยู่ใน PaymentModule เพราะเป็นเรื่อง
 * Omise integration โดยตรง — OmiseController ที่รับ recipient webhook ก็อยู่ module เดียวกัน):
 *
 * - createRecipientForCaregiver — เรียก fire-and-forget จาก AdminService.approveKyc
 *   และจาก KycService.updatePayoutAccount หลัง upsert สำเร็จ
 * - reconcileRecipient — sync สถานะล่าสุดจาก Omise เมื่อมี webhook หรือ worker พบข้อมูลค้าง
 *
 * ── state machine ของบัญชีรับเงิน (ห้ามให้ resolver ตั้ง status ตรง ๆ) ───────────
 *
 *   กรอกบัญชี          status='pending'  recipient_status='unverified'
 *        │
 *        ├─ createRecipient สำเร็จ ──→ status='pending'  recipient_status='pending'
 *        │                             (ส่งให้ Omise ตรวจแล้ว ยังไม่ใช่ตรวจผ่าน)
 *        │
 *        ├─ Omise verified ──────────→ status='pending'  recipient_status='verified'
 *        │                             + verified_at (ยังไม่โอนจนกว่าจะ active)
 *        │
 *        ├─ Omise active ────────────→ status='active'   recipient_status='verified'
 *        │
 *        └─ มี failure_code ─────────→ status='pending'  recipient_status='failed'
 *
 * ⚠️ status='active' มีประตูเดียวคือ reconcileRecipient เท่านั้น
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

  /** Sync local payout-account state from the current Omise recipient object. */
  async reconcileRecipient(
    recipientId: string,
    source: string,
  ): Promise<{ recipientStatus: string; status: string } | null> {
    // omiseRecipientId ไม่ใช่ unique column (มีแค่ caregiverId ที่ unique) → ใช้ findFirst
    const account = await this.prisma.caregiverPayoutAccount.findFirst({
      where: { omiseRecipientId: recipientId },
    });

    if (!account) {
      this.logger.warn(
        `[PayoutAccount] reconcile source=${source} for unknown recipientId=${recipientId} — skipping`,
      );
      return null;
    }

    // Never trust the webhook name as the final state. Verify and activate can
    // arrive separately or out of order; the retrieved object is authoritative.
    const fresh = await this.omiseService.retrieveRecipient(recipientId);
    const recipientStatus = fresh.verified
      ? 'verified'
      : fresh.failureCode
        ? 'failed'
        : 'pending';
    const status = fresh.verified && fresh.active ? 'active' : 'pending';

    if (
      account.recipientStatus === recipientStatus &&
      account.status === status &&
      (!fresh.verified || account.verifiedAt)
    ) {
      this.logger.log(
        `[PayoutAccount] recipientId=${recipientId} already '${recipientStatus}'/` +
          `'${status}' (source=${source}) — skipping`,
      );
      return { recipientStatus, status };
    }

    await this.prisma.caregiverPayoutAccount.update({
      where: { id: account.id },
      data: {
        recipientStatus,
        status,
        verifiedAt: fresh.verified
          ? (account.verifiedAt ?? new Date())
          : account.verifiedAt,
      },
    });

    this.logger.log(
      `[PayoutAccount] recipientId=${recipientId} → recipientStatus='${recipientStatus}' ` +
        `status='${status}' (source=${source})`,
    );

    return { recipientStatus, status };
  }
}
