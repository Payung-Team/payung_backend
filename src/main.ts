import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(
    new ValidationPipe({
      // transform: true → แปลง plain object จาก request เป็น class instance อัตโนมัติ
      // เช่น JSON object → KycInput class (เพื่อให้ class-validator ทำงานได้)
      transform: true,
      // whitelist: true → ตัด field ที่ไม่ได้ประกาศใน DTO ออกอัตโนมัติ
      // ป้องกัน client ส่ง field แปลกๆ มา (เช่น isAdmin: true)
      whitelist: true,
      // forbidNonWhitelisted: true → ถ้า client ส่ง field ที่ไม่อยู่ใน DTO → throw error
      // เข้มกว่า whitelist อย่างเดียว ที่แค่ตัดออกเงียบๆ
      forbidNonWhitelisted: true,
    }),
  );

  // CORS — อ่านจาก env FRONTEND_URL; fallback localhost สำหรับ local dev
  app.enableCors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
  });

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
