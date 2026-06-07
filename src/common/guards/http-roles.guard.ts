import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { AuthUser } from '../decorators/current-user.decorator';

/**
 * HttpRolesGuard — เวอร์ชัน REST สำหรับ HTTP Controller
 *
 * เหมือน RolesGuard ทุกอย่าง แต่ใช้ switchToHttp() แทน GqlExecutionContext
 * ต้องรันหลัง SupabaseHttpAuthGuard เสมอ (เพราะต้องการ req.user)
 */
@Injectable()
export class HttpRolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<number[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // ถ้าไม่ได้กำหนด @Roles() → ไม่จำกัด role
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const req = context.switchToHttp().getRequest<{ user: AuthUser }>();
    const user = req.user;

    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    const hasRole = requiredRoles.includes(user.role);
    if (!hasRole) {
      throw new ForbiddenException(
        `Access denied. Required role: ${requiredRoles.join(' or ')}`,
      );
    }

    return true;
  }
}
