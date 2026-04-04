/**
 * AuthResolver — GraphQL Resolver สำหรับ Authentication
 *
 * Resolver คืออะไร?
 * - คือ "ตัวรับ request" จาก GraphQL
 * - เหมือน Controller ใน REST API แต่สำหรับ GraphQL
 * - @Mutation = รับ request ที่เปลี่ยนแปลงข้อมูล (login, register, logout)
 * - @Query   = รับ request ที่แค่อ่านข้อมูล (me, kycStatus)
 *
 * Resolver ไม่ควรมี business logic ซับซ้อน — มันแค่รับ request แล้วส่งต่อให้ Service ทำงาน
 */
import { Resolver, Mutation, Args } from '@nestjs/graphql';
import { AuthPayload } from '../models/auth-payload.model';
import { LoginInput } from './dto/login.input';
import { AuthService } from './auth.service';

@Resolver()
export class AuthResolver {
  // NestJS จะ inject AuthService เข้ามาอัตโนมัติ (Dependency Injection)
  constructor(private authService: AuthService) {}

  /**
   * Login mutation — ใช้ใน GraphQL Playground แบบนี้:
   *
   * mutation {
   *   login(input: { email: "user@example.com", password: "123456" }) {
   *     accessToken
   *     refreshToken
   *     user { id email displayName role }
   *   }
   * }
   *
   * @Args('input') = ดึงค่า "input" จาก GraphQL arguments
   */
  @Mutation(() => AuthPayload, { description: 'Login user with email and password' })
  async login(
    @Args('input') input: LoginInput,
  ): Promise<AuthPayload> {
    return this.authService.login(input);
  }
}
