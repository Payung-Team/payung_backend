import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { SlidingWindowRateLimiter } from '../../common/rate-limit/sliding-window-rate-limiter';
import { GqlContext } from '../../common/types/gql-context.type';
import { rateLimitIpOf } from '../../common/utils/request-evidence';
import {
  JOIN_RATE_LIMIT_PER_IP,
  JOIN_RATE_LIMIT_PER_USER,
  JOIN_RATE_LIMIT_WINDOW_SECONDS,
} from '../family-group.constants';
import { JoinLinkRateLimitedError } from '../family-group.errors';

/**
 * JoinLinkRateLimitGuard (PYG-479) — จำกัดอัตราการเรียกลิงก์เข้าร่วมกลุ่ม
 *
 * ใช้กับ joinLinkPreview + joinGroupByLink (SCR-FG2-001 ข้อ 3:
 * "จำกัดอัตราการเรียกเข้าร่วมต่อผู้ใช้/IP") นับสองตัวคู่กัน:
 *   - ต่อผู้ใช้ (userId จาก JWT — ปลอมไม่ได้ = ตัวคุมหลัก)
 *   - ต่อ IP   (กันคนเดียวสมัครหลายบัญชีมายิงจากเครื่องเดียว)
 * ชนเพดานตัวไหนก็ตาม → โยน JOIN_LINK_RATE_LIMITED
 *
 * ── วิธีใช้ ──────────────────────────────────────────────────────────────
 *   ติดที่ "เมธอด" ของ resolver (ไม่ใช่ทั้งคลาส):
 *     @UseGuards(JoinLinkRateLimitGuard)
 *   Nest รัน guard ระดับคลาสก่อนระดับเมธอดเสมอ → SupabaseAuthGuard ใส่ req.user ให้แล้ว
 *   ทุกเมธอดที่ติด guard ตัวนี้ในคลาสเดียวกันใช้ "ตัวนับชุดเดียวกัน"
 *   (Nest สร้าง guard instance เดียวต่อโมดูล) → preview กับ join นับรวมกัน
 *
 * ── ทำไมเช็คที่ guard ไม่ใช่ใน service ──────────────────────────────────
 *   guard รันก่อน resolver → คำขอที่เกินเพดานถูกตัดทิ้ง "ก่อน" แตะดีบี
 *   ซึ่งเป็นเหตุผลหลักข้อหนึ่งของการ์ด (ทุกครั้งที่กดต้องค้นดีบี 1 ครั้ง → ยิงรัวได้ = สร้างภาระได้)
 *   และ guard รันแยก "ต่อ field" → ต่อให้ส่ง alias มา 100 ตัวใน query เดียว
 *   ก็ถูกนับทีละตัวครบ ไม่หลุด
 *
 * ── ทำไมไม่มี dependency ใน constructor ────────────────────────────────
 *   guard เก็บตัวนับไว้กับตัวเอง ไม่ inject อะไรเลย → โมดูลไหนที่ใช้ FamilyGroupResolver
 *   (รวมถึง TestingModule ของเทส e2e) ไม่ต้องเพิ่ม provider อะไร แอปก็บูตขึ้นเหมือนเดิม
 *   เวลาใช้ Date.now() ตรง ๆ แทน ClockService ด้วยเหตุผลเดียวกัน
 *   (เทสคุมเวลาด้วย jest.spyOn(Date, 'now') ได้)
 */
@Injectable()
export class JoinLinkRateLimitGuard implements CanActivate {
  private readonly perUser = new SlidingWindowRateLimiter({
    limit: JOIN_RATE_LIMIT_PER_USER,
    windowMs: JOIN_RATE_LIMIT_WINDOW_SECONDS * 1000,
  });

  private readonly perIp = new SlidingWindowRateLimiter({
    limit: JOIN_RATE_LIMIT_PER_IP,
    windowMs: JOIN_RATE_LIMIT_WINDOW_SECONDS * 1000,
  });

  canActivate(context: ExecutionContext): boolean {
    const req =
      GqlExecutionContext.create(context).getContext<GqlContext>().req;

    // ไม่มี user = developer ลืมวาง guard นี้ไว้หลัง SupabaseAuthGuard (defensive
    // แบบเดียวกับ FamilyGroupGuard) — ต้องปฏิเสธ ไม่ใช่ปล่อยผ่านโดยไม่นับ
    const user = req.user;
    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    // หา IP ไม่ได้ (ค่าแปลก ๆ) → ข้ามการนับต่อ IP แต่ยังนับต่อผู้ใช้อยู่
    const ip = rateLimitIpOf(req);
    const now = Date.now();

    // ── 1. เช็คก่อนทั้งสองตัว ยังไม่นับ ─────────────────────────────────────
    const waitMs = Math.max(
      this.perUser.retryAfterMs(user.id, now),
      ip ? this.perIp.retryAfterMs(ip, now) : 0,
    );
    if (waitMs > 0) {
      // ★ ครั้งที่ถูกปฏิเสธ "ไม่ถูกนับ" → เวลาที่บอกให้รอเป็นเวลาจริง
      //   ถ้านับด้วย คนที่กดซ้ำระหว่างรอจะถูกยืดเวลาออกไปเรื่อย ๆ ไม่รู้จบ
      // ปัดขึ้นเป็นวินาที — ปัดลงแล้วได้ 0 จะบอกผู้ใช้ว่า "รอ 0 วินาที" ซึ่งไม่จริง
      throw new JoinLinkRateLimitedError(Math.ceil(waitMs / 1000));
    }

    // ── 2. ผ่านทั้งคู่ → นับพร้อมกันทีเดียว ────────────────────────────────
    // เช็คกับนับอยู่ในฟังก์ชัน sync เดียวกัน (ไม่มี await คั่น) → Node รันรวดเดียวจบ
    // คำขอที่มาพร้อมกันจึงแซงกันระหว่างเช็คกับนับไม่ได้
    this.perUser.record(user.id, now);
    if (ip) {
      this.perIp.record(ip, now);
    }
    return true;
  }
}
