import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase.service';
import { PrismaService } from '../prisma.service';

/**
 * SupabaseHttpAuthGuard — เวอร์ชัน REST สำหรับ HTTP Controller
 *
 * เหมือน SupabaseAuthGuard ทุกอย่าง แต่ใช้ switchToHttp() แทน GqlExecutionContext
 * เพราะ GqlExecutionContext จะล้มเหลวกับ REST endpoint
 *
 * Flow:
 *   1. ดึง Bearer token จาก Authorization header
 *   2. ส่งให้ Supabase ตรวจว่า token valid ไหม
 *   3. ถ้า valid → ดึง user จาก DB
 *   4. เช็ค isSuspended → throw 403 ถ้าถูกระงับ
 *   5. inject user เข้า req.user
 */
@Injectable()
export class SupabaseHttpAuthGuard implements CanActivate {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly prismaService: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: unknown;
    }>();

    // ── ดึง token จาก "Authorization: Bearer <token>" ──
    const authHeader = req.headers?.['authorization'];
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

    // ── ดึงข้อมูล user จาก DB (ต้องการ role, id, isSuspended) ──
    const user = await this.prismaService.user.findUnique({
      where: { supabaseUid: data.user.id },
    });

    if (!user) {
      throw new UnauthorizedException('User account not found');
    }

    const isSuspended = !user.isActive || user.is_deleted;
    if (isSuspended) {
      throw new ForbiddenException('บัญชีถูกระงับ');
    }

    req.user = {
      id: user.id,
      supabaseUid: user.supabaseUid,
      email: user.email,
      role: user.role,
      isSuspended,
    };

    return true;
  }
}
