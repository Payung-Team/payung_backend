/**
 * FieldLockGuard (PYG-146) — บล็อก mutation ถ้า client พยายามแก้ field ที่ admin lock ไว้
 *
 * แนวคิด:
 *   admin (ผ่าน PYG-145 toggleFieldLock) สามารถ "lock" บาง field ของ user/caregiver ได้
 *   → user แก้ field นั้นไม่ได้จนกว่า admin จะปลดล็อก
 *   guard นี้ทำหน้าที่ "ด่านตรวจ" ก่อน mutation ทำงาน
 *
 * Flow:
 *   1. mutation ติด @FieldLock() ไหม? ไม่ติด → ไม่เกี่ยว, ปล่อยผ่าน
 *   2. ต้องมี req.user (SupabaseAuthGuard ต้องรันมาก่อน)
 *   3. ดึง input ที่ client ส่งมา = "fields ที่ตั้งใจจะแก้"
 *   4. หา entity_id (USER → users.id, CAREGIVER_PROFILE → caregivers.id)
 *   5. อ่าน active lock จากตาราง field_locks (unlocked_at IS NULL = ยัง lock อยู่)
 *   6. ถ้า field ที่ส่งมา "ชน" กับ field ที่ถูก lock → โยน FIELD_LOCKED
 *      ถ้าไม่ชน (แก้เฉพาะ field ที่ไม่ถูก lock) → ผ่าน (partial update ได้)
 *
 * ⚠️ ลำดับ guard สำคัญ: ต้องรัน "หลัง" SupabaseAuthGuard เสมอ (ต้องการ req.user)
 *   - updateProfile        : @UseGuards(SupabaseAuthGuard, FieldLockGuard)
 *   - updateCaregiverProfile: class มี @UseGuards(SupabaseAuthGuard, RolesGuard) อยู่แล้ว
 *                             → ใส่ @UseGuards(FieldLockGuard) ที่ method (Nest รัน class ก่อน method)
 *
 * ⚠️ ต้องลงทะเบียน FieldLockGuard ใน providers ของ module ที่ใช้ (ตาม convention ทีม)
 *   PrismaService มาจาก CommonModule ที่เป็น @Global() — ไม่ต้อง import เพิ่ม
 *   Reflector มาจาก NestJS core — inject อัตโนมัติ
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { PrismaService } from '../prisma.service';
import { GqlContext } from '../types/gql-context.type';
import {
  FIELD_LOCK_ENTITY_KEY,
  FieldLockEntityType,
} from '../decorators/field-lock.decorator';
import { FieldLockedError } from '../exceptions/field-locked.exception';

/** ข้อความ fallback ถ้าหา displayName ของ admin ที่ lock ไม่เจอ */
const UNKNOWN_ADMIN = 'ผู้ดูแลระบบ';

@Injectable()
export class FieldLockGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // ── 1. mutation นี้ถูกคุมด้วย @FieldLock() ไหม? ──────────────────────
    // ไม่มี metadata = ไม่ใช่ mutation ที่ต้องเช็ค lock → ปล่อยผ่านทันที
    const entityType = this.reflector.getAllAndOverride<FieldLockEntityType>(
      FIELD_LOCK_ENTITY_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!entityType) {
      return true;
    }

    const gqlCtx = GqlExecutionContext.create(context);

    // ── 2. ต้องมี user (inject โดย SupabaseAuthGuard) — defensive check ──
    // ถ้าไม่มี = developer ลืมใส่ SupabaseAuthGuard ก่อน FieldLockGuard
    const user = gqlCtx.getContext<GqlContext>().req.user;
    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    // ── 3. ดึง field ที่ client ส่งมา ────────────────────────────────────
    // guard รัน "ก่อน" ValidationPipe → input ยังเป็น plain object ดิบๆ
    // มีเฉพาะ key ที่ client ส่งมาจริง = ตรงกับ "fields ที่ตั้งใจจะแก้" พอดี
    const args = gqlCtx.getArgs<{ input?: Record<string, unknown> }>();
    const input = args.input;
    if (!input) {
      return true; // ไม่มี input → ไม่มีอะไรให้เช็ค
    }
    const submittedFields = Object.keys(input).filter(
      (key) => input[key] !== undefined,
    );
    if (submittedFields.length === 0) {
      return true; // client ไม่ได้ส่ง field ไหนมาเลย
    }

    // ── 4. หา entity_id ที่จะใช้ค้น lock ────────────────────────────────
    let entityId: string;
    if (entityType === 'USER') {
      entityId = user.id;
    } else {
      // CAREGIVER_PROFILE → lock ผูกกับ caregivers.id (ไม่ใช่ users.id)
      const caregiver = await this.prisma.caregiver.findUnique({
        where: { userId: user.id },
        select: { id: true },
      });
      if (!caregiver) {
        // ยังไม่มี caregiver profile → เป็นไปไม่ได้ที่จะมี lock → ปล่อยผ่าน
        // (ตัว mutation เองจะ handle เคส "ไม่มี profile" ต่อไป)
        return true;
      }
      entityId = caregiver.id;
    }

    // ── 5. อ่าน "active lock" ของ entity นี้ ─────────────────────────────
    // active = ยังไม่ถูกปลดล็อก (unlocked_at IS NULL)
    // join ไป users เพื่อเอา displayName ของ admin ที่ lock (ใส่ใน error)
    const locks = await this.prisma.field_locks.findMany({
      where: {
        entity_type: entityType,
        entity_id: entityId,
        unlocked_at: null,
      },
      select: {
        field_name: true,
        users_field_locks_locked_byTousers: {
          select: { displayName: true },
        },
      },
    });
    if (locks.length === 0) {
      return true; // entity นี้ไม่มี field ใดถูก lock
    }

    // ── 6. หา field ที่ "ชน" (client ส่งมา ∩ ถูก lock) ───────────────────
    // map: field_name → ชื่อ admin ที่ lock field นั้น
    const lockOwnerByField = new Map<string, string>(
      locks.map((lock) => [
        lock.field_name,
        lock.users_field_locks_locked_byTousers?.displayName ?? UNKNOWN_ADMIN,
      ]),
    );

    const violatedFields = submittedFields.filter((field) =>
      lockOwnerByField.has(field),
    );

    // ไม่ชนเลย = client แก้เฉพาะ field ที่ไม่ถูก lock → ผ่าน
    // (DoD: lock บาง field ต้องไม่ block ทั้ง mutation — partial update ได้)
    if (violatedFields.length === 0) {
      return true;
    }

    // ── 7. มี field ที่ถูก lock อยู่ใน input → block ทั้ง mutation ───────
    // lockedBy = ชื่อ admin ที่ lock field แรกที่ชน (contract กำหนดเป็นค่าเดียว)
    const lockedBy = lockOwnerByField.get(violatedFields[0]) ?? UNKNOWN_ADMIN;
    throw new FieldLockedError(violatedFields, lockedBy);
  }
}
