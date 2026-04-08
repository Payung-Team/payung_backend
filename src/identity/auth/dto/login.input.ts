/**
 * LoginInput — DTO (Data Transfer Object) สำหรับ login mutation
 *
 * DTO คืออะไร?
 * - คือ "แบบฟอร์ม" ที่กำหนดว่า client (frontend) ต้องส่งข้อมูลอะไรมา
 * - @InputType() = บอก GraphQL ว่านี่คือ "input" (ข้อมูลขาเข้า)
 *   ต่างจาก @ObjectType() ที่เป็น "output" (ข้อมูลขาออก)
 *
 * ใน GraphQL Playground จะใช้แบบนี้:
 *   mutation {
 *     login(input: { email: "test@test.com", password: "123456" }) {
 *       accessToken
 *       user { id email }
 *     }
 *   }
 */
import { InputType, Field } from '@nestjs/graphql';

@InputType()
export class LoginInput {
  @Field({ description: 'Email address of the user' })
  email!: string;

  @Field({ description: 'Password of the user' })
  password!: string;
}
