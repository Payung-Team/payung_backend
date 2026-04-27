/**
 * NotificationResolver — GraphQL endpoints สำหรับ in-app notifications (PYG-97)
 *
 * 4 endpoints ที่ frontend ใช้:
 * - notifications     → query รายการ notification ของ user (filter unreadOnly + limit)
 * - unreadCount       → query นับจำนวนที่ยังไม่อ่าน (สำหรับ badge bell)
 * - markAsRead        → mutation mark 1 รายการเป็นอ่านแล้ว
 * - markAllAsRead     → mutation mark ทั้งหมดของ user เป็นอ่านแล้ว
 *
 * ทุก endpoint ต้อง login (SupabaseAuthGuard) และ scope ด้วย userId เสมอ
 * → กันคนแอบดู notification ของคนอื่น (defense in depth — เสริม RLS)
 */
import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { Notification } from './entities/notification.entity';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import {
  CurrentUser,
  AuthUser,
} from '../common/decorators/current-user.decorator';

@Resolver(() => Notification)
@UseGuards(SupabaseAuthGuard) // ทุก endpoint ใน resolver นี้ต้อง login ก่อน
export class NotificationResolver {
  constructor(private readonly notificationService: NotificationService) {}

  /**
   * notifications — ดึงรายการ notification ของ user (เรียงใหม่ → เก่า)
   *
   * @param limit       - จำกัดจำนวน default 20 (frontend ใช้ paginated list)
   * @param unreadOnly  - true = เอาเฉพาะที่ยังไม่อ่าน, false/undefined = ทุกอย่าง
   */
  @Query(() => [Notification], {
    description: 'List notifications of current user (newest first)',
  })
  async notifications(
    @CurrentUser() user: AuthUser,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 })
    limit: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 })
    offset: number,
    @Args('unreadOnly', { type: () => Boolean, nullable: true, defaultValue: false })
    unreadOnly: boolean,
  ): Promise<Notification[]> {
    return this.notificationService.findByUser(user.id, {
      limit,
      offset,
      unreadOnly,
    });
  }

  /**
   * unreadCount — สำหรับ badge bell ที่ Header
   * frontend poll ค่านี้ทุก 30-60 วิ
   */
  @Query(() => Int, {
    description: 'Count of unread notifications for current user',
  })
  async unreadCount(@CurrentUser() user: AuthUser): Promise<number> {
    return this.notificationService.countUnread(user.id);
  }

  /**
   * markAsRead — mark 1 notification เป็นอ่านแล้ว
   * NotificationService ตรวจ ownership ให้ (throw ForbiddenException ถ้าไม่ใช่ของ user)
   */
  @Mutation(() => Notification, {
    description: 'Mark a single notification as read',
  })
  async markAsRead(
    @CurrentUser() user: AuthUser,
    @Args('id') id: string,
  ): Promise<Notification> {
    return this.notificationService.markAsRead(id, user.id);
  }

  /**
   * markAllAsRead — mark ทั้งหมดของ user เป็นอ่านแล้ว
   * return Boolean (frontend ไม่ต้องการ count กลับ — แค่ยืนยันสำเร็จ)
   */
  @Mutation(() => Boolean, {
    description: 'Mark all notifications of current user as read',
  })
  async markAllAsRead(@CurrentUser() user: AuthUser): Promise<boolean> {
    await this.notificationService.markAllAsRead(user.id);
    return true;
  }
}
