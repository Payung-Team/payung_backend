/**
 * AuthPayload — ข้อมูลที่ส่งกลับไปให้ client หลัง login/register สำเร็จ
 *
 * @ObjectType() = บอก GraphQL ว่านี่คือ "output type" (ข้อมูลขาออก)
 * ต่างจาก @InputType() ที่เป็น "input type" (ข้อมูลขาเข้า)
 *
 * ประกอบด้วย:
 * - accessToken:  JWT token สำหรับยืนยันตัวตนในทุก request (อายุสั้น ~1 ชม.)
 * - refreshToken: ใช้ขอ accessToken ใหม่เมื่อหมดอายุ (ไม่ต้อง login ใหม่)
 * - user:         ข้อมูลของ user ที่ login (id, email, role, ฯลฯ)
 */
import { ObjectType, Field } from '@nestjs/graphql';
// ใช้ User entity ตัวใหม่แทน user.model.ts ตัวเก่า
// เพราะตัวใหม่มี field ครบกว่า (avatarUrl, updatedAt, displayName nullable)
import { User } from '../auth/entities/user.entity';

@ObjectType()
export class AuthPayload {
  @Field({ description: 'JWT access token for API requests' })
  accessToken: string;

  @Field({ description: 'Refresh token for renewing the session' })
  refreshToken: string;

  @Field(() => User, { description: 'The authenticated user' })
  user: User;
}
