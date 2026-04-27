/**
 * NotificationService — CRUD สำหรับ in-app notifications (PYG-95)
 *
 * ทำหน้าที่:
 * - สร้าง notification เมื่อมีเหตุการณ์สำคัญ (เช่น KYC status เปลี่ยน)
 * - ให้ user ดู/อ่าน/mark-as-read notification ของตัวเอง
 *
 * Security:
 * - ทุก method ที่เกี่ยวข้องกับ user ต้องผ่าน userId (จาก JWT)
 *   เพื่อป้องกันคนอื่นอ่าน notification ของคนอื่น (defense in depth — นอกเหนือ RLS)
 *
 * Methods:
 * - create()          — สร้าง notification ใหม่ (เรียกจาก service อื่น เช่น KycService)
 * - findByUser()      — ดึง notification ของ user (filter unreadOnly + limit)
 * - markAsRead()      — mark 1 notification เป็นอ่านแล้ว
 * - markAllAsRead()   — mark ทั้งหมดของ user เป็นอ่านแล้ว
 * - countUnread()     — นับจำนวน notification ที่ยังไม่อ่าน (สำหรับ badge)
 */
import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import type { Prisma, NotificationType as PrismaNotificationType } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { Notification } from './entities/notification.entity';
import { NotificationType } from './entities/notification-type.enum';

/**
 * Shape ของ Notification ที่ Prisma คืนมา
 * - ใช้ PrismaNotificationType (enum จาก Prisma) แทน local NotificationType
 *   เพราะ Prisma generate เป็น string literal union ไม่ใช่ TS enum — type ต่างกัน
 *   แต่ runtime value เหมือนกัน (ทั้งคู่เป็น string 'kyc_submitted' เป็นต้น)
 */
type PrismaNotification = {
  id: string;
  userId: string;
  type: PrismaNotificationType;
  title: string;
  body: string;
  data: Prisma.JsonValue | null;   // jsonb — อาจเป็น null ถ้าไม่มี metadata
  isRead: boolean;
  readAt: Date | null;
  createdAt: Date;
};

/** options สำหรับ findByUser */
export type FindByUserOptions = {
  limit?: number;         // จำกัดจำนวน (default: ไม่จำกัด)
  offset?: number;        // ข้ามกี่รายการ (สำหรับ pagination — PYG-97)
  unreadOnly?: boolean;   // true = ดึงเฉพาะที่ยังไม่อ่าน
};

@Injectable()
export class NotificationService {
  constructor(private readonly prismaService: PrismaService) {}

  // ─── Private helper ──────────────────────────────────────────────────────

  /**
   * แปลง Prisma Notification → GraphQL Notification entity
   * - data (jsonb) ถูก serialize เป็น string เพื่อให้ GraphQL ส่งได้
   *   (ถ้าในอนาคตเพิ่ม graphql-type-json ใน deps ค่อยเปลี่ยนเป็น passthrough)
   * - type (Prisma's string union) cast เป็น local TS enum — runtime value ตรงกัน
   */
  private mapToEntity(n: PrismaNotification): Notification {
    return {
      id: n.id,
      userId: n.userId,
      type: n.type as NotificationType,  // Prisma string union → TS enum (same string values)
      title: n.title,
      body: n.body,
      // jsonb (object) → JSON string — null → undefined (GraphQL nullable)
      data: n.data === null ? undefined : JSON.stringify(n.data),
      isRead: n.isRead,
      readAt: n.readAt ?? undefined,
      createdAt: n.createdAt,
    };
  }

  // ─── Public methods ───────────────────────────────────────────────────────

