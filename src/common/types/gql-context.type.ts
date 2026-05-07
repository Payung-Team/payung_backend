import { Request } from 'express';
import { AuthUser } from '../decorators/current-user.decorator';

/** Express Request + user ที่ SupabaseAuthGuard inject เข้ามา */
export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
}

/** Shape ของ GraphQL context ที่ NestJS สร้างให้ */
export interface GqlContext {
  req: AuthenticatedRequest;
}
