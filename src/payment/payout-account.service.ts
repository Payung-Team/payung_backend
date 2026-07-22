/**
 * PayoutAccountService — PYG-266: สร้าง/ยืนยัน Omise Recipient สำหรับบัญชีรับเงินของ caregiver
 *
 * แยกจาก KYC/Admin เป็น service ของตัวเอง (อยู่ใน PaymentModule เพราะเป็นเรื่อง
 * Omise integration โดยตรง — OmiseController ที่รับ recipient webhook ก็อยู่ module เดียวกัน):
 *
 * - createRecipientForCaregiver — เรียก fire-and-forget จาก AdminService.approveKyc
 *   และจาก KycService.updatePayoutAccount หลัง upsert สำเร็จ
 * - handleRecipientWebhook — เรียกจาก OmiseController ตอนรับ recipient.verified/failed
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { PayoutEncryptionService } from '../common/crypto/payout-encryption.service';
import { OmiseService } from './omise/omise.service';

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

      await this.prisma.caregiverPayoutAccount.update({
        where: { caregiverId },
        data: {
          omiseRecipientId: recipient.id,
          status: 'active',
        },
      });

      this.logger.log(
        `[PayoutAccount] created Omise recipient ${recipient.id} for caregiver ${caregiverId}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[PayoutAccount] createRecipientForCaregiver failed caregiverId=${caregiverId}: ${msg}`,
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

    // Idempotency — ถ้าอยู่ในสถานะเดียวกันอยู่แล้ว ไม่ต้องทำอะไรต่อ
    if (account.recipientStatus === targetFromEvent) {
      this.logger.log(
        `[PayoutAccount] recipientId=${recipientId} already '${account.recipientStatus}' — skipping`,
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

    await this.prisma.caregiverPayoutAccount.update({
      where: { id: account.id },
      data: {
        recipientStatus: target,
        verifiedAt: target === 'verified' ? new Date() : account.verifiedAt,
      },
    });

    this.logger.log(
      `[PayoutAccount] recipientId=${recipientId} → recipientStatus='${target}'`,
    );
  }
}
