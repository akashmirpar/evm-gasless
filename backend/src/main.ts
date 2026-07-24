import 'reflect-metadata';
// Stage the yaml+secret config path before anything RESOLVES config. `AppModule`
// is imported lazily (dynamic import in bootstrap below), and loadConfig() is
// itself lazy — invoked at NestFactory.create, not at import — so yamlReader()
// runs first. If a module on the import graph ever calls loadConfig() at
// top-level, this staging would be too late; keep config resolution lazy.
// The merged yaml+secret map (src/config) is the single source of truth.
import { parseConfigPath, yamlReader } from './config';
import { assertRequiredSecrets } from './config/required_secrets';

yamlReader(parseConfigPath());
assertRequiredSecrets();

import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

  const config = app.get(ConfigService);
  const port = Number(config.get<string>('SERVICE_PORT') ?? '3100');
  const host = config.get<string>('SERVICE_HOST') ?? '0.0.0.0';
  await app.listen(port, host);
  Logger.log(`gasless backend listening on http://${host}:${port}`, 'Bootstrap');
  Logger.log(`swagger at http://${host}:${port}/swagger`, 'Bootstrap');
}

bootstrap().catch((err) => {
  console.error('bootstrap failed', err);
  process.exit(1);
});
