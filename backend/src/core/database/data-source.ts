import 'reflect-metadata';
import { join } from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';

import { loadConfig } from '../../config';
import { SnakeNamingStrategy } from '../../common/utils/snake_naming.strategy';

function num(v: unknown, fallback: number): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.length > 0) {
    const parsed = Number(v);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}

function str(v: unknown, fallback: string): string {
  if (typeof v === 'string' && v.length > 0) return v;
  return fallback;
}

export function buildDataSourceOptions(): DataSourceOptions {
  // The TypeORM CLI (migration:*) runs outside Nest's DI container, so read the
  // merged config directly instead of via ConfigService.
  const config = loadConfig();
  const rootDir = __dirname;
  const baseDir = join(rootDir, '..', '..');
  return {
    type: 'postgres',
    host: str(config.DATABASE_POSTGRES_HOST, '127.0.0.1'),
    port: num(config.DATABASE_POSTGRES_PORT, 5432),
    username: str(config.DATABASE_POSTGRES_USERNAME, 'gasless'),
    password: str(config.DATABASE_POSTGRES_PASSWORD, 'gasless'),
    database: str(config.DATABASE_POSTGRES_DATABASE, 'gasless'),
    entities: [join(baseDir, '**', '*.entity.{ts,js}'), join(baseDir, '**', '*.view.{ts,js}')],
    migrations: [join(rootDir, 'migrations', '*.{ts,js}')],
    migrationsTableName: 'typeorm_migrations',
    migrationsRun: true,
    // Each migration is atomic in its own transaction rather than the whole
    // batch in one. This is what lets a migration opt out of the transaction
    // (`transaction = false`) for statements that must not hold a long lock —
    // e.g. VALIDATE CONSTRAINT, which only avoids blocking reads/writes when it
    // is NOT inside the ADD CONSTRAINT's transaction.
    migrationsTransactionMode: 'each',
    synchronize: false,
    namingStrategy: new SnakeNamingStrategy(),
    extra: {
      max: 25,
      min: 5,
      idleTimeoutMillis: 60_000,
      connectionTimeoutMillis: 30_000,
    },
  };
}

export const AppDataSource = new DataSource(buildDataSourceOptions());
