import { Resolver, Query, Mutation } from '@nestjs/graphql';
// ใช้ User entity ตัวใหม่ที่มี field ครบถ้วน (avatarUrl, updatedAt, ฯลฯ)
import { User } from './auth/entities/user.entity';
import { AuthPayload } from './models/auth-payload.model';

@Resolver()
export class IdentityResolver {
  // --- Queries ---
  @Query(() => User, { name: 'me', description: 'Get current logged-in user' })
  getMe(): User {
    return {
      id: 'mock-user-123',
      email: 'test@payung.com',
      displayName: 'Payung User',
      role: 'USER',
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  @Query(() => String, { description: 'Get KYC status of caregiver' })
  kycStatus(): string {
    return 'PENDING';
  }

  // --- Mutations ---
  @Mutation(() => AuthPayload, { description: 'Register a new user' })
  register(): AuthPayload {
    return {
      accessToken: 'mock-jwt-token',
      refreshToken: 'mock-refresh-token',
      user: this.getMe(),
    };
  }

  @Mutation(() => Boolean, { description: 'Logout user' })
  logout(): boolean {
    return true;
  }

  @Mutation(() => Boolean, { description: 'Submit KYC information' })
  submitKyc(): boolean {
    return true;
  }

  @Mutation(() => Boolean, { description: 'Upload KYC document' })
  uploadKycDocument(): boolean {
    return true;
  }
}