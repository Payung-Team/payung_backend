import { Query, Resolver } from '@nestjs/graphql';

// Resolver นี้มีไว้เพื่อให้ GraphQL Schema มี Query อย่างน้อย 1 ตัว
// ถ้าไม่มีเลย NestJS จะ error ตอน start ครับ
@Resolver()
export class AppResolver {
  @Query(() => String, { description: 'Health check - Test is API running' })
  hello(): string {
    return '🌂 Payung API is running!';
  }
}
