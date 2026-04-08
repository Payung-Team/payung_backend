import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { ConfigModule } from '@nestjs/config';
import { join } from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { GraphQLUpload } = require('graphql-upload');
import { AppResolver } from './app.resolver';
import { CommonModule } from './common/common.module';
import { AuthModule } from './identity/auth/auth.module';
import { IdentityModule } from './identity/identity.module';

@Module({
  imports: [
    // ─── 1. Config Module (โหลด .env ทั่วทั้งโปรเจกต์) ───────────────────
    ConfigModule.forRoot({
      isGlobal: true, // ใช้ได้ทุก Module โดยไม่ต้อง import ซ้ำ
    }),

    // ─── 2. GraphQL Module (Code-First approach) ──────────────────────────
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,

      // autoSchemaFile: สร้าง schema.gql อัตโนมัติจาก TypeScript Decorators
      // join(...) = เซฟไฟล์ไว้ที่ src/schema.gql (เอาไว้ดู/debug)
      autoSchemaFile: join(process.cwd(), 'src/schema.gql'),
      sortSchema: true,

      // ลง Upload scalar จาก graphql-upload (Apollo Server 4+ ไม่รองรับ upload built-in)
      buildSchemaOptions: {
        scalarsMap: [{ type: GraphQLUpload, scalar: GraphQLUpload }],
      },

      // playground: เปิดหน้า UI ทดสอบ API ที่ localhost:3000/graphql
      playground: true,

      // context: ส่ง HTTP request/response เข้าไปใน GraphQL Context
      // (จำเป็นตอนทำ Auth Guard ในอนาคต)
      context: ({ req, res }) => ({ req, res }),
    }),

    // ─── 3. Common Module (Supabase + Prisma services) ───────────────────
    CommonModule,

    // ─── 4. Feature Modules ──────────────────────────────────────────────
    AuthModule,
    IdentityModule,
  ],
  providers: [AppResolver], // ← ลงทะเบียน Resolver ที่นี่
})
export class AppModule {}
