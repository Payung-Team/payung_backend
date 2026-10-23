import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { ConsentModule } from '../consent/consent.module';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { ServicePackageService } from './service-package.service';
import { RecommendedServicePackagesResolver } from './service-package.resolver';

@Module({
  imports: [CommonModule, ConsentModule],
  providers: [
    ServicePackageService,
    RecommendedServicePackagesResolver,
    SupabaseAuthGuard,
  ],
})
export class ServicePackageModule {}
