import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';

/**
 * ดึง user จาก GraphQL context
 * ถูก inject โดย SupabaseAuthGuard หลังตรวจ JWT สำเร็จ
 *
 * @example
 * async submitKyc(@CurrentUser() user: AuthUser) { ... }
 */

/** Shape ของ user ที่ Guard inject เข้า request */
export class AuthUser {
  id!: string; // users.id (internal UUID)
  supabaseUid!: string; // Supabase Auth UID
  email!: string;
  role!: number; // role id (1=patient, 2=caregiver) — เก็บเป็น number ในฐานข้อมูล
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const gqlCtx = GqlExecutionContext.create(ctx);
    // generic บอก context shape → TypeScript ไม่ต้อง infer เป็น unknown
    return gqlCtx.getContext<{ req: { user: AuthUser } }>().req.user;
  },
);
