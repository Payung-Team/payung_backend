/**
 * AuthModule — Module สำหรับ Authentication
 *
 * NestJS ใช้ระบบ Module เพื่อจัดกลุ่มโค้ดที่เกี่ยวข้องกันไว้ด้วยกัน
 * - AuthResolver + AuthService อยู่ด้วยกันใน AuthModule
 * - Module นี้ถูก import เข้า AppModule (app.module.ts) เพื่อให้ app รู้จัก
 *
 * providers = service/resolver ที่อยู่ใน module นี้
 * (ไม่ต้อง import CommonModule เพราะ CommonModule เป็น @Global() อยู่แล้ว)
 */
import { Module } from '@nestjs/common';
import { AuthResolver } from './auth.resolver';
import { AuthService } from './auth.service';
import { UserService } from './user.service';

@Module({
  providers: [AuthResolver, AuthService, UserService],
})
export class AuthModule {}
