import { INestApplication, ValidationPipe } from '@nestjs/common';

export function configureApp(app: INestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  const configuredOrigins = (process.env.FRONTEND_URL ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.enableCors({
    origin:
      configuredOrigins.length > 0
        ? configuredOrigins
        : process.env.NODE_ENV === 'production'
          ? false
          : true,
    credentials: true,
  });
}