  /**
   * สร้าง notification ใหม่
   *
   * ใช้เมื่อ: service อื่น (เช่น KycService) ต้องการแจ้งเตือน user
   * ตัวอย่าง: KYC verified → notification แจ้ง caregiver
   *
   * @param userId - internal user id (ผู้รับ notification)
   * @param type   - NotificationType enum
   * @param title  - หัวข้อสั้นๆ
   * @param body   - เนื้อหารายละเอียด
   * @param data   - metadata เพิ่มเติม (optional, เช่น { caregiverId })
   */
  async create(
    userId: string,
    type: NotificationType,
    title: string,
    body: string,
    data?: Record<string, unknown>,
  ): Promise<Notification> {
    const notification = await this.prismaService.notification.create({
      data: {
        userId,
        type,
        title,
        body,
        // ถ้า undefined → Prisma จะส่งเป็น null ใน DB
        data: data === undefined ? undefined : (data as Prisma.InputJsonValue),
        // isRead = false, createdAt = now() (default จาก schema)
      },
    });

    return this.mapToEntity(notification);
  }

  /**
   * ดึง notification ของ user
   *
   * ใช้เมื่อ: แสดงหน้า notification center
   * เรียงจากใหม่ → เก่า (createdAt DESC)
   * index: (userId, isRead, createdAt DESC) — query นี้ใช้ index ตรงๆ
   *
   * @param userId   - internal user id (ของคนที่ login อยู่)
   * @param options  - { limit, unreadOnly }
   */
  async findByUser(
    userId: string,
    options: FindByUserOptions = {},
  ): Promise<Notification[]> {
    const { limit, offset, unreadOnly } = options;

    const notifications = await this.prismaService.notification.findMany({
      where: {
        userId,
        // ถ้า unreadOnly = true → filter เฉพาะที่ยังไม่อ่าน
        ...(unreadOnly ? { isRead: false } : {}),
      },
      orderBy: { createdAt: 'desc' },
      // ถ้า limit/offset = undefined → Prisma ไม่จำกัด
      take: limit,
      skip: offset,
    });

    return notifications.map((n) => this.mapToEntity(n));
  }

  /**
   * Mark notification 1 รายการเป็นอ่านแล้ว
   *
   * Security:
   * - ต้องส่ง userId เพื่อ verify ว่า user เป็นเจ้าของ notification จริง
   * - ถ้า notification ไม่ใช่ของ user → throw ForbiddenException
   *
   * @param id      - UUID ของ notification
   * @param userId  - internal user id (ของคนที่ login อยู่)
   * @throws NotFoundException ถ้าไม่พบ notification
   * @throws ForbiddenException ถ้า notification ไม่ใช่ของ user
   */
  async markAsRead(id: string, userId: string): Promise<Notification> {
    const existing = await this.prismaService.notification.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException(`Notification "${id}" not found`);
    }

    // ตรวจว่า notification เป็นของ user จริง (ป้องกันการแก้ของคนอื่น)
    if (existing.userId !== userId) {
      throw new ForbiddenException(
        'You do not have permission to modify this notification',
      );
    }

    // ถ้าอ่านแล้วไม่ต้องอัปเดต readAt ซ้ำ (idempotent)
    if (existing.isRead) {
      return this.mapToEntity(existing);
    }

    const updated = await this.prismaService.notification.update({
      where: { id },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });

    return this.mapToEntity(updated);
  }

  /**
   * Mark notification ทั้งหมดของ user เป็นอ่านแล้ว
   *
   * ใช้เมื่อ: user กดปุ่ม "อ่านทั้งหมด"
   * ใช้ updateMany (Prisma) → รัน SQL UPDATE ครั้งเดียว (efficient)
   *
   * @param userId - internal user id
   * @returns จำนวน notification ที่ถูก mark
   */
  async markAllAsRead(userId: string): Promise<{ count: number }> {
    const result = await this.prismaService.notification.updateMany({
      where: {
        userId,
        isRead: false,  // อัปเดตเฉพาะที่ยังไม่อ่าน (ไม่เขียนทับ readAt เดิม)
      },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });

    return { count: result.count };
  }

  /**
   * นับจำนวน notification ที่ยังไม่อ่านของ user
   *
   * ใช้เมื่อ: แสดง badge count บน notification icon
   * index: (userId, isRead, createdAt DESC) — count query ใช้ index prefix ได้
   *
   * @param userId - internal user id
   */
  async countUnread(userId: string): Promise<number> {
    return this.prismaService.notification.count({
      where: {
        userId,
        isRead: false,
      },
    });
  }
}
