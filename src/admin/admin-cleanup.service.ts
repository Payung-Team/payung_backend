/**
 * AdminCleanupService — PYG-159: Cron job สำหรับลบ admin accounts ที่ครบ grace period
 *
 * Flow:
 * 1. ทำงานทุกวันตอนเที่ยงคืน (ปรับได้ผ่าน CRON_ADMIN_CLEANUP_SCHEDULE env)
 * 2. หา admin ที่ scheduled_delete_at <= NOW() และยังไม่ถูกลบ
 * 3. สำหรับแต่ละ admin: soft-delete → delete Supabase Auth → audit log → email
 * 4. Error isolation: ถ้า 1 admin fail → ทำต่อกับ admin ถัดไป
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
export class AdminCleanupService {
  private readonly logger = new Logger(AdminCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabaseService: SupabaseService,
    private readonly emailService: EmailService,
  ) {}

  // @Cron(process.env['CRON_ADMIN_CLEANUP_SCHEDULE'] ?? CronExpression.EVERY_DAY_AT_MIDNIGHT) — disabled for demo
  async handleAdminCleanup(): Promise<void> {
    this.logger.log('Starting admin cleanup cron job...');

    try {
      const adminsToDelete = await this.prisma.user.findMany({
        where: {
          scheduled_delete_at: { lte: new Date() },
          is_deleted: false,
          role: { in: [3, 4] },
        },
      });

      if (adminsToDelete.length === 0) {
        this.logger.log('No admins to delete. Cron job complete.');
        return;
      }

      this.logger.log(`Found ${adminsToDelete.length} admin(s) to auto-delete.`);

      for (const admin of adminsToDelete) {
        try {
          await this.deleteAdmin(admin);
          this.logger.log(`Auto-deleted admin: ${admin.email} (${admin.id})`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          this.logger.error(`Failed to auto-delete admin ${admin.email}: ${msg}`);
        }
      }

      this.logger.log(`Admin cleanup complete. Processed ${adminsToDelete.length} admin(s).`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Admin cleanup cron job failed: ${msg}`);
    }
  }

  private async deleteAdmin(admin: {
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
      where: { id: admin.id },
      data: {
        is_deleted: true,
        deleted_at: deletedAt,
      },
    });

    // ─── 2. ลบ Supabase Auth user ─────────────────────────────────────────
    try {
      const supabaseAdmin = this.supabaseService.getAdminClient();
      await supabaseAdmin.auth.admin.deleteUser(admin.supabaseUid);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to delete Supabase auth for ${admin.email}: ${msg}`);
    }

    // ─── 3. Audit log ─────────────────────────────────────────────────────
    try {
      const scheduledBy = admin.deletion_scheduled_by ?? admin.id;
      const details = JSON.stringify({
        email: admin.email,
        scheduledDeleteAt: admin.scheduled_delete_at?.toISOString(),
        deletedAt: deletedAt.toISOString(),
      });
      await this.prisma.$executeRaw`
        INSERT INTO admin_audit_logs (id, admin_id, action, target_user_id, details, created_at)
        VALUES (gen_random_uuid(), ${scheduledBy}, 'ADMIN_AUTO_DELETED', ${admin.id}, ${details}::jsonb, NOW())
      `;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to create audit log for ${admin.email}: ${msg}`);
    }

    // ─── 4. ส่ง email สุดท้าย ────────────────────────────────────────────
    try {
      await this.emailService.sendAdminAutoDeleted(admin.email, admin.displayName);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to send deletion email to ${admin.email}: ${msg}`);
    }
  }
}
