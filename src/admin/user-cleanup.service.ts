/**
 * UserCleanupService — Cron job สำหรับลบ user/caregiver accounts ที่ครบ grace period
 *
 * Flow:
 * 1. ทำงานทุกวันตอนเที่ยงคืน (ปรับได้ผ่าน CRON_USER_CLEANUP_SCHEDULE env)
 * 2. หา user/caregiver ที่ scheduled_delete_at <= NOW() และยังไม่ถูกลบ (role 1–2)
 * 3. สำหรับแต่ละ user: soft-delete → delete Supabase Auth → audit log → email
 * 4. Error isolation: ถ้า 1 user fail → ทำต่อกับ user ถัดไป
 *
 * Soft-delete (ไม่ลบ row):
 *   is_deleted = true, deleted_at = NOW()
 *   เหตุผล: ต้องเก็บ audit trail ไว้ตรวจสอบย้อนหลัง
 *
 * Supabase Auth:
 *   auth.admin.deleteUser(uid) — ลบ user ออกจาก Supabase Auth ถาวร
 *   ถ้าล้มเหลว → log warning แต่ไม่ fail (DB guard ยังทำงานอยู่)
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma.service';
import { SupabaseService } from '../common/supabase.service';
import { EmailService } from '../email/email.service';

@Injectable()
export class UserCleanupService {
  private readonly logger = new Logger(UserCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabaseService: SupabaseService,
    private readonly emailService: EmailService,
  ) {}

  @Cron(process.env['CRON_USER_CLEANUP_SCHEDULE'] ?? CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleUserCleanup(): Promise<void> {
    this.logger.log('Starting user cleanup cron job...');

    try {
      const usersToDelete = await this.prisma.user.findMany({
        where: {
          scheduled_delete_at: { lte: new Date() },
          is_deleted: false,
          role: { in: [1, 2] },
        },
      });

      if (usersToDelete.length === 0) {
        this.logger.log('No users to delete. Cron job complete.');
        return;
      }

      this.logger.log(`Found ${usersToDelete.length} user(s) to auto-delete.`);

      for (const user of usersToDelete) {
        try {
          await this.deleteUser(user);
          this.logger.log(`Auto-deleted user: ${user.email} (${user.id})`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          this.logger.error(`Failed to auto-delete user ${user.email}: ${msg}`);
        }
      }

      this.logger.log(`User cleanup complete. Processed ${usersToDelete.length} user(s).`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`User cleanup cron job failed: ${msg}`);
    }
  }

  private async deleteUser(user: {
    id: string;
    email: string;
    displayName: string | null;
    supabaseUid: string;
    scheduled_delete_at: Date | null;
    deletion_scheduled_by: string | null;
  }): Promise<void> {
    const deletedAt = new Date();

    // ─── 1. Soft-delete ใน DB ─────────────────────────────────────────────
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        is_deleted: true,
        deleted_at: deletedAt,
      },
    });

    // ─── 2. ลบ Supabase Auth user ─────────────────────────────────────────
    try {
      const supabaseAdmin = this.supabaseService.getAdminClient();
      await supabaseAdmin.auth.admin.deleteUser(user.supabaseUid);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to delete Supabase auth for ${user.email}: ${msg}`);
    }

    // ─── 3. Audit log ─────────────────────────────────────────────────────
    try {
      const scheduledBy = user.deletion_scheduled_by ?? user.id;
      const details = JSON.stringify({
        email: user.email,
        scheduledDeleteAt: user.scheduled_delete_at?.toISOString(),
        deletedAt: deletedAt.toISOString(),
      });
      await this.prisma.$executeRaw`
        INSERT INTO admin_audit_logs (id, admin_id, action, target_user_id, details, created_at)
        VALUES (gen_random_uuid(), ${scheduledBy}, 'USER_AUTO_DELETED', ${user.id}, ${details}::jsonb, NOW())
      `;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to create audit log for ${user.email}: ${msg}`);
    }

    // ─── 4. ส่ง email สุดท้าย ────────────────────────────────────────────
    try {
      await this.emailService.sendUserAutoDeleted(user.email, user.displayName);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to send deletion email to ${user.email}: ${msg}`);
    }
  }
}
