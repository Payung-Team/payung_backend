import { createServer } from 'node:http';
import { httpServerHandler } from 'cloudflare:node';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import express from 'express';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';
import { runScheduledTasks } from './cloudflare/run-scheduled';

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

export default {
  fetch: httpHandler.fetch,
  scheduled(controller: ScheduledController, _env: unknown, ctx: ExecutionContext) {
    ctx.waitUntil(
      getNestApp().then((app) =>
        runScheduledTasks(app, controller.cron, controller.scheduledTime),
      ),
    );
  },
};
