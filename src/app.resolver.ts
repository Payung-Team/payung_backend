import { Query, Resolver } from '@nestjs/graphql';
import { HealthStatus } from './health/health.model';

@Resolver()
export class AppResolver {
  @Query(() => HealthStatus, { description: 'Health check - API & DB Status' })
  health(): HealthStatus {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      supabaseConnected: true, // Mock ไว้ก่อน รอต่อ Supabase จริง
    };
  }
}
