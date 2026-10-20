import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { SupabaseService } from '../supabase.service';
import { PrismaService } from '../prisma.service';
import { GqlContext } from '../types/gql-context.type';
import { AuthUser } from '../decorators/current-user.decorator';

/**
 * SupabaseAuthGuard — ตรวจสอบ JWT token ในทุก request ที่ต้องการ auth
 *
 * Flow:
 *   1. ดึง Bearer token จาก Authorization header
 *   2. ส่งให้ Supabase ตรวจว่า token valid ไหม
 *   3. ถ้า valid → ดึง user จาก DB ของเรา
 *   4. PYG-132: เช็คว่า user.isSuspended = true ไหม → ถ้าใช่ throw 403
 *   5. inject user เข้า req.user
 *   6. ถ้า token ไม่ valid → throw UnauthorizedException
 *
 * ทำไม check suspended ที่ Guard นี้ (ไม่ใช่ที่ resolver)?
 * - Guard รันก่อน resolver ทุกครั้งที่ต้องการ auth
 * - ถ้า check ที่นี่ครั้งเดียว → ครอบคลุมทุก endpoint อัตโนมัติ
 * - ป้องกัน developer ลืม check ตอนเขียน endpoint ใหม่
 */
@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  constructor(
    private supabaseService: SupabaseService,
    private prismaService: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const ctx = GqlExecutionContext.create(context);
    const req = ctx.getContext<GqlContext>().req;

    // ── inject user เข้า request เพื่อให้ @CurrentUser() และ RolesGuard ใช้ได้ ──
    req.user = await this.authenticateRequest(req);
    return true;
  }

  /**
   * ตรวจ token ของ request แล้วคืน AuthUser — ตรรกะเดียวกับ canActivate ทุกขั้น
   *
   * PYG-603: แยกออกมาให้เรียกตรง ๆ ได้ เพราะ `requestPhoneOtp` เป็น mutation เดียวที่
   *   "บางจุดประสงค์ต้องล็อกอิน บางจุดประสงค์ไม่ต้อง" (SIGNUP/LOGIN = public, LINK = ต้องล็อกอิน)
   *   ติด @UseGuards ทั้ง mutation ไม่ได้ (คนที่ยังไม่มีบัญชีจะสมัครไม่ได้)
   *   ★ ใช้เมธอดนี้แทนการเขียนตรวจ token ซ้ำ — การเช็คบัญชีถูกระงับ (PYG-132) จะได้มีที่เดียว
   *
   * @throws UnauthorizedException ไม่มี token / token ไม่ถูกต้อง / ไม่พบบัญชี
   * @throws ForbiddenException    บัญชีถูกระงับ
   */
  async authenticateRequest(req: GqlContext['req']): Promise<AuthUser> {
    // ── ดึง token จาก "Authorization: Bearer <token>" ──
    const authHeader = req.headers?.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing authorization token');
    }

    const token = authHeader.split(' ')[1];

    // ── ให้ Supabase ตรวจ token ──
    const supabase = this.supabaseService.getClient();
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data.user) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    // ── ดึงข้อมูล user จาก DB ของเรา (ต้องการ role, id, isSuspended) ──
    const user = await this.prismaService.user.findUnique({
      where: { supabaseUid: data.user.id },
    });

    if (!user) {
      throw new UnauthorizedException('User account not found');
    }

    // ── PYG-132: เช็ค suspended ก่อนปล่อยผ่าน ──
    // ถ้า admin "ระงับ" บัญชี → ห้ามใช้ API ทุก endpoint ที่ผ่าน Guard นี้
    // isSuspended = !isActive หรือ is_deleted (computed จาก 2 fields หลัง db pull)
    const isSuspended = !user.isActive || user.is_deleted;
    if (isSuspended) {
      throw new ForbiddenException('บัญชีถูกระงับ');
    }

    return {
      id: user.id,
      supabaseUid: user.supabaseUid,
      email: user.email, // PYG-603: null ได้ (บัญชีที่สมัครด้วยเบอร์)
      role: user.role,
      isSuspended,
    };
  }
}
