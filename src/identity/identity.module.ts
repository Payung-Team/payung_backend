import { Module } from '@nestjs/common';
import { KycModule } from './kyc/kyc.module';

@Module({
  providers: [KycModule], // นำ KycModule เข้ามาใน IdentityModule
})
export class IdentityModule {}
