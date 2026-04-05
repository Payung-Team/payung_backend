import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

/**
 * ใช้กับ Resolver/Controller เพื่อกำหนดว่า role ไหนเข้าได้
 * @example @Roles('caregiver')
 */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
