import 'reflect-metadata';
import { config as loadDotenv } from 'dotenv';
loadDotenv();

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
  const { AppModule } = await import('./app.module');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false });

  app.enableCors({ origin: (_o, cb) => cb(null, true), credentials: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const swagger = new DocumentBuilder()
    .setTitle('Gasless Relayer')
    .setDescription('Gasless EIP-7702 transaction relayer')
    .setVersion('0.1.0')
    .build();
  const doc = SwaggerModule.createDocument(app, swagger);
  SwaggerModule.setup('swagger', app, doc, { jsonDocumentUrl: 'swagger/json' });

  const port = Number(process.env.SERVICE_PORT ?? '3100');
  const host = process.env.SERVICE_HOST ?? '0.0.0.0';
  await app.listen(port, host);
  Logger.log(`gasless backend listening on http://${host}:${port}`, 'Bootstrap');
  Logger.log(`swagger at http://${host}:${port}/swagger`, 'Bootstrap');
}

bootstrap().catch((err) => {
  console.error('bootstrap failed', err);
  process.exit(1);
});
