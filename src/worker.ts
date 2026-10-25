import { createServer } from 'node:http';
import { httpServerHandler } from 'cloudflare:node';
import { waitUntil } from 'cloudflare:workers';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import express from 'express';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';
import { runScheduledTasks } from './cloudflare/run-scheduled';
import { registerBackgroundWaitUntil } from './common/background-task';
import { runInRequestDbScope } from './common/request-db-scope';

// งาน fire-and-forget (runInBackground) ต้องผูกกับ waitUntil ไม่งั้น Workers ตัดทิ้งหลังส่ง response
registerBackgroundWaitUntil(waitUntil);

const expressApp = express();
let nestAppPromise: Promise<INestApplication> | undefined;

function getNestApp(): Promise<INestApplication> {
  nestAppPromise ??= (async () => {
    const app = await NestFactory.create(
      AppModule,
      new ExpressAdapter(expressApp),
      { abortOnError: false },
    );
    configureApp(app);
    await app.init();
    return app;
  })();

  return nestAppPromise;
}

const server = createServer((request, response) => {
  void getNestApp()
    .then(() => expressApp(request, response))
    .catch((error: unknown) => {
      console.error('[cloudflare-worker] Nest bootstrap failed', error);
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json' });
      }
      response.end(JSON.stringify({ message: 'Internal server error' }));
    });
});
const httpHandler = httpServerHandler(
  server as Parameters<typeof httpServerHandler>[0],
);

interface WorkerEnv {
  HYPERDRIVE: Hyperdrive;
}

function useWorkerDatabase(env: WorkerEnv): void {
  // Hyperdrive bindings are objects, so Cloudflare cannot copy them into
  // process.env through nodejs_compat_populate_process_env. Prisma and pg read
  // DATABASE_URL, therefore expose Hyperdrive's per-environment URL before
  // the request opens its database connection (see request-db-scope.ts).
  process.env.DATABASE_URL = env.HYPERDRIVE.connectionString;
}

export default {
  fetch(...args: Parameters<NonNullable<typeof httpHandler.fetch>>) {
    useWorkerDatabase(args[1] as unknown as WorkerEnv);
    // การเชื่อมต่อฐานข้อมูลของคำขอนี้ปิดหลังส่ง response + งานเบื้องหลังจบ (ไม่หน่วง response)
    const { result, disposed } = runInRequestDbScope(() =>
      Promise.resolve(httpHandler.fetch!(...args)),
    );
    (args[2] as ExecutionContext).waitUntil(disposed);
    return result;
  },
  scheduled(controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext) {
    useWorkerDatabase(env);
    const { disposed } = runInRequestDbScope(() =>
      getNestApp().then((app) =>
        runScheduledTasks(app, controller.cron, controller.scheduledTime),
      ),
    );
    ctx.waitUntil(disposed);
  },
};
