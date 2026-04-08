import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { GqlContext } from '../types/gql-context.type';

/**
 * RolesGuard — เช็คว่า user มี role ที่อนุญาตไหม
 *
 * ต้องรันหลัง SupabaseAuthGuard (เพราะต้องการ req.user ที่ inject แล้ว)
 * ถ้า @Roles() ไม่ได้กำหนดไว้ → อนุญาตทุก role (guard จะ return true)
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // อ่าน roles ที่กำหนดไว้ใน @Roles() decorator
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // ถ้าไม่ได้กำหนด @Roles() → ไม่จำกัด role
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const ctx = GqlExecutionContext.create(context);
    const user = ctx.getContext<GqlContext>().req.user;

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
